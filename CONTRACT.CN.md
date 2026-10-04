# GoPay 合约实现说明

对应设计文档：[README.CN.md](README.CN.md) v0.5
合约源码：[src/gopay.compact](src/gopay.compact)
状态：原型实现。已通过编译（含完整 ZK 编译）和本地模拟器测试，**未经独立安全审计，不可用于真实资产**。

## 1. 工具链版本

| 组件 | 版本 |
|---|---|
| Compact 编译器 | 0.34.0（语言版本 0.26） |
| `@midnight-ntwrk/compact-runtime` | 0.19.0 |
| Node.js | 24.x |

```bash
npm install
npm run compact      # --skip-zk 快速编译，生成 src/managed/gopay
npm run compact:zk   # 完整编译并生成证明密钥（约 2 分钟）
npm run typecheck
npm test
```

## 2. 路线选择

README 4.1 允许两种路线：原生 shielded token，或 Vault 内部 Note。本实现采用**内部 Note 凭证**，Vault 记账、兑换结算和金库费用入账都放在同一个核心合约中。原因如下：

- Compact 中一次电路调用只由一方证明。RFQ 需要用户和做市商双方授权，因此拆成两步：`createOrder` 由用户证明，`fillOrder` 由做市商证明。用户的输入先锁进隐藏的订单承诺，做市商成交时，同一次调用原子完成全部资金变化。
- 原生 shielded token 的双方交易组合能力，需在阶段一（README 12）用选定的网络和钱包实测。本合约的兑换核心只依赖 `assetId`，以后可以为原生 shielded 资产增加 `Representation`，不需要修改兑换逻辑。

## 3. README 模块与合约对应

| README 模块 | 合约实现 |
|---|---|
| AssetRegistry | `assets` 表、`registerAsset`、`setAssetOperations`；`assetId = assetIdOf(sourceChain, sourceToken, issuerOrBridge, assetVersion)` |
| AdapterRegistry | `adapters` 表、`registerAdapter`、`setAdapterEnabled`、`scheduleAdapterRotation` |
| ShieldedAssetFactory | 多资产合约方案：资产与适配器、储备代币类型的绑定在注册时固定，变更须注册新的 `assetVersion` |
| GoPayVault | `depositUnshielded` / `withdrawUnshielded`（由 unshielded 储备 1:1 支撑）；`adapterMint` / `requestRedemption` / `completeRedemption` / `refundRedemption`（桥接资产） |
| 私密余额 | `noteCommitments`（HistoricMerkleTree，深度 32）+ `spentNullifiers`；`transfer`（1 进 2 出）、`merge`（2 进 1 出） |
| PrivateSwap | `createOrder` → `fillOrder` / `cancelOrder`，订单 nullifier 保证成交与撤单互斥 |
| PlatformTreasury | 在 `fillOrder` 内强制生成 50 bps 手续费 Note，并附链上加密收据 `feeReceipts` |
| Governance | 管理员秘密承诺、`setPaused` 分操作暂停；管理员、金库和适配器密钥轮换都要经过 `governanceDelay` 延迟 |

## 4. 关键设计

### 4.1 Note

```text
commitment = persistentCommit([domain, contractAddress, protocolVersion, assetId, amount, ownerPk], nonce)
nullifier  = persistentHash([domain', contractAddress, ownerSecret, commitment])
ownerPk    = persistentHash([domain'', ownerSecret])
```

- 承诺绑定合约地址和协议版本，防止跨合约、跨版本重放。
- nullifier 绑定整个承诺。别人复用你的 Note 随机数向你付款，也不会让你已有的 Note 失效。
- 钱包用导出的 pure circuit `noteCommitmentFor` / `noteNullifierFor` 在链下计算承诺，再用 `noteCommitments.findPathForLeaf` 获取 Merkle 路径。

### 4.2 RFQ 兑换与 50 bps 手续费

1. 用户接受做市商报价，构造 `Order`，其中包含 `makerPk`、`recipientPk`、`recipientNonce`、`expiry`、`quoteId` 和 `treasuryConfigVersion`，然后调用 `createOrder`：花费输入 Note，锁定 `inputAmount`，余额作为找零返回。
2. 用户把订单明文私下发给该做市商。做市商调用 `fillOrder`，电路验证：
   - 调用方就是 `order.makerPk`，订单承诺在树中，订单 nullifier 未使用；
   - `blockTimeLt(expiry)`，且 `treasuryConfigVersion` 与当前一致；
   - 两种资产都在可交易集合 `swapAssets` 中，用私密成员证明，不公开币种；
   - `fee = ceil(inputAmount × 50 / 10000)`：电路校验 `fee×10000 ≥ inputAmount×50` 且 `fee×10000 < inputAmount×50 + 10000`，不信任调用方自报的数值；
   - 逐资产守恒：`inputAmount = principal + fee`，`makerInput = netOutput + makerChange`。
