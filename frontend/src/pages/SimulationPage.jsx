import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Heading, Panel } from '../components/ui.jsx';
import { DEMO_STORES } from '../lib/demo-store.js';

const employees = [
  { id: 'maya', name: 'Maya Chen', role: 'Sales agent', initials: 'MC', color: '#e8b66f', skills: 'WhatsApp sales · order lookups' },
  { id: 'avery', name: 'Avery Patel', role: 'Customer care', initials: 'AP', color: '#9bb7ff', skills: 'Returns · delivery · product issues' },
  { id: 'jordan', name: 'Jordan Lee', role: 'Operations', initials: 'JL', color: '#88cfb1', skills: 'Payments · incident review' },
];
const seedMessages = store => [
  { id: 'seed-1', from: 'customer', name: store.customer, text: `Hi! Is the ${store.products[0].name} available, and how much is it?` },
  { id: 'seed-2', from: 'agent', name: 'Maya · Sales', text: `Hi Taylor! Yes, the ${store.products[0].name} is available for ${store.products[0].price} at ${store.name}. Want me to help with anything else?` },
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function SimulationPage({ actions, storeType = 'clothing', restoreState = null }) {
  const [selectedStoreType, setSelectedStoreType] = useState(Object.hasOwn(DEMO_STORES, storeType) ? storeType : 'clothing');
  const store = DEMO_STORES[selectedStoreType];
  const [setupStage, setSetupStage] = useState(0);
  const [messages, setMessages] = useState(() => restoreState?.messages || seedMessages(store));
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [teamStatus, setTeamStatus] = useState(restoreState?.teamStatus || 'Ready for a customer message');
  const [teamNotes, setTeamNotes] = useState(restoreState?.teamNotes || []);
  const [mode, setMode] = useState(restoreState?.mode || 'collaborate');
  const [chiefCalling, setChiefCalling] = useState(false);
  const [incident, setIncident] = useState(restoreState?.incident || '');
  const [paymentState, setPaymentState] = useState(restoreState?.paymentState || 'Paid');
  const timers = useRef([]);
  const listRef = useRef(null);

  useEffect(() => {
    const stages = [300, 600, 900, 1200, 1500, 1800].map((delay, index) => window.setTimeout(() => setSetupStage(index + 1), delay));
    timers.current.push(...stages);
    return () => { for (const timer of timers.current) window.clearTimeout(timer); };
  }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  function selectStore(type) {
    if (!Object.hasOwn(DEMO_STORES, type)) return;
    const nextStore = DEMO_STORES[type];
    setSelectedStoreType(type);
    setMessages(seedMessages(nextStore));
    setTeamStatus('Ready for a customer message');
    setTeamNotes([]);
    setIncident('');
    setPaymentState('Paid');
    setChiefCalling(false);
  }

  async function respond(text, { major = false } = {}) {
    const content = String(text || '').trim();
    if (!content || working) return;
    const id = `wa-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    const asksForUrgentHelp = major || /fraud|charged twice|payment failed|account hacked|urgent|emergency|unsafe/i.test(content);
    setMessages(current => [...current, { id: `${id}-in`, from: 'customer', name: store.customer, text: content }]);
    setWorking(true);
    setIncident('');
    setPaymentState('Paid');
    setTeamNotes([]);
    setTeamStatus('Maya · Sales is reading the incoming message');
    await wait(650);
    let collaborationNote = '';
    if (mode === 'collaborate' || asksForUrgentHelp) {
      setTeamStatus('Maya is asking Avery · Customer care for a second opinion');
      setTeamNotes(['Maya shared the customer request and order context with Avery.', 'Avery checked the catalog and payment record.']);
      await wait(750);
      collaborationNote = 'Avery reviewed the order context and confirmed the next safe step.';
      setTeamStatus('Avery replied · Maya is preparing a customer response');
    } else {
      setTeamStatus('Maya · Sales is checking the store and payment record');
    }
    await wait(500);
    const critical = asksForUrgentHelp;
    const reply = critical
      ? 'I’ve flagged this for the team and paused any automated action. A manager needs to review the payment before anything changes. Chief is calling you in CrewOS now.'
      : /price|cost|available|stock|buy|purchase/i.test(content)
        ? `The ${store.products[0].name} is available for ${store.products[0].price} at ${store.name}. I can share the product details or help you choose a delivery option.`
        : /late|delivery|ship|arriv/i.test(content)
          ? `I’m sorry about the delay. Order #${store.orderId} is paid and marked in transit. I’ve asked customer care to review the tracking details.`
          : /damaged|broken|crack|refund|return/i.test(content)
            ? 'I’m sorry that happened. I’ve recorded the issue for review. We’ll confirm the order details before approving any return or refund.'
            : 'Thanks for reaching out. I’ve reviewed the store details and can help with your order.';
    setMessages(current => [...current, { id: `${id}-out`, from: 'agent', name: 'Maya · Sales', text: reply }]);
    if (critical) setPaymentState('Needs manager review');
    if (critical) {
      setIncident('Major issue detected · no payment action was taken. Chief is calling you inside CrewOS.');
      setChiefCalling(true);
      setTeamStatus('Chief · Manager escalation opened in CrewOS');
      setMessages(current => [...current, { id: `${id}-notice`, from: 'notice', name: 'CrewOS notice', text: 'Chief is calling you in CrewOS. Open the app to answer.' }]);
      if (!collaborationNote) setTeamNotes(['Maya escalated the issue to Chief for manager review.', 'The payment remains unchanged until you review it.']);
    } else {
      setTeamStatus(mode === 'collaborate' ? 'Maya and Avery · Customer care replied together' : 'Maya · Sales replied solo');
    }
    setWorking(false);
    setDraft('');
  }

  function submit(event) { event.preventDefault(); void respond(draft); }

  return <main className="simulation-page">
    <style>{`
      .simulation-page{--sim-line:var(--border);--sim-muted:var(--text-muted);max-width:1200px;margin:0 auto;padding-bottom:34px}
      .simulation-banner{display:flex;align-items:center;gap:10px;margin:-12px 0 22px;padding:13px 16px;border:1px solid color-mix(in srgb,#d99a63 40%,var(--border));border-radius:13px;background:color-mix(in srgb,#d99a63 9%,var(--surface));color:var(--text-muted);font-size:13px}
      .simulation-banner strong{color:var(--text)}.simulation-banner-dot{width:8px;height:8px;border-radius:50%;background:#d99a63;box-shadow:0 0 0 4px color-mix(in srgb,#d99a63 20%,transparent)}
      .sim-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}.sim-kpi{padding:17px;border:1px solid var(--sim-line);border-radius:14px;background:var(--surface);min-width:0}.sim-kpi span{display:block;color:var(--sim-muted);font-size:12px}.sim-kpi b{display:block;margin:8px 0 4px;font-size:19px}.sim-kpi small{color:var(--sim-muted);font-size:11px}
      .sim-grid{display:grid;grid-template-columns:minmax(340px,1.05fr) minmax(320px,.95fr);gap:16px;align-items:start}.sim-phone-panel{position:relative}.sim-phone{width:min(100%,400px);margin:0 auto;padding:10px;border:1px solid #343943;border-radius:31px;background:#101318;box-shadow:0 20px 60px #0002}.sim-phone-screen{overflow:hidden;border-radius:23px;background:#f3f4ef;color:#18201c;min-height:630px;display:flex;flex-direction:column}.sim-phone-island{height:20px;width:102px;margin:0 auto;background:#101318;border-radius:0 0 14px 14px}.sim-wa-head{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#f9faf7;border-bottom:1px solid #e4e8e1}.sim-wa-avatar{width:37px;height:37px;display:grid;place-items:center;border-radius:50%;background:#dce9d9;color:#24543f;font-weight:750}.sim-wa-head div{display:grid;gap:2px}.sim-wa-head small{color:#708078}.sim-wa-label{margin-left:auto;color:#36836d;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.06em}.sim-chat{display:flex;flex:1;flex-direction:column;gap:9px;padding:15px 12px;overflow:auto;background-color:#e9eee6;background-image:radial-gradient(#dbe2d8 1px,transparent 1px);background-size:14px 14px;max-height:470px}.sim-bubble{max-width:86%;padding:9px 11px;border-radius:12px;background:#fff;font-size:12px;line-height:1.45;box-shadow:0 1px 1px #0001;overflow-wrap:anywhere}.sim-bubble.customer{align-self:flex-start;border-top-left-radius:4px}.sim-bubble.agent{align-self:flex-end;background:#d9f4d2;border-top-right-radius:4px}.sim-bubble.notice{align-self:center;background:#fff5cf;color:#63531f;font-size:11px;text-align:center}.sim-bubble small{display:block;margin-bottom:4px;color:#708078;font-weight:700}.sim-wa-form{display:flex;gap:7px;padding:10px;background:#f9faf7;border-top:1px solid #e4e8e1}.sim-wa-form input{flex:1;min-width:0;border:1px solid #d6ddd5;border-radius:20px;padding:10px 12px;font:inherit;font-size:12px;color:#17201b;background:white}.sim-wa-form button{border:0;border-radius:50%;width:38px;height:38px;background:#1e8066;color:white;font-weight:800;cursor:pointer}.sim-wa-form button:disabled{opacity:.45;cursor:not-allowed}.sim-phone-foot{padding:8px;text-align:center;background:#f9faf7;color:#879188;font-size:9px}
      .sim-stack{display:grid;gap:15px}.sim-employee-list{display:grid;gap:10px}.sim-employee{display:flex;align-items:center;gap:11px;padding:11px;border:1px solid var(--sim-line);border-radius:12px;background:var(--surface)}.sim-employee-avatar{flex:none;width:39px;height:39px;display:grid;place-items:center;border-radius:13px;color:#152033;font-weight:800}.sim-employee-main{min-width:0;flex:1}.sim-employee-main b,.sim-employee-main span{display:block}.sim-employee-main span{margin-top:3px;color:var(--sim-muted);font-size:11px}.sim-employee-state{font-size:11px;color:#5dba91;white-space:nowrap}.sim-product-list{display:grid;gap:8px}.sim-product{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid var(--sim-line)}.sim-product:last-child{border-bottom:0}.sim-product b,.sim-product span{display:block}.sim-product span{margin-top:3px;color:var(--sim-muted);font-size:11px}.sim-product-price{white-space:nowrap;text-align:right}.sim-store-choice{display:grid;gap:6px;color:var(--sim-muted);font-size:12px}.sim-store-choice select{width:100%;padding:10px 12px;border:1px solid var(--sim-line);border-radius:10px;background:var(--surface);color:var(--text);font:inherit;font-size:13px}.sim-team-status{padding:12px;border-radius:11px;background:var(--surface-muted);font-size:12px;line-height:1.5}.sim-team-status strong{display:block;margin-bottom:4px}.sim-team-notes{margin:10px 0 0;padding-left:18px;color:var(--sim-muted);font-size:11px;line-height:1.7}.sim-scenario-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.sim-mode{display:flex;gap:7px;flex-wrap:wrap}.sim-mode button{padding:7px 10px;border:1px solid var(--sim-line);border-radius:999px;background:var(--surface);color:var(--text);font:inherit;font-size:11px;cursor:pointer}.sim-mode button[aria-pressed=true]{border-color:#879cff;background:color-mix(in srgb,#879cff 12%,var(--surface))}.sim-incident{margin:12px 0 0;padding:11px 12px;border-left:3px solid #e18b6f;border-radius:5px;background:color-mix(in srgb,#e18b6f 12%,var(--surface));font-size:12px;line-height:1.5}.sim-setup-steps{display:grid;gap:10px}.sim-step{display:flex;align-items:center;gap:9px;color:var(--sim-muted);font-size:12px}.sim-step i{width:19px;height:19px;display:grid;place-items:center;border:1px solid var(--sim-line);border-radius:50%;font-size:10px;font-style:normal}.sim-step.done{color:var(--text)}.sim-step.done i{border-color:#5dba91;background:#5dba91;color:#fff}.sim-twilio{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px;border:1px solid var(--sim-line);border-radius:12px}.sim-twilio p{margin:4px 0 0;color:var(--sim-muted);font-size:11px;line-height:1.5}.sim-modal-scrim{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:20px;background:#080b12b8;backdrop-filter:blur(7px)}.sim-chief-call{width:min(420px,100%);padding:28px;border:1px solid #555f86;border-radius:24px;background:var(--surface);box-shadow:0 30px 100px #0006;text-align:center}.sim-chief-orb{width:76px;height:76px;margin:4px auto 16px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(140deg,#c8d1ff,#788cff);color:#172042;font-size:25px;font-weight:800;box-shadow:0 0 0 10px #8495ff20}.sim-chief-call h2{margin:0 0 7px}.sim-chief-call p{color:var(--sim-muted);font-size:13px;line-height:1.6}
      @media(max-width:850px){.sim-grid{grid-template-columns:1fr}.sim-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.sim-phone{width:min(100%,430px)}}
      @media(max-width:480px){.simulation-page .page-heading{align-items:flex-start}.sim-kpi{padding:13px}.sim-kpi b{font-size:16px}.sim-phone-screen{min-height:570px}.sim-chat{max-height:390px}.sim-employee-state{white-space:normal;text-align:right}}
    `}</style>
    <Heading title="Your CrewOS workspace" subtitle="Your AI team, store, customer conversations, and payments in one place."><Button kind="btn-primary" onClick={() => actions?.('navigate', 'voice')}>Start another interview</Button></Heading>
    <section className="sim-kpis" aria-label="Workspace summary">
      <article className="sim-kpi"><span>AI employees</span><b>{setupStage < 3 ? 'Setting up…' : '3 ready'}</b><small>Sales · Customer care · Operations</small></article>
      <article className="sim-kpi"><span>Store</span><b>{setupStage < 4 ? 'Setting up…' : store.name}</b><small>{store.domain}</small></article>
      <article className="sim-kpi"><span>Payments</span><b>Shopify Payments</b><small>Connected · USD</small></article>
      <article className="sim-kpi"><span>Today’s activity</span><b>1 paid order</b><small>{store.products[0].price} · order #{store.orderId}</small></article>
    </section>

    <div className="sim-grid">
      <Panel title="Customer WhatsApp inbox" subtitle="Messages from customers and replies from your team." className="sim-phone-panel">
        <div className="sim-phone"><div className="sim-phone-screen">
          <div className="sim-phone-island"/>
          <header className="sim-wa-head"><span className="sim-wa-avatar">{store.avatar}</span><div><b>{store.name}</b><small>{store.category}</small></div><span className="sim-wa-label">WhatsApp</span></header>
          <div className="sim-chat" ref={listRef} aria-live="polite">
            {messages.map(message => <article key={message.id} className={`sim-bubble ${message.from}`}><small>{message.name}</small>{message.text}</article>)}
            {working && <article className="sim-bubble agent"><small>{teamStatus}</small>Reviewing the request…</article>}
          </div>
          <form className="sim-wa-form" onSubmit={submit}><input aria-label={`Write a WhatsApp message to ${store.name}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder={`Message ${store.name}…`} maxLength={400}/><button type="submit" aria-label="Send WhatsApp message" disabled={!draft.trim() || working}>↑</button></form>
        </div></div>
        <div className="sim-scenario-actions"><Button disabled={working} onClick={() => void respond(`My order #${store.orderId} is late. Can you check the delivery?`)}>Delivery question</Button><Button disabled={working} onClick={() => void respond(`I think I was charged twice for order #${store.orderId}.`, { major: true })}>Report payment issue</Button></div>
      </Panel>

      <div className="sim-stack">
        <Panel title="Team at work" subtitle="Maya handles the customer. Avery helps when the case needs another perspective.">
          <div className="sim-team-status" role="status" aria-live="polite"><strong>{teamStatus}</strong>{working ? 'The team is reviewing the order and customer history.' : 'Waiting for the next customer request.'}
            {teamNotes.length > 0 && <ul className="sim-team-notes">{teamNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          </div>
          {incident && <div className="sim-incident" role="alert">{incident}</div>}
          <div className="sim-employee-list" style={{ marginTop: 12 }}>
            {employees.map((employee, index) => <article className="sim-employee" key={employee.id}><span className="sim-employee-avatar" style={{ background: employee.color }}>{employee.initials}</span><div className="sim-employee-main"><b>{employee.name}</b><span>{employee.role} · {employee.skills}</span></div><span className="sim-employee-state">{setupStage > index ? 'Ready' : 'Setting up'}</span></article>)}
          </div>
          <div className="sim-scenario-actions"><span style={{ color: 'var(--text-muted)', alignSelf: 'center', fontSize: 11 }}>Response mode</span><div className="sim-mode"><button type="button" aria-pressed={mode === 'solo'} onClick={() => setMode('solo')}>Sales solo</button><button type="button" aria-pressed={mode === 'collaborate'} onClick={() => setMode('collaborate')}>Ask a coworker</button></div></div>
        </Panel>

        <Panel title="Shopify store" subtitle="Products, pricing, and inventory for your storefront.">
          <label className="sim-store-choice">Store<select aria-label="Choose a storefront" value={selectedStoreType} disabled={working} onChange={event => selectStore(event.target.value)}>{Object.values(DEMO_STORES).map(item => <option key={item.id} value={item.id}>{item.name} · {item.category}</option>)}</select></label>
          <div className="sim-readiness" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '12px 0 10px' }}><b>{store.name}</b><Badge value="connected">Connected</Badge></div>
          <p className="field-hint" style={{ marginTop: 0 }}>{store.domain}</p>
          <div className="sim-product-list">{store.products.map(product => <article className="sim-product" key={product.sku}><div><b>{product.name}</b><span>{product.sku} · {product.stock}</span></div><b className="sim-product-price">{product.price}</b></article>)}</div>
        </Panel>

        <Panel title="Payments and customer service" subtitle="Payments and customer conversations for your storefront.">
          <div className="sim-twilio"><div><b>Order #{store.orderId} · {store.products[0].price}</b><p>{store.products[0].name} · Shopify Payments</p></div><Badge value={paymentState === 'Paid' ? 'completed' : 'input_required'}>{paymentState}</Badge></div>
          <div className="sim-twilio" style={{ marginTop: 9 }}><div><b>Twilio customer service</b><p>Customer support channel · voice and messaging</p></div><Badge value="connected">Connected</Badge></div>
          <div className="sim-twilio" style={{ marginTop: 9 }}><div><b>{store.name} orders</b><p>{store.products[0].name} · one item · {store.products[0].price}</p></div><Badge value="connected">Paid</Badge></div>
        </Panel>

        <Panel title="Workspace setup" subtitle="Your team and storefront setup.">
          <div className="sim-setup-steps">{['Creating Sales employee', 'Creating Customer care employee', 'Creating Operations employee', `Preparing ${store.name} store`, 'Setting up payments', 'Connecting WhatsApp and Twilio'].map((step, index) => <div className={`sim-step ${setupStage > index ? 'done' : ''}`} key={step}><i>{setupStage > index ? '✓' : index + 1}</i>{step}</div>)}</div>
        </Panel>
      </div>
    </div>

    {chiefCalling && <div className="sim-modal-scrim" role="presentation"><section className="sim-chief-call" role="dialog" aria-modal="true" aria-labelledby="sim-chief-title"><div className="sim-chief-orb" aria-hidden="true">C</div><h2 id="sim-chief-title">Chief is calling you in CrewOS</h2><p>A high-priority order issue needs your review. Answer with Chief to discuss it by voice.</p><Button kind="btn-primary" onClick={() => { const currentMessage=[...messages].reverse().find(message=>message.from==='customer')?.text||incident; actions?.('start-chief-call',{storeType:selectedStoreType,storeName:store.name,orderId:store.orderId,productName:store.products[0].name,amount:store.products[0].price,issue:currentMessage,returnState:{messages,teamStatus,teamNotes,mode,incident,paymentState}}); }}>Answer Chief’s call</Button> <Button onClick={() => setChiefCalling(false)}>Close</Button></section></div>}
  </main>;
}
