import { useEffect, useRef, useState } from 'react';
import { PUBLIC_PATHS, PublicLink } from '../config/public-routes.jsx';

// The CrewOS mark: three level bars, the last one with its signal dot.
// `speaking` animates the bars like a live voice level (used in the hero).
export function CrewMark({ speaking = false, className = '' }) {
  return <span className={'crew-mark ' + (speaking ? 'is-speaking ' : '') + className} aria-hidden="true"><i/><i/><i/></span>;
}
export function CrewWordmark({ to = PUBLIC_PATHS.landing, label = 'CrewOS home' }) {
  return <PublicLink to={to} className="crew-wordmark" aria-label={label}><CrewMark/><span>crewos</span></PublicLink>;
}

const SEATS = [
  ['Engineer', 'Store, catalog, payments, fixes'],
  ['Legal', 'Terms, privacy, refunds, consent'],
  ['Support', 'Every chat, every order issue'],
  ['Sales', 'Follow-ups, reviews, repeat buyers'],
  ['Ops', 'Plans, reports, approvals'],
];

const STEPS = [
  ['Talk', 'Describe your business to Chief, by voice or chat. About 5 minutes.', 'done'],
  ['Hire', 'Chief drafts the roles you need. You approve each hire.', 'done'],
  ['Test', 'Every hire passes probation scenarios before real work.', 'done'],
  ['Run', 'Your team works around the clock. You approve what matters.', 'next'],
];

const DAYS = [
  { key: 'call', tab: 'Call', day: 'Day 1', area: 'Onboarding call', title: 'Tell Chief about your business.',
    body: 'A voice call with Chief, the onboarding agent. It turns what you say into notes you can review, then proposes the team you need.',
    points: ['Business, catalog, prices and shipping captured', 'Each note points to the moment it was said', 'Drafts Engineering, Support and Sales hires'] },
  { key: 'store', tab: 'Store', day: 'Day 1', area: 'Engineering', title: 'Ezra builds the Shopify store.',
    body: 'The engineering agent connects your store, applies a theme and builds the catalog straight from the call notes.',
    points: ['Products, prices, collections and shipping zones', 'Going live waits for your one-click approval', 'Live storefront read back and verified'] },
  { key: 'legal', tab: 'Legal', day: 'Day 2', area: 'Compliance', title: 'The legal pages, drafted.',
    body: 'Terms, privacy, refunds, shipping, cookie consent and a launch checklist, written from how this store actually works.',
    points: ['Checked against DPDP Act and GDPR basics', 'WhatsApp opt-in and grievance contact included', 'Nothing publishes until you review it'] },
  { key: 'support', tab: 'Support', day: 'Day 3', area: 'Support × Engineering', title: 'A customer issue, fixed together.',
    body: 'A buyer on WhatsApp was charged but got no order. Ava from Support spots the pattern and hands it to Ezra in Engineering.',
    points: ['Root cause found: a broken payment webhook', 'The fix waits for your approval', '3 orders restored, verified, customer updated'] },
  { key: 'sales', tab: 'Sales', day: 'Day 10', area: 'Sales', title: 'Sol follows up, within your rules.',
    body: 'A week after delivery, the sales agent asks for feedback and turns a happy buyer into a review and a repeat order.',
    points: ['Checks marketing consent before messaging', 'Discounts above 15% need your approval', 'Feedback saved to shared memory, with its source'] },
];

const GUARDRAILS = [
  ['probation', 'Probation', 'Simulated scenarios must pass before a role version can deploy.'],
  ['policy', 'Policy gate', 'Each action is checked live: allowed, needs your approval, or blocked.'],
  ['verified', 'Verified', 'Work completes only after an independent read-back confirms it.'],
  ['audited', 'Audited', 'Every tool call, approval and decision is logged with its version.'],
];

const FLOW = [
  ['Where work comes in', ['Voice call with Chief', 'WhatsApp · Slack', 'Dashboard · API · CLI', 'Schedules & meetings']],
  ['CrewOS control plane', ['Versioned roles & grants', 'Live policy + approvals', 'Durable queue & recovery', 'Independent verifier', 'Shared memory with citations']],
  ['Real systems', ['Shopify · Jira', 'Browser & desktop VMs', 'Any MCP server', 'Any LLM via OpenRouter']],
];

