# GoPay 合约实现说明

对应设计文档：[README.CN.md](README.CN.md) v0.5
合约源码：[src/gopay.compact](src/gopay.compact)
状态：原型实现。已通过编译（含完整 ZK 编译）和本地模拟器测试，**未经独立安全审计，不可用于真实资产**。

## 1. 工具链版本

| 组件 | 版本 |
|---|---|
| Compact 编译器 | 0.31.1（语言版本 0.23，ledger 8） |
| `@midnight-ntwrk/compact-runtime` | 0.16.0 |
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

[test/gopay.test.ts](test/gopay.test.ts) 原有 37 个用例（新增覆盖见第 8 节），在本地模拟器（[test/simulator.ts](test/simulator.ts)）中实际执行电路，对应 README 第 11 节：

- 注册与治理：资产 ID 派生、同名不同版本分开注册、非管理员被拒、延迟生效的轮换、不覆盖待生效更新
- Vault：存入额度、开关、双花、越权花费、篡改 Note、零金额转账、复用随机数付款、合并、提现与找零
- 兑换：1,000 USDC 示例（用户到账 149,250 JPYC，做市商收到 995 USDC，金库收到并提走 5 USDC）、手续费向上取整、零本金、伪造费用、非指定做市商、库存不足、重复成交、成交与撤单互斥、防 nonce 抢注、过期、篡改收款人、过期金库配置、资产停用、暂停、单位元临时密钥
- 桥接：入账防重放、错误资产/合约/版本/来源链、赎回的完成与退款、停用适配器后仍可处理赎回、适配器密钥轮换、桥接资产无需修改核心即可兑换

模拟器只执行电路逻辑，不生成证明，也不模拟 guaranteed/fallible 分段和真实钱包的交易平衡。README 7.3 要求的失败回滚行为，需要在 devnet 上另行验证。

## 8. Swap / Pool / Position / Payment 补全

### AMM 与 Position

- `createPool(a,b)` 创建公开储备的恒定乘积池，反向币对不能重复创建；所有操作明确检查池存在。
- `addLiquidity` 首次铸造 `floor(sqrt(amountA × amountB))` 份额；后续存入必须精确匹配储备比例，份额为 `floor(amountA × shares / reserveA)`。不匹配比例直接拒绝，避免用户无意捐赠多余资产。
- Position 是 `assetId = lpAssetOf(poolId)` 的私密 LP Note。沿用 Note 所有权、转账、合并与 nullifier 防双花；不增加暴露持有者的公开 position 表。钱包需保存 Note 明文与随机数，不能仅从公开池状态还原个人头寸。
- `swapExactIn` 使用 `floor(amountIn × 9970 × reserveOut / (reserveIn × 10000 + amountIn × 9970))`，30 bps 全部留在池中归 LP；**独立于 RFQ 的 50 bps 平台费**。当前网页费率描述仍对应 RFQ，接入 AMM 前必须按路线显示真实费用。
- `removeLiquidity` 按份额向下取整返回两种资产；最后一位 LP 可取回全部储备。暂停交易或停用资产仍允许撤出；转账暂停仍限制 LP Note 的普通转账。
- 加池、兑换、撤出均有 deadline 和最小输出保护。金额、储备和份额上限为 `Uint<64>`，中间乘法使用更宽整数并由电路校验商值；越界拒绝，不截断。
- [src/amm.ts](src/amm.ts) 提供完全使用 bigint 的报价与 LP 份额计算。调用方必须按**每种资产自己的 decimals** 转成最小单位，不能直接使用网页通用的 8 位显示单位。
- 当前只支持全范围恒定乘积 Position。网页的自定义价格范围尚不能由此合约结算；集中流动性需要 tick、跨 tick swap 与独立的手续费增长记账，不能把范围输入直接传给本接口。

### Payment

新增 `payments`、`PaymentStatus` 及四个电路：

| 电路 | 行为 |
|---|---|
| `createPayment` | 商户证明拥有 merchantPk，创建固定资产、金额、到期时间订单；ID 绑定合约、商户和 nonce，禁止覆盖 |
| `cancelPayment` | 仅商户取消未付款订单；暂停时仍可取消 |
| `payPayment` | 到期前以一个同资产 Note 支付精确订单金额，生成商户 Note 与付款人找零，原子标记 paid，禁止重复支付 |
| `refundPayment` | 仅商户用自己的同资产 Note 退款，支持多次部分退款；累计不超过实付额，全额退完标记 refunded；暂停时仍允许退款 |

状态为 `open → cancelled` 或 `open → paid → refunded`。过期根据 `expiresAt` 派生，不需要 keeper 改写状态，付款要求严格早于到期时间。部分退款保留 paid，以 `refundedAmount` 表示进度。与现有 Payment 服务中的 late/review 等状态并非一一对应：本路径拒绝逾期付款；普通外部转账仍可能迟到，由服务独立处理。

付款人的退款接收键存为 `paymentRefundFor(contract, paymentId, payerPk, refundNonce)` 盲化承诺，不在订单表公开付款人公钥。退款时电路验证承诺，商户不能改成其他收款人。订单 ID、商户公钥、资产、金额、到期时间、状态、累计退款及商户收款 Note 承诺公开，因此此模块不提供隐藏订单金额的承诺。

客户端必须安全保存并私下交付 `merchantNonce`、`payerPk`、`refundNonce`；商户恢复收款 Note 和后续退款依赖这些数据。每个输出 Note 都必须使用新随机数。付款与退款均无额外协议费；退款是商户主动出资操作，并非托管仲裁或强制退款。

### RFQ 与接入边界

