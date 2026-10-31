import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from './ui.jsx';

export default function ShopifyLiveConnection({ voiceSessionId = null, storeName = '', category = 'clothing' }) {
  const [domain, setDomain] = useState('');
  const [connections, setConnections] = useState([]);
  const [products, setProducts] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [shopifyStatus, setShopifyStatus] = useState(null);
  const [devStore, setDevStore] = useState(null);
  const [devTheme, setDevTheme] = useState(null);
  const [devName, setDevName] = useState(storeName);
  const [autoStarting, setAutoStarting] = useState(Boolean(voiceSessionId));
  const themeStarted = useRef(false);
  const storeStarted = useRef(false);
  const refresh = useCallback(async () => {
    try { const [saved, status] = await Promise.all([api('/api/commerce/v2/shopify/connections'), api('/api/commerce/v2/status')]); setConnections(saved); setShopifyStatus(status.providers?.shopify || null); }
    catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => { setDevName(storeName); }, [storeName]);
  const refreshDevStore = useCallback(async () => {
    if (!voiceSessionId) return;
    try {
      const result = await api(`/api/commerce/v2/shopify/dev-stores?voiceSessionId=${encodeURIComponent(voiceSessionId)}`);
      setDevStore(result.store);
      if (result.store?.storeDomain) setDomain(result.store.storeDomain);
      return result.store;
    } catch (failure) { setError(failure.message); throw failure; }
  }, [voiceSessionId]);
  useEffect(() => {
    if (!voiceSessionId || !storeName.trim() || storeStarted.current) return;
    storeStarted.current = true;
    void (async () => {
      try {
        const existing = await refreshDevStore();
        if (!existing) {
          const result = await api('/api/commerce/v2/shopify/dev-stores', { method: 'POST', body: JSON.stringify({ voiceSessionId, name: storeName.trim() }) });
          setDevStore(result.store);
          if (result.store?.storeDomain) setDomain(result.store.storeDomain);
        }
      } catch (failure) { setError(failure.message); }
      finally { setAutoStarting(false); }
    })();
  }, [voiceSessionId, storeName, refreshDevStore]);
  useEffect(() => {
    if (devStore?.status !== 'creating') return undefined;
    const timer = window.setInterval(() => { void refreshDevStore().catch(() => {}); }, 3000);
    return () => window.clearInterval(timer);
  }, [devStore?.status, refreshDevStore]);
  const refreshDevTheme = useCallback(async () => {
    if (!voiceSessionId) return null;
    const result = await api(`/api/commerce/v2/shopify/dev-store-theme?voiceSessionId=${encodeURIComponent(voiceSessionId)}`);
    setDevTheme(result.theme);
    return result.theme;
  }, [voiceSessionId]);
  useEffect(() => { themeStarted.current = false; setDevTheme(null); }, [voiceSessionId]);
  useEffect(() => {
    if (!voiceSessionId || devStore?.status !== 'ready' || themeStarted.current) return;
    themeStarted.current = true;
    void (async () => {
      try {
        const existing = await refreshDevTheme();
        if (!existing) {
          const result = await api('/api/commerce/v2/shopify/dev-store-theme', { method: 'POST', body: JSON.stringify({ voiceSessionId, category }) });
          setDevTheme(result.theme);
        }
      } catch (failure) { setError(failure.message); }
    })();
  }, [voiceSessionId, devStore?.status, category, refreshDevTheme]);
  useEffect(() => {
    if (devTheme?.status !== 'creating') return undefined;
    const timer = window.setInterval(() => { void refreshDevTheme().catch(failure => setError(failure.message)); }, 3000);
    return () => window.clearInterval(timer);
  }, [devTheme?.status, refreshDevTheme]);

  async function createDevStore() {
    if (!voiceSessionId) return;
    setBusy(true); setError('');
    try {
      const result = await api('/api/commerce/v2/shopify/dev-stores', { method: 'POST', body: JSON.stringify({ voiceSessionId, name: devName.trim() }) });
      setDevStore(result.store);
      if (result.store?.storeDomain) setDomain(result.store.storeDomain);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function connect(event) {
    event.preventDefault();
    const shop = domain.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shop)) { setError('Enter your store’s full myshopify.com domain.'); return; }
    if (!shopifyStatus || shopifyStatus.oauth !== 'available') { setError('Shopify authorization is unavailable. Check the backend app credentials and callback URL.'); return; }
    try {
      if (new URL(shopifyStatus.callbackUrl).origin !== window.location.origin) {
        setError(`Set the Shopify callback URL to ${window.location.origin}/api/commerce/v2/shopify/oauth/callback in your backend settings and Shopify app dashboard, then restart the backend.`); return;
      }
    } catch { setError('The Shopify callback URL is missing or invalid in the backend.'); return; }
    const popup = window.open('', 'crewos-shopify-connect', 'width=720,height=800');
    if (!popup) { setError('Allow pop-ups to connect your Shopify store.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('/api/commerce/v2/shopify/connections/connect', { method: 'POST', body: JSON.stringify({ storeDomain: shop, environment: 'production' }) });
      popup.location.assign(result.authorizationUrl);
      setNotice('Complete the Shopify authorization in the other window, then return here and refresh the connection.');
    } catch (failure) { popup.close(); setError(failure.message); }
    finally { setBusy(false); }
  }

  async function readCatalog(connection) {
    setBusy(true); setError('');
    try { const result = await api(`/api/commerce/v2/shopify/connections/${encodeURIComponent(connection.id)}/catalog`); setProducts(result.products || []); setNotice(result.pageInfo?.hasNextPage ? 'Showing the first catalog page.' : 'Catalog loaded from Shopify.'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <>
    {voiceSessionId && <section>
      <p className="field-hint">Create a separate Shopify development store for this interview.</p>
      {!devStore && autoStarting && <p role="status">Starting your development store setup…</p>}
      {!devStore && !autoStarting && <><label>Store name <input value={devName} onChange={event => setDevName(event.target.value)} maxLength={80} /></label>{' '}<Button type="button" disabled={busy || !devName.trim()} onClick={createDevStore}>Retry store setup</Button></>}
      {devStore?.status === 'creating' && <p role="status">Shopify is creating the development store…</p>}
      {devStore?.status === 'ready' && <p role="status">Development store created: <a href={devStore.storeUrl} target="_blank" rel="noreferrer">{devStore.storeDomain}</a>. Connect the app below to view its catalog.</p>}
      {devStore?.status === 'ready' && devTheme?.status === 'creating' && <p role="status">Preparing your storefront preview…</p>}
      {devTheme?.status === 'ready' && <p role="status">Your storefront preview is ready: <a href={devTheme.previewUrl} target="_blank" rel="noreferrer">Open Shopify preview</a>.</p>}
      {devTheme?.status === 'uncertain' && <p role="alert">Shopify did not confirm the storefront upload. Check the store’s Themes page before trying another upload.</p>}
      {devStore?.status === 'uncertain' && <p role="alert">Shopify did not confirm the result. Check your Shopify development-store list before attempting another creation.</p>}
    </section>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <details className="commerce-advanced">
    <summary>Connect your Shopify store</summary>
    <p className="field-hint">Connect an existing Shopify store to view its catalog. The store preview above is separate.</p>
    <form onSubmit={connect}>
      <label>Shopify store domain <input value={domain} onChange={event => setDomain(event.target.value)} placeholder="your-store.myshopify.com" autoComplete="off" /></label>{' '}
      <Button kind="btn-primary" type="submit" disabled={busy}>Connect Shopify</Button>{' '}
      <Button type="button" disabled={busy} onClick={refresh}>Refresh connection</Button>
    </form>
    {connections.filter(connection => !connection.simulated && connection.status !== 'revoked').map(connection => <div key={connection.id}>
      <p><strong>{connection.storeDomain}</strong> · {connection.readiness}</p>
      {connection.readiness === 'ready' && <Button type="button" disabled={busy} onClick={() => readCatalog(connection)}>View Shopify catalog</Button>}
    </div>)}
    {products.length > 0 && <ul>{products.map(product => <li key={product.id}>{product.title}{product.variants?.length ? ` — ${product.variants.map(variant => `${variant.sku || 'No SKU'}: ${variant.price}`).join(', ')}` : ''}</li>)}</ul>}
    </details>
  </>;
}