function Glyph({ name }) {
  const paths = {
    check: <path d="M5 10.5l3 3 7-7"/>,
    arrow: <path d="M4 10h11m-4-4 4 4-4 4"/>,
    probation: <><path d="M2.5 8 10 4.5 17.5 8 10 11.5z"/><path d="M5.5 9.5v3.5c1.2 1.2 2.7 1.8 4.5 1.8s3.3-.6 4.5-1.8V9.5"/></>,
    policy: <><rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M7 9V7a3 3 0 0 1 6 0v2"/></>,
    verified: <><path d="M10 2.8 16 5v4.6c0 3.6-2.5 6.3-6 7.6-3.5-1.3-6-4-6-7.6V5z"/><path d="m7.3 10 1.9 1.9 3.6-3.7"/></>,
    audited: <><path d="M8 6h8M8 10h8M8 14h8"/><circle cx="4.5" cy="6" r=".6"/><circle cx="4.5" cy="10" r=".6"/><circle cx="4.5" cy="14" r=".6"/></>,
  };
  return <svg className="lp-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function Eyebrow({ children }) {
  return <p className="lp-eyebrow"><span>{children}</span></p>;
}

function CallVignette() {
  return <div className="vg vg-call">
    <div className="vg-head"><span className="vg-live"><CrewMark speaking/> Call with Chief</span><span className="vg-mono">05:12</span></div>
    <ol className="vg-transcript">
      <li><span className="vg-mono">01:42</span><p><b>You</b> We make handmade ceramic mugs. Fourteen designs, ₹1,200 each.</p></li>
      <li><span className="vg-mono">03:10</span><p><b>You</b> We ship across India, usually five to seven days.</p></li>
      <li><span className="vg-mono">04:38</span><p><b>Chief</b> Got it. Do customers mostly reach you on WhatsApp?</p></li>
    </ol>
    <div className="vg-notes">
      <span className="vg-label">Notes from this call</span>
      <ul><li>Catalog · 14 mugs at ₹1,200 <span className="vg-mono">↗ 01:42</span></li><li>Shipping · Pan-India, 5–7 days <span className="vg-mono">↗ 03:10</span></li></ul>
    </div>
    <div className="vg-foot"><span className="vg-label">Proposed hires</span><span className="vg-chip">Engineering</span><span className="vg-chip">Support</span><span className="vg-chip">Sales</span></div>
  </div>;
}

function StoreVignette() {
  return <div className="vg vg-store">
    <div className="vg-head"><span>Ezra · Engineering</span><span className="vg-mono">kiln-and-co.myshopify.com</span></div>
    <ul className="vg-steps">
      <li className="ok"><Glyph name="check"/>Theme applied</li>
      <li className="ok"><Glyph name="check"/>14 products in 3 collections</li>
      <li className="ok"><Glyph name="check"/>Shipping zone: India, 5–7 days</li>
      <li className="wait"><span className="vg-ring"/>Go live</li>
    </ul>
    <div className="vg-approval">
      <div><span className="vg-tag">Waiting for you</span><p>Publish the storefront to customers?</p></div>
      <div className="vg-fake-actions"><span>Not yet</span><span className="primary">Approve</span></div>
    </div>
    <p className="vg-mono vg-read">read-back · 14 of 14 products match the call notes</p>
  </div>;
}

function LegalVignette() {
  const docs = [['Terms of service', 'Ready to review'], ['Privacy policy', 'DPDP · GDPR basics'], ['Refunds & returns', 'Ready to review'], ['Shipping policy', 'From call notes'], ['Cookie consent', 'Banner + log'], ['Launch checklist', '9 of 11 done']];
  return <div className="vg vg-legal">
    <div className="vg-head"><span>Compliance drafts</span><span className="vg-tag">Unpublished</span></div>
    <ul className="vg-docs">{docs.map(([name, note]) => <li key={name}><span className="vg-doc-icon"/><b>{name}</b><span>{note}</span></li>)}</ul>
    <p className="vg-mono vg-read">WhatsApp opt-in · grievance contact included</p>
  </div>;
}

function SupportVignette() {
  return <div className="vg vg-support">
    <div className="vg-handoff"><span className="vg-agent">Ava · Support</span><span className="vg-wire" aria-hidden="true"/><span className="vg-agent">Ezra · Engineering</span></div>
    <pre className="vg-term"><span className="d">$</span> inspect webhook orders/paid --since 14:00{'\n'}<span className="e">14:06  401  signature mismatch  ×3</span>{'\n'}<span className="w">cause: webhook secret rotated 14:02</span>{'\n'}<span className="d">$</span> dry-run replay  <span className="g">→ 3 orders would be created ✓</span></pre>
    <div className="vg-approval dark">
      <div><span className="vg-tag">Approval required</span><p>Update the payment webhook and replay 3 orders.</p></div>
      <div className="vg-fake-actions"><span>Deny</span><span className="primary">Approve</span></div>
    </div>
  </div>;
}