`createOrder` 现在立即拒绝已过期订单和失效金库配置，避免先锁钱再在成交时失败；`fillOrder` 保留相同检查，覆盖下单后配置轮换情形。撤单仍可用。

现有 GoPay-Webapp 流动性表单尚未提交链上交易；GoPay-Payment 仍索引 wallet-to-wallet unshielded 转账。此次仅完善合约与钱包计算辅助，**没有切换线上服务、接入钱包或部署合约**。Note 支付与普通钱包转账不能混为同一种结算凭证。新增 ledger 和接口需要新部署及明确迁移，不能直接替换已部署地址上的旧 ABI。

验证包括本地电路执行与完整 ZK 编译。模拟器不验证真实资产输入平衡、网络并发提交、真实证明验证及 guaranteed/fallible 阶段回滚，部署前仍需 devnet 集成验证。

本次验证（2026-10-11）：`npm run compact`、`npm run compact:zk`（29 个电路，58 个非空 prover/verifier 文件）、`npm run typecheck`、`npm test`（3 个测试文件，50 项全部通过）、`git diff --check` 均通过。新增覆盖双向 AMM、比例/初始份额校验、LP 越权和重复销毁、暂停退出、完整清池后重建、支付幂等、取消权限、到期、错误资产、部分/全额退款与错误收款人，以及部署钱包密钥的网络和类型校验。


## 9. Preprod / ledger 8 部署（1AM）

公共网络的兼容组合固定为 Compact 0.31.1、runtime 0.16.0、Midnight.js 4.1.1、proof-server 8.1.3。编译脚本显式指定 `+0.31.1`，避免机器默认编译器切回 ledger 9。合约语言声明改为 0.23，ECDH 临时标量使用该版本标准库接受的 `Field`；模拟器适配 ledger 8 的 context API。重新编译后 47 项测试通过。

```bash
npm ci
npm run compact:zk
npm run typecheck
npm test
# 本地证明服务独立使用 6301，不影响现有的 6300 服务：
docker run -d --name gopay-preprod-proof-server-8-1-3 \
  -p 127.0.0.1:6301:6300 midnightntwrk/proof-server:8.1.3
npm run check:deploy       # 构建并证明，不平衡、不提交
npm run typecheck:deploy
npm run deploy:preprod
```

打开 `http://127.0.0.1:4318`，使用 **1AM** 连接 Preprod，依次准备部署、核对合约地址、在钱包中授权并提交，然后检查链上状态。部署页复用 Webapp 的全部 11 种语言中央字典；默认英语，保存语言偏好。

工具绑定 loopback，仅允许同源且带临时 CSRF 令牌的写请求。默认从 `../GoPay-Payment/.env` 读取 `PAYMENT_BLOCKFROST_PROJECT_ID`；可通过 `GOPAY_DEPLOY_ENV_FILE` 指向其他本地配置，或设置服务端 `GOPAY_BLOCKFROST_PROJECT_ID`。令牌不会送入浏览器 bundle 或显示在日志中。节点/Indexer 使用 Preprod Blockfrost，证明仅在本机进行。1AM 自身的交易平衡和提交仍使用钱包配置；钱包需要正确的 Preprod 配置与可用 DUST。

第一次启动会在 `.deployment/preprod-secrets.json` 生成独立的管理员、Note 所有者、金库所有者、金库查看及合约维护密钥；文件权限为 0600，目录为 0700，已被 Git 忽略。治理延迟默认 3600 秒。**这些文件不是钱包助记词，但仍是控制合约和金库的秘密，必须安全备份；本地文件没有额外密码加密。** 工具不导出、不读取 1AM 助记词。

待提交交易与地址保存于 `.deployment/preprod-deployment.json`。钱包提交前先记为待确认；提交结果不明确时只检查状态，不自动重新部署。Indexer 检索到地址后，会比对管理员承诺、金库所有者与治理延迟，匹配后才标为 confirmed。没有链上确认之前，预检或 prepared/submitted 状态都不能视为部署成功。确认后还需要注册资产、启用操作并初始化池；此工具不会自动执行这些管理操作。

部署预检：ledger 8 初始合约状态 64,035 字节，已证明但未平衡的交易 64,256 字节。钱包平衡将增加费用相关数据，网络最终接纳情况仍以实际提交和链上确认为准。原先 ledger 9 产物的验证记录仅为历史，不代表可部署到 Preprod。

参考：[官方兼容矩阵](https://docs.midnight.network/relnotes/support-matrix)、[网络端点](https://docs.midnight.network/relnotes/network)。

### 9.1 分批部署验证密钥

29 个电路一次性部署虽然可以编译和生成证明，但 ledger 8 的费用计算会返回 `exceeded block limit in transaction fee computation`。部署工具改为每批最多 5 个验证密钥，共 6 笔交易：第一笔创建合约及 5 个电路，后续通过维护权限安装剩余电路。每笔提交前检查最新链上 ledger 参数的费用限制。

每次授权提交后点击“检查链上状态”；当前批次确认后，点击“准备部署”生成下一批，再授权提交。进度见原始 JSON 的 `installedCircuits` / `totalCircuits`。只有全部 29 个验证密钥与本地编译产物一致，且管理员、金库、治理延迟匹配时，才标记为完成；部署途中不要对外启用合约。

旧的一次性部署仅在本地状态为 prepared 且链上查不到旧地址时迁移；原记录备份为 `.deployment/preprod-deployment-before-phased.json`，管理员及金库秘密不变，合约地址重新生成。已提交的记录不会自动替换。`npm run check:deploy` 在本地生成并验证全部 6 笔交易的费用，不进行提交。
