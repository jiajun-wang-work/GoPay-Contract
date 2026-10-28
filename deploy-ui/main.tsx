import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import dictionaries from './dictionaries';
const names = { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', es: 'Español', de: 'Deutsch', fr: 'Français', ru: 'Русский', it: 'Italiano', pt: 'Português' };
type Language = keyof typeof dictionaries;
// {network} and {directory} come from the deployment service, so one page serves every network.
function useLanguage(vars: Record<string, string>) {
  const [language, setLanguage] = useState<Language>('en');
  const t = (k: keyof typeof dictionaries.en) => dictionaries[language][k].replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
  useEffect(() => { try { const l = localStorage.getItem('gopay:language'); if (l && l in dictionaries) setLanguage(l as Language); } catch {} }, []);
  useEffect(() => { document.documentElement.lang = language; document.title = t('deployTitle'); }, [language, vars.network]);
  return { language, t, setLanguage: (l: Language) => {
    setLanguage(l); try { localStorage.setItem('gopay:language', l); } catch {}
  } };
}
function App() {
  const [config, setConfig] = useState<any>(null);
  const { language, setLanguage, t } = useLanguage({ network: config?.networkLabel ?? 'Midnight', directory: config?.stateDir ?? '' });
  const [api, setApi] = useState<any>(null);
  const [status, setStatus] = useState<keyof typeof dictionaries.en>('deployIdle');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState('idle');
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [record, setRecord] = useState<any>(null);
  const request = async (path: string, body: unknown = {}) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gopay-deploy': config.csrf }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  };
  const reflect = (r: any) => { setRecord(r); if (r.status) setStatus(({ ready: 'deployPrepared', prepared: 'deployPrepared', submitted: 'deploySubmitted', confirmed: 'deployConfirmed' } as const)[r.status as 'prepared'] || 'deployIdle'); };
  useEffect(() => { fetch('/config').then(r => r.json()).then(c => { setConfig(c); setForm(f => ({ ...f, sourceChain: `midnight-${c.network}` })); if (c.contractAddress) reflect(c); }).catch(() => setFailed(true)); }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setFailed(false); setDiagnostic(null); try { await action(); } catch (e) { setFailed(true); const code = e instanceof Error ? e.message : ''; setDiagnostic(/^[A-Z_]+$/.test(code) ? code : 'WALLET_ERROR'); } finally { setBusy(false); } };
  const connect = () => run(async () => {
    setStage('connect');
    let connector = (globalThis as any).midnight?.['1am'];
    for (let attempt = 0; !connector && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      connector = (globalThis as any).midnight?.['1am'];
    }
    if (!connector) { setStatus('deployMissingWallet'); return; }
    const wallet = await connector.connect(config.network);
    const connection = await wallet.getConnectionStatus();
    if (connection.status !== 'connected' || connection.networkId !== config.network) throw new Error('WRONG_NETWORK');
    setApi(wallet); if (!record) setStatus('deployConnected');
  });
  const prepare = () => run(async () => {
    setStage('read_wallet_keys');
    const keys = await api.getShieldedAddresses();
    const address = await api.getUnshieldedAddress();
    setStage('prepare_transaction');
    reflect(await request('/prepare', { networkId: config.network, coinPublicKey: keys.shieldedCoinPublicKey,
      encryptionPublicKey: keys.shieldedEncryptionPublicKey, walletAddress: address.unshieldedAddress }));
  });
  const submit = () => run(async () => {
    const connection = await api.getConnectionStatus();
    if (connection.status !== 'connected' || connection.networkId !== config.network) throw new Error('WRONG_NETWORK');
    setStage('balance_transaction');
    const balanced = await api.balanceUnsealedTransaction(record.tx);
    if (!balanced?.tx) throw new Error('BALANCE_FAILED');
    // Persist the uncertain-submission state before handing the transaction to the wallet.
    await request('/submitting', { contractAddress: record.contractAddress, tx: balanced.tx });
    setRecord({ ...record, status: 'submitted' });
    setStatus('deploySubmitted');
    setStage('submit_transaction');
    const result = await api.submitTransaction(balanced.tx);
    const txId = typeof result === 'string' ? result : result?.transactionId ?? result?.id ?? null;
    reflect(await request('/submitted', { contractAddress: record.contractAddress, txId }));
  });
  const verify = () => run(async () => reflect(await request('/status')));
  const [assets, setAssets] = useState<any[]>([]);
  const [assetNote, setAssetNote] = useState<keyof typeof dictionaries.en | null>(null);
  const [form, setForm] = useState({ sourceChain: '', sourceToken: '', issuerOrBridge: 'gopay', assetVersion: '1', representation: 'unshieldedReserve',
    adapterId: '', reserveColor: '', decimals: '6', depositCap: '0' });
  const [ops, setOps] = useState<Record<string, { depositEnabled: boolean; swapEnabled: boolean; withdrawEnabled: boolean; depositCap: string }>>({});
  const confirmed = record?.status === 'confirmed';
  const refreshAssets = () => run(async () => {
    const { assets: list } = await request('/asset/list');
    setAssets(list);
    setOps(Object.fromEntries(list.map((a: any) => [a.assetId, { depositEnabled: a.depositEnabled, swapEnabled: a.swapEnabled, withdrawEnabled: a.withdrawEnabled, depositCap: a.depositCap }])));
  });
  // Server builds and proves the admin call; the wallet balances and submits it.
  const authorizeAsset = (action: string, params: unknown) => run(async () => {
    setAssetNote(null);
    setStage('read_wallet_keys');
    const keys = await api.getShieldedAddresses();
    setStage('prepare_transaction');
    const prepared = await request('/asset/prepare', { action, params, coinPublicKey: keys.shieldedCoinPublicKey, encryptionPublicKey: keys.shieldedEncryptionPublicKey });
    const connection = await api.getConnectionStatus();
    if (connection.status !== 'connected' || connection.networkId !== config.network) throw new Error('WRONG_NETWORK');
    setStage('balance_transaction');
    const balanced = await api.balanceUnsealedTransaction(prepared.tx);
    if (!balanced?.tx) throw new Error('BALANCE_FAILED');
    setStage('submit_transaction');
    await api.submitTransaction(balanced.tx);
    setAssetNote('assetSubmitted');
  });
  const field = (key: keyof typeof form, label: keyof typeof dictionaries.en) => <label style={{ display: 'block', margin: '6px 0' }}>{t(label)}<br />
    <input value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} style={{ font: 'inherit', padding: 8, width: '100%', boxSizing: 'border-box' }} /></label>;
  return <main>
    <style>{`body{font-family:system-ui;background:#f6f7fb;color:#162238;margin:0}main{max-width:780px;margin:50px auto;padding:30px;background:white;border-radius:18px}button,select{font:inherit;padding:12px;margin:5px;border-radius:8px;border:1px solid #bcc8d8;background:white}button:not(:disabled){cursor:pointer;background:#183d7b;color:white}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3f7;padding:18px;border-radius:10px}p{line-height:1.6}h1{font-size:25px}`}</style>
    <select aria-label={t('language')} value={language} onChange={e => setLanguage(e.target.value as Language)}>{Object.entries(names).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select>
    <h1>{t('deployTitle')}</h1><p>{t('deployHint')}</p>
    <p>{config?.networkLabel} · ledger 8 · Compact 0.31.1 · 29</p>
    <p role="status">{busy ? t('deployBusy') : t(status)}</p>
    {failed && <><p role="alert">{t('deployFailed')}</p><pre>{JSON.stringify({ stage, errorCode: diagnostic }, null, 2)}</pre></>}
    <button onClick={connect} disabled={busy || !config || !!api}>{t('deployConnect')}</button>
    <button onClick={prepare} disabled={busy || !api || (!!record && record.status !== 'ready')}>{t('deployPrepare')}</button>
    <button onClick={submit} disabled={busy || !api || record?.status !== 'prepared' || !record?.tx}>{t('deploySubmit')}</button>
    <button onClick={verify} disabled={busy || !record}>{t('deployVerify')}</button>
    {config && <pre>{JSON.stringify({ network: config.network, ledgerVersion: 8, adminCommitment: config.adminCommitment, treasuryOwnerPk: config.treasuryOwnerPk, governanceDelaySeconds: config.delaySeconds,
      contractAddress: record?.contractAddress, txId: record?.txId, transactionBytes: record?.transactionBytes, installedCircuits: record?.installedCircuits, totalCircuits: record?.totalCircuits, batchCircuits: record?.batchCircuits }, null, 2)}</pre>}
    <p>{t('deployBackup')}</p>
    {confirmed && <section aria-labelledby="asset-title">
      <h2 id="asset-title">{t('assetTitle')}</h2><p>{t('assetHint')}</p>
      {field('sourceChain', 'assetSourceChain')}{field('sourceToken', 'assetSourceToken')}{field('issuerOrBridge', 'assetIssuer')}{field('assetVersion', 'assetVersion')}
      <label style={{ display: 'block', margin: '6px 0' }}>{t('assetRepresentation')}<br />
        <select value={form.representation} onChange={e => setForm({ ...form, representation: e.target.value })}>
          <option value="unshieldedReserve">{t('assetReserve')}</option><option value="bridgeAdapter">{t('assetBridge')}</option></select></label>
      {field('adapterId', 'assetAdapterId')}{field('reserveColor', 'assetReserveColor')}{field('decimals', 'assetDecimals')}{field('depositCap', 'assetDepositCap')}
      <button onClick={() => authorizeAsset('registerAsset', form)} disabled={busy || !api}>{t('assetRegister')}</button>
      <button onClick={refreshAssets} disabled={busy}>{t('assetRefresh')}</button>
      {assetNote && <p role="status">{t(assetNote)}</p>}
      {!assets.length && <p>{t('assetNone')}</p>}
      {assets.map(a => { const o = ops[a.assetId]; if (!o) return null; return <fieldset key={a.assetId} style={{ margin: '12px 0' }}>
        <legend>{a.sourceToken} · {a.sourceChain}</legend>
        <pre>{JSON.stringify({ assetId: a.assetId, representation: a.representation, reserveColor: a.reserveColor, decimals: a.decimals, swapSlot: a.swapSlot }, null, 2)}</pre>
        {(['depositEnabled', 'swapEnabled', 'withdrawEnabled'] as const).map(k => <label key={k} style={{ marginRight: 14 }}>
          <input type="checkbox" checked={o[k]} onChange={e => setOps({ ...ops, [a.assetId]: { ...o, [k]: e.target.checked } })} /> {t(({ depositEnabled: 'assetEnableDeposit', swapEnabled: 'assetEnableSwap', withdrawEnabled: 'assetEnableWithdraw' } as const)[k])}</label>)}
        <label style={{ display: 'block', margin: '6px 0' }}>{t('assetDepositCap')}<br />
          <input value={o.depositCap} onChange={e => setOps({ ...ops, [a.assetId]: { ...o, depositCap: e.target.value } })} style={{ font: 'inherit', padding: 8, width: '100%', boxSizing: 'border-box' }} /></label>
        <button onClick={() => authorizeAsset('setAssetOperations', { assetId: a.assetId, ...o })} disabled={busy || !api}>{t('assetApply')}</button>
      </fieldset>; })}
    </section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