function SalesVignette() {
  return <div className="vg vg-sales">
    <div className="vg-head"><span>Sol · Sales</span><span className="vg-mono">WhatsApp</span></div>
    <ul className="vg-checks">
      <li className="ok"><Glyph name="check"/>Marketing consent on file</li>
      <li className="ok"><Glyph name="check"/>10% off is inside your 15% limit</li>
    </ul>
    <div className="vg-bubble">Hi Meera, how is the speckled mug holding up? If you have a minute, a review would help a small studio a lot. Here’s 10% off your next order.</div>
    <div className="vg-bubble them">Love it! Ordering two more for my sister.</div>
    <p className="vg-mono vg-read">saved to memory · “prefers matte glazes” · source: WhatsApp</p>
  </div>;
}

const VIGNETTES = { call: CallVignette, store: StoreVignette, legal: LegalVignette, support: SupportVignette, sales: SalesVignette };

function FirstTenDays() {
  const [active, setActive] = useState(0);
  const tabs = useRef([]);
  const day = DAYS[active], Vignette = VIGNETTES[day.key];
  function onKeyDown(event) {
    const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next = null;
    if (event.key in moves) next = (active + moves[event.key] + DAYS.length) % DAYS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = DAYS.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }
  return <section className="lp-section lp-week" id="first-days" aria-labelledby="week-title">
    <div className="lp-week-intro">
      <Eyebrow>A store’s first ten days</Eyebrow>
      <h2 id="week-title" tabIndex={-1}>Watch one store go from a phone call to repeat customers.</h2>
    </div>
    <div className="lp-week-stage">
      <div className="lp-week-copy" key={day.key + '-copy'}>
        <p className="lp-day">{day.day} · {day.area}</p>
        <h3>{day.title}</h3>
        <p className="lp-week-body">{day.body}</p>
        <ul className="lp-ticks">{day.points.map((point) => <li key={point}><Glyph name="check"/>{point}</li>)}</ul>
      </div>
      <div className="lp-week-frame" id={'day-panel-' + day.key} role="tabpanel" aria-labelledby={'day-tab-' + day.key} tabIndex={0}>
        <div className="lp-week-vignette" key={day.key}><Vignette/></div>
      </div>
    </div>
    <div className="lp-week-bar">
      <p className="lp-caps" aria-hidden="true">Example store · Kiln &amp; Co.</p>
      <div className="lp-week-tabs" role="tablist" aria-label="Choose a day" onKeyDown={onKeyDown}>
        {DAYS.map((item, index) => <button key={item.key} ref={(node) => { tabs.current[index] = node; }} type="button" role="tab" id={'day-tab-' + item.key} aria-controls={'day-panel-' + item.key} aria-selected={index === active} tabIndex={index === active ? 0 : -1} className={index === active ? 'active' : ''} onClick={() => setActive(index)}><span className="lp-tab-day">{item.day}</span> {item.tab}</button>)}
      </div>
    </div>
  </section>;
}

function Actions({ align = 'center', signedIn = false }) {
  if (signedIn) return <div className={'lp-actions ' + align}><a href={PUBLIC_PATHS.workspace} className="lp-btn lp-btn-ink">Open your workspace</a></div>;
  return <div className={'lp-actions ' + align}>
    <PublicLink to={PUBLIC_PATHS.register} className="lp-btn lp-btn-ink">Create your workspace</PublicLink>
    <PublicLink to={PUBLIC_PATHS.login} className="lp-btn lp-btn-line">Sign in</PublicLink>
  </div>;
}

const SECTION_LINKS = [['product', 'How it works'], ['first-days', 'First ten days'], ['guardrails', 'Guardrails']];

