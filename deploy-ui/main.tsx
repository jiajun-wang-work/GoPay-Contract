import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import dictionaries from './dictionaries';
const names = { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', es: 'Español', de: 'Deutsch', fr: 'Français', ru: 'Русский', it: 'Italiano', pt: 'Português' };
type Language = keyof typeof dictionaries;
function useLanguage() {
  const [language, setLanguage] = useState<Language>('en');
  useEffect(() => { try { const l = localStorage.getItem('gopay:language'); if (l && l in dictionaries) setLanguage(l as Language); } catch {} }, []);
  useEffect(() => { document.documentElement.lang = language; document.title = dictionaries[language].deployTitle; }, [language]);
  return { language, t: (k: keyof typeof dictionaries.en) => dictionaries[language][k], setLanguage: (l: Language) => {
    setLanguage(l); try { localStorage.setItem('gopay:language', l); } catch {}
  } };
}
function App() {
  const { language, setLanguage, t } = useLanguage();
  const [config, setConfig] = useState<any>(null);
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
  useEffect(() => { fetch('/config').then(r => r.json()).then(c => { setConfig(c); if (c.contractAddress) reflect(c); }).catch(() => setFailed(true)); }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setFailed(false); setDiagnostic(null); try { await action(); } catch (e) { setFailed(true); const code = e instanceof Error ? e.message : ''; setDiagnostic(/^[A-Z_]+$/.test(code) ? code : 'WALLET_ERROR'); } finally { setBusy(false); } };
  const connect = () => run(async () => {
    setStage('connect');
    let connector = (globalThis as any).midnight?.['1am'];
    for (let attempt = 0; !connector && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      connector = (globalThis as any).midnight?.['1am'];
    }
    if (!connector) { setStatus('deployMissingWallet'); return; }
    const wallet = await connector.connect('preprod');
    const connection = await wallet.getConnectionStatus();
    if (connection.status !== 'connected' || connection.networkId !== 'preprod') throw new Error('WRONG_NETWORK');
    setApi(wallet); if (!record) setStatus('deployConnected');
  });
  const prepare = () => run(async () => {
    setStage('read_wallet_keys');
    const keys = await api.getShieldedAddresses();
    const address = await api.getUnshieldedAddress();
    setStage('prepare_transaction');
    reflect(await request('/prepare', { networkId: 'preprod', coinPublicKey: keys.shieldedCoinPublicKey,
      encryptionPublicKey: keys.shieldedEncryptionPublicKey, walletAddress: address.unshieldedAddress }));
  });
  const submit = () => run(async () => {
    const connection = await api.getConnectionStatus();
    if (connection.status !== 'connected' || connection.networkId !== 'preprod') throw new Error('WRONG_NETWORK');
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
  return <main>
    <style>{`body{font-family:system-ui;background:#f6f7fb;color:#162238;margin:0}main{max-width:780px;margin:50px auto;padding:30px;background:white;border-radius:18px}button,select{font:inherit;padding:12px;margin:5px;border-radius:8px;border:1px solid #bcc8d8;background:white}button:not(:disabled){cursor:pointer;background:#183d7b;color:white}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3f7;padding:18px;border-radius:10px}p{line-height:1.6}h1{font-size:25px}`}</style>
    <select aria-label={t('language')} value={language} onChange={e => setLanguage(e.target.value as Language)}>{Object.entries(names).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select>
    <h1>{t('deployTitle')}</h1><p>{t('deployHint')}</p>
    <p>Midnight Preprod · ledger 8 · Compact 0.31.1 · 29</p>
    <p role="status">{busy ? t('deployBusy') : t(status)}</p>
    {failed && <><p role="alert">{t('deployFailed')}</p><pre>{JSON.stringify({ stage, errorCode: diagnostic }, null, 2)}</pre></>}
    <button onClick={connect} disabled={busy || !config || !!api}>{t('deployConnect')}</button>
    <button onClick={prepare} disabled={busy || !api || (!!record && record.status !== 'ready')}>{t('deployPrepare')}</button>
    <button onClick={submit} disabled={busy || !api || record?.status !== 'prepared' || !record?.tx}>{t('deploySubmit')}</button>
    <button onClick={verify} disabled={busy || !record}>{t('deployVerify')}</button>
    {config && <pre>{JSON.stringify({ network: 'preprod', ledgerVersion: 8, adminCommitment: config.adminCommitment, treasuryOwnerPk: config.treasuryOwnerPk, governanceDelaySeconds: config.delaySeconds,
      contractAddress: record?.contractAddress, txId: record?.txId, transactionBytes: record?.transactionBytes, installedCircuits: record?.installedCircuits, totalCircuits: record?.totalCircuits, batchCircuits: record?.batchCircuits }, null, 2)}</pre>}
    <p>{t('deployBackup')}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