3. 同一次调用中生成四个 Note：收款人的 `netOutputAmount`、做市商找零、做市商收到的 `principal`，以及金库的 `fee`。

撤单 `cancelOrder` 与成交共用订单 nullifier：`H(domain, contract, orderCommitment, orderNonce)`。它绑定订单承诺，所以即使别人知道 `orderNonce`，也无法抢先消费这个标记。撤单不受暂停影响。

### 4.3 金库加密收据

金库是被动收款方，无法从链上得知手续费 Note 的数量。`fillOrder` 在电路内做 Jubjub ECDH：

```text
R = r·G                                   （公开，存入 FeeReceipt）
S = r·treasuryViewKey = tsk·R
[feeNonce, mask] = feeReceiptSecrets(orderNullifier, S)
encryptedAmount = fee + mask   （Field 上的一次性掩码）
```

金库用查看私钥 `tsk` 调用 `decryptFeeReceipt`（[src/fees.ts](src/fees.ts)），恢复数量和随机数，之后可以像普通 Note 一样花费（测试中通过 `withdrawUnshielded` 提走）。加密在电路内强制完成，做市商无法生成金库恢复不了的费用 Note。

### 4.4 隐藏币种

`fillOrder` 不按 `assetId` 查询公开 Map，而是对 `swapAssets`（MerkleTree，深度 8，最多 256 个资产）做成员证明。关闭某资产的兑换，就把它所在的槽位重置为默认值。存入、提现和赎回本身公开，所以这些操作直接查询公开的 `assets` 表。

## 5. 公开交易数据中仍可见的信息

| 操作 | 公开内容 |
|---|---|
| 所有花费 | nullifier、历史 Merkle 根（可粗略推断 Note 的“年龄”）、电路名称 |
| `depositUnshielded` / `withdrawUnshielded` | 资产、数量、提现收款地址 |
| `adapterMint` / `requestRedemption` | 完整的入账凭证、赎回数量和目标承诺 |
| `fillOrder` | 订单 nullifier、**订单到期时间**、费用收据（密文）、资产树根 |
| 治理 | 所有配置内容 |

资产、数量、收款人以及用户与做市商之间的关联，在 `transfer`、`merge`、`createOrder`、`fillOrder`、`cancelOrder` 中都不公开。

## 6. 信任边界与已知限制

- **做市商**知道订单全部明文，但没有 `ownerSecret`，无法花费用户的 Note，也无法计算其 nullifier。
- **金库**能解密每笔手续费，从而推算用户的输入数量（精度约 200 个最小单位）；逐个尝试资产 ID 也能得知输入币种。隐私承诺只针对公众。
- **适配器**是桥接资产储备真实性的信任点。ZK 不能证明外部储备真实存在。
- **管理员**是单一秘密承诺。生产环境应由 MPC 或门限方案持有，或改为链上 k-of-n。资产和适配器的注册、启停以及暂停都立即生效，只有密钥轮换有延迟。被盗的管理员密钥无法挪用储备，但可以冻结操作，或注册一个未经储备支撑的新 `assetVersion`。
- **暂停**没有最长期限。
- 用户在到期前可随时撤单，相当于对做市商持有一个免费期权。应通过较短的 `expiry` 控制。
- Note 树深度 32（约 43 亿叶子），且拒绝零金额转账。提现、撤单等操作仍总会创建 Note（零找零也会创建，以避免泄露金额），因此长期运行仍需规划迁移。
- `swapAssets` 只接受当前根。资产配置变化会让正在进行中的 `fillOrder` 证明失效，需要重新生成。
- 转账形状只有两种（1→2 和 2→1），电路名称会暴露属于哪一种。
- 未实现：原生 shielded token 的表示方式、部分成交、批量结算、多跳兑换。

## 7. 测试覆盖

[test/gopay.test.ts](test/gopay.test.ts) 共 37 个用例，在本地模拟器（[test/simulator.ts](test/simulator.ts)）中实际执行电路，对应 README 第 11 节：

- 注册与治理：资产 ID 派生、同名不同版本分开注册、非管理员被拒、延迟生效的轮换、不覆盖待生效更新
- Vault：存入额度、开关、双花、越权花费、篡改 Note、零金额转账、复用随机数付款、合并、提现与找零
- 兑换：1,000 USDC 示例（用户到账 149,250 JPYC，做市商收到 995 USDC，金库收到并提走 5 USDC）、手续费向上取整、零本金、伪造费用、非指定做市商、库存不足、重复成交、成交与撤单互斥、防 nonce 抢注、过期、篡改收款人、过期金库配置、资产停用、暂停、单位元临时密钥
- 桥接：入账防重放、错误资产/合约/版本/来源链、赎回的完成与退款、停用适配器后仍可处理赎回、适配器密钥轮换、桥接资产无需修改核心即可兑换

模拟器只执行电路逻辑，不生成证明，也不模拟 guaranteed/fallible 分段和真实钱包的交易平衡。README 7.3 要求的失败回滚行为，需要在 devnet 上另行验证。