export function LandingPage({ signedIn = false }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 12);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  // In-page links scroll without touching the hash, which the workspace uses for its own routes.
  function jump(event, id) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    (target.tagName === 'MAIN' ? target : target.querySelector('h2'))?.focus({ preventScroll: true });
  }
  return <div className="lp">
    <a className="lp-skip" href="#lp-main" onClick={(event) => jump(event, 'lp-main')}>Skip to content</a>
    <header className={'lp-nav' + (scrolled ? ' is-scrolled' : '')}>
      <div className="lp-nav-inner">
        <CrewWordmark/>
        <nav aria-label="Sections" className="lp-nav-links">{SECTION_LINKS.map(([id, label]) => <a key={id} href={'#' + id} onClick={(event) => jump(event, id)}>{label}</a>)}</nav>
        <div className="lp-nav-actions">
          {signedIn ? <a href={PUBLIC_PATHS.workspace} className="lp-btn lp-btn-ink lp-btn-small">Open workspace</a> : <>
            <PublicLink to={PUBLIC_PATHS.login} className="lp-nav-signin">Sign in</PublicLink>
            <PublicLink to={PUBLIC_PATHS.register} className="lp-btn lp-btn-ink lp-btn-small">Create workspace</PublicLink>
          </>}
        </div>
      </div>
    </header>

    <main id="lp-main" tabIndex={-1}>
      <section className="lp-hero" aria-labelledby="hero-title">
        <div className="lp-aura" aria-hidden="true"/>
        <div className="lp-hero-inner">
          <div className="lp-hero-tile"><CrewMark speaking/></div>
          <Eyebrow>AI employees for founders</Eyebrow>
          <h1 id="hero-title">Your AI company,<br/>staffed in one call.</h1>
          <p className="lp-lede">Hire, test and run an AI team — engineering, support and sales — while you keep the keys.</p>
          <Actions signedIn={signedIn}/>
          <p className="lp-caps lp-audience">Built for solo founders · D2C brands · small teams</p>
        </div>
      </section>

      <section className="lp-section lp-problem" aria-labelledby="problem-title">
        <Eyebrow>The problem</Eyebrow>
        <h2 id="problem-title" tabIndex={-1}>Launching a business takes a whole team.</h2>
        <ul className="lp-seats">{SEATS.map(([role, duties]) => <li key={role}><span className="lp-seat-tag">Open seat</span><h3>{role}</h3><p>{duties}</p></li>)}</ul>
        <p className="lp-statement">Most founders have one person: themselves. <span>And today’s AI agents can act — but nobody can trust them with a live store.</span></p>
      </section>

      <section className="lp-section lp-product" id="product" aria-labelledby="product-title">
        <div className="lp-product-copy">
          <Eyebrow>The product</Eyebrow>
          <h2 id="product-title" tabIndex={-1}>CrewOS turns one conversation into a working AI team.</h2>
          <p>No hiring loop, no setup project. Four steps from idea to a team that runs your store.</p>
        </div>
        <div className="lp-card lp-steps">
          <p className="lp-steps-title">Get started <span>· 3 of 4 done</span></p>
          <ol>{STEPS.map(([name, text, state]) => <li key={name} className={state}><span className="lp-step-dot">{state === 'done' && <Glyph name="check"/>}</span><div><h3>{name}</h3><p>{text}</p></div></li>)}</ol>
        </div>
      </section>

      <FirstTenDays/>

      <section className="lp-section lp-trust" id="guardrails" aria-labelledby="trust-title">
        <Eyebrow>The trust layer</Eyebrow>
        <h2 id="trust-title" tabIndex={-1}>Every AI employee works inside four guardrails.</h2>
        <ul className="lp-guards">{GUARDRAILS.map(([icon, name, text]) => <li key={name} className="lp-card"><span className="lp-guard-icon"><Glyph name={icon}/></span><h3>{name}</h3><p>{text}</p></li>)}</ul>
        <p className="lp-trust-note">Agents hand off work to each other, but authority never travels with the message.</p>
      </section>

      <section className="lp-section lp-flow" aria-labelledby="flow-title">
        <Eyebrow>How it works</Eyebrow>
        <h2 id="flow-title">The model proposes. CrewOS decides what happens.</h2>
        <div className="lp-flow-row">{FLOW.map(([label, items], index) => <div key={label} className="lp-flow-cell">
          {index > 0 && <span className="lp-flow-arrow"><Glyph name="arrow"/></span>}
          <div className={'lp-card lp-flow-card' + (index === 1 ? ' is-core' : '')}><p className="lp-caps">{label}</p><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>)}</div>
      </section>

      <section className="lp-close" aria-labelledby="close-title">
        <div className="lp-aura is-low" aria-hidden="true"/>
        <div className="lp-close-inner">
          <div className="lp-hero-tile"><CrewMark/></div>
          <h2 id="close-title">Hire your AI company.</h2>
          <p className="lp-lede">Start with one call to Chief. You approve every hire, and every action that matters.</p>
          <Actions signedIn={signedIn}/>
        </div>
      </section>
    </main>

    <footer className="lp-footer">
      <CrewWordmark/>
      <p>AI employees for founders · © 2026 CribDevs</p>
      <nav aria-label="Account">{signedIn ? <a href={PUBLIC_PATHS.workspace}>Open workspace</a> : <><PublicLink to={PUBLIC_PATHS.login}>Sign in</PublicLink><PublicLink to={PUBLIC_PATHS.register}>Create workspace</PublicLink></>}</nav>
    </footer>
  </div>;
}
