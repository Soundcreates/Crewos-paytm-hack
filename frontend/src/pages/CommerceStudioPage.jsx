import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Badge, Button, Empty, Heading, Panel } from '../components/ui.jsx';
import SupportTicketDemo from '../components/SupportTicketDemo.jsx';
import EventCollaborationPanel from '../components/EventCollaborationPanel.jsx';

const DEMO_STORE_DOMAIN = 'northstar-demo.myshopify.com';
const DEMO_PRODUCTS = [
  { id: 'demo-product-trail-pack', title: 'Northstar Everyday Pack', variants: [{ sku: 'NS-PACK-001', priceMinor: 6499, currency: 'USD' }] },
  { id: 'demo-product-trail-bottle', title: 'Insulated Trail Bottle', variants: [{ sku: 'NS-BOTTLE-001', priceMinor: 2499, currency: 'USD' }] },
  { id: 'demo-product-field-notes', title: 'Field Notes Set', variants: [{ sku: 'NS-NOTES-001', priceMinor: 1299, currency: 'USD' }] },
];

export function CommerceStudioPage({ data, refresh }) {
  const [connectionId, setConnectionId] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connections = data.connections || [];
  const liveConnections = data.liveConnections || [];
  const demoConnection = useMemo(() => connections.find(item => item.storeDomain === DEMO_STORE_DOMAIN) || null, [connections]);
  const selectedConnection = connections.find(item => item.id === connectionId) || demoConnection;

  useEffect(() => {
    if (!demoConnection?.id) return;
    setConnectionId(demoConnection.id);
    api(`/api/commerce/v2/shopify/connections/${encodeURIComponent(demoConnection.id)}/catalog`)
      .then(result => setCatalog(result.products || []))
      .catch(() => {});
  }, [demoConnection?.id]);

  async function loadCatalog(id = connectionId || demoConnection?.id) {
    if (!id) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/commerce/v2/shopify/connections/${encodeURIComponent(id)}/catalog`);
      setCatalog(result.products || []);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function createDemoStore() {
    setBusy(true); setError('');
    try {
      const connection = demoConnection || await api('/api/commerce/v2/shopify/simulation-connections', {
        method: 'POST', body: JSON.stringify({ storeDomain: DEMO_STORE_DOMAIN }),
      });
      await api(`/api/commerce/v2/shopify/connections/${encodeURIComponent(connection.id)}/catalog`, {
        method: 'POST',
        headers: { 'idempotency-key': 'northstar-demo-catalog-v1' },
        body: JSON.stringify({ products: DEMO_PRODUCTS }),
      });
      setConnectionId(connection.id);
      setCatalog(DEMO_PRODUCTS.map(product => ({ ...product, simulated: true, environment: 'simulation' })));
      await refresh?.();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function connectLiveStore() {
    const storeDomain = window.prompt('Shopify store domain (example: your-store.myshopify.com)');
    if (!storeDomain) return;
    setBusy(true); setError('');
    try {
      const started = await api('/api/commerce/v2/shopify/connections/connect', {
        method: 'POST', body: JSON.stringify({ storeDomain, environment: 'staging' }),
      });
      window.location.assign(started.authorizationUrl);
    } catch (failure) { setError(failure.message); setBusy(false); }
  }

  return <>
    <Heading title="Commerce Studio" subtitle="A ready-to-use local Shopify demo and a client ticket flow that shows employees answering alone or together." />
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!data.status?.enabled ? <Panel title="Setup required"><Badge value="disabled"/><p>{data.status?.message || 'Organization Engine V2 is disabled for this workspace.'}</p><p>Enable V2 for this organization, then restart the backend.</p></Panel> : <>
      <Panel title="Northstar demo Shopify store" subtitle="Hardcoded local store and sample catalog. This does not create or change a real Shopify store." action={<Button kind="btn-primary" disabled={busy} onClick={createDemoStore}>{busy ? 'Preparing demo…' : demoConnection ? 'Reset demo catalog' : 'Create demo store'}</Button>}>
        {demoConnection ? <div className="readiness"><div><b>{DEMO_STORE_DOMAIN}</b><p>Connected · Simulation only · no Shopify API calls</p></div><Badge value="simulated"/></div> : <Empty title="Demo store not created yet">Click “Create demo store” to create the local store and load its sample catalog.</Empty>}
        {demoConnection && <div className="section-actions"><Button disabled={busy} onClick={() => loadCatalog(demoConnection.id)}>Refresh catalog</Button></div>}
        {catalog.length > 0 && <div className="demo-product-grid">{catalog.map(product => <article className="demo-product-card" key={product.id}><b>{product.title}</b><span>{product.variants?.map(variant => `${variant.sku} · ${(variant.priceMinor / 100).toLocaleString('en-US',{style:'currency',currency:variant.currency})}`).join(' / ')}</span><small>Local fixture product</small></article>)}</div>}
        <style>{`.demo-product-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:18px}.demo-product-card{display:grid;gap:8px;padding:15px;border:1px solid var(--border);border-radius:11px;background:var(--surface)}.demo-product-card span,.demo-product-card small{color:var(--text-muted);font-size:13px}`}</style>
      </Panel>

      <SupportTicketDemo />

      <details className="commerce-advanced"><summary>Advanced integration setup</summary>
        <Panel title="Live Shopify connection" subtitle="Not needed for this demo. Live catalog writes and publishing remain disabled.">
          {data.status?.providers?.shopify?.oauth === 'available' ? <Button disabled={busy} onClick={connectLiveStore}>Connect a real Shopify store</Button> : <p>Live OAuth setup requires the Shopify app credentials, callback URL, API version, and APP_MASTER_KEY.</p>}
          {liveConnections.length ? <ul>{liveConnections.map(item => <li key={item.id}>{item.storeDomain} · {item.environment} · {item.readiness}</li>)}</ul> : <p>No live store is connected.</p>}
        </Panel>
        {selectedConnection && <Panel title="Paid-order event sandbox" subtitle="This is the lower-level webhook demo. The ticket form above is the quick client-facing event demo.">
          <EventCollaborationPanel connections={connections} employees={data.employees || []} manager />
        </Panel>}
      </details>
    </>}
  </>;
}
