import { useId, useState } from 'react';
import { Tabs as RadixTabs, Tooltip } from 'radix-ui';
import {m,useReducedMotion} from 'motion/react';
import { pretty } from '../lib/format.js';
import { statusLabel } from '../lib/content.js';

export function Badge({ value, children }) {
  const state=String(value || 'draft').toLowerCase();
  return <span className={'status ' + state}><span className="status-symbol" aria-hidden="true">{['completed','passed','active','connected','ready'].includes(state) ? '✓' : ['failed','error','denied','cancelled'].includes(state) ? '×' : ['input_required','reconciliation_required','probation'].includes(state) ? '◇' : '○'}</span>{children || statusLabel(state)}</span>;
}
export function Button({ children, kind = '', onClick, disabled = false, type = 'button', ...props }) {
  const [pending,setPending]=useState(false);
  async function click(event){const result=onClick?.(event);if(result&&typeof result.then==='function'){setPending(true);try{await result;}finally{setPending(false);}}}
  return <button type={type} className={'btn '+kind} disabled={disabled||pending} aria-busy={pending||undefined} onClick={click} {...props}>{children}</button>;
}
export function Heading({ title, subtitle, children }) {
  return <header className="page-heading"><div className="heading-copy"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{children && <div className="heading-actions">{children}</div>}</header>;
}
export function Panel({ title, subtitle, action, children, className='' }) {
  return <section className={'panel '+className}>{(title||action) && <div className="panel-head"><div>{title && <h2 className="panel-title">{title}</h2>}{subtitle && <p className="panel-subtitle">{subtitle}</p>}</div>{action}</div>}<div className="panel-body">{children}</div></section>;
}
export function Empty({ title, children, action }) {
  return <div className="empty-state"><b>{title}</b>{children && <p>{children}</p>}{action && <div className="empty-action">{action}</div>}</div>;
}
export function Field({ label, name, value, onChange, type='text', options, rows, hint, required=true, full=false, error, ...props }) {
  const id=useId(); const [visible,setVisible]=useState(false);
  const valueProps=type==='file'?{}:onChange?{value:value??''}:{defaultValue:value??''};
  const shared={id,name,required,onChange,...valueProps,'aria-invalid':error?true:undefined,'aria-describedby':error||hint?id+'-help':undefined,...props};
  return <div className={'field '+(full?'full':'')}><label htmlFor={id}>{label}{!required && <span className="optional">Optional</span>}</label><div className={type==='password'?'secret-input':''}>{options ? <select {...shared}>{options.map(option=>typeof option==='string'?<option key={option} value={option}>{pretty(option)}</option>:<option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>: rows ? <textarea rows={rows} {...shared}/>:<input type={type==='password'&&visible?'text':type} {...shared}/ >}{type==='password' && <button type="button" className="secret-toggle" onClick={()=>setVisible(!visible)} aria-label={visible?'Hide password':'Show password'}>{visible?'Hide':'Show'}</button>}</div>{(error||hint) && <small id={id+'-help'} className={'field-hint '+(error?'field-error':'')} role={error?'alert':undefined}>{error||hint}</small>}</div>;
}
export function Brand() {return <a className="brand" href="#voice" aria-label="CrewOS voice interview"><span className="brand-mark" aria-hidden="true"><span/><span/><span/></span><span className="brand-name">CrewOS</span></a>;}
export function Tabs({value,onChange,items,label='Views',children}) {
  const id=useId(),reduced=useReducedMotion();
  return <RadixTabs.Root value={value} onValueChange={onChange}><RadixTabs.List className="tabs" aria-label={label}>{items.map(item=><RadixTabs.Trigger className="tab" key={item.value} value={item.value}>{item.label}{item.count!=null&&<span className="tab-count">{item.count}</span>}{value===item.value&&<m.span className="tab-indicator" layoutId={id} transition={reduced?{duration:0}:{type:'spring',bounce:0,duration:.25}}/>}</RadixTabs.Trigger>)}</RadixTabs.List><RadixTabs.Content className="tab-panel" value={value}>{children}</RadixTabs.Content></RadixTabs.Root>;
}
export function IconButton({label,icon,...props}) {return <Tooltip.Provider delayDuration={400}><Tooltip.Root><Tooltip.Trigger asChild><button type="button" className="icon-button" aria-label={label} {...props}><NavIcon name={icon}/></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow/></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;}
export function Technical({children,title='Technical details'}) {return <details className="technical"><summary>{title}</summary>{children}</details>;}
export function Json({value}) {return <pre className="code-block">{JSON.stringify(value,null,2)}</pre>;}
export function Table({headers,children}) {return <div className="table-wrap"><table className="data-table"><thead><tr>{headers.map(item=><th key={item} scope="col">{item}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;}
export function Kpi({label,value,note}) {return <article className="kpi"><span className="kpi-label">{label}</span><strong className="kpi-number">{value??'—'}</strong>{note && <small className="kpi-note">{note}</small>}</article>;}
export function Toast({toast,onClose}) {return toast?<div className={'toast '+(toast.error?'error':'')} role={toast.error?'alert':'status'} aria-live={toast.error?'assertive':'polite'}><span>{toast.message}</span>{onClose&&<button type="button" onClick={onClose} aria-label="Dismiss notification">×</button>}</div>:null;}

export function NavIcon({ name }) {
  const shared = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 1.8 };
  const paths = {
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".7"/><circle cx="4" cy="12" r=".7"/><circle cx="4" cy="18" r=".7"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></>,
    moon: <path d="M20.6 15.4A8.5 8.5 0 0 1 8.6 3.4 8.5 8.5 0 1 0 20.6 15.4Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
    employees: <><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.1 2.5-4.7 5.5-4.7s4.9 1.6 5.5 4.7"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 6.1M17 14.5c2 .5 3.2 2 3.6 4.5"/></>,
    tasks: <><path d="M8 6h12M8 12h12M8 18h12"/><path d="m3.5 6 .8.8L5.8 5M3.5 12l.8.8 1.5-1.8M3.5 18l.8.8 1.5-1.8"/></>,
    probation: <><path d="M12 3.2 19 6v5.1c0 4.4-2.5 7.7-7 9.7-4.5-2-7-5.3-7-9.7V6l7-2.8Z"/><path d="m9 11.8 2 2 4-4"/></>,
    coworkers: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.3"/><path d="M3 19c.5-3 2.5-4.5 6-4.5s5.5 1.5 6 4.5M15 14.8c2.8-.1 4.5 1.3 5 4.2"/></>,
    meetings: <><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M8 13h3M13 13h3M8 16.5h3"/></>,
    office: <><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 7.5h2M14 7.5h2M8 11.5h2M14 11.5h2M8 15.5h2M14 15.5h2M10 20.5v-2.8h4v2.8"/></>,
    integrations: <><path d="M8 4v5M16 4v5M6 9h12v2a6 6 0 0 1-6 6v3M12 20v-3"/><path d="M9 9V6M15 9V6"/></>,
    memory: <><path d="M12 4.2c-1.7-1.3-4.2-.5-4.7 1.7-2.5-.2-4 2.6-2.6 4.6-1.7 1.9-.6 4.7 1.8 5.1.4 2.5 3.2 3.6 5.2 1.8 2 1.8 4.8.7 5.2-1.8 2.4-.4 3.5-3.2 1.8-5.1 1.4-2-.1-4.8-2.6-4.6-.5-2.2-3-3-4.7-1.7Z"/><path d="M12 5v14M8.5 9.5H12M12 14.5h3.5"/></>,
    reports: <><path d="M4 19.5V11M10 19.5V5M16 19.5v-7M22 19.5H2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-.1.2-1.4 2.4-.2.1-1.5-.6a7.5 7.5 0 0 1-1.4.8l-.3 1.6-.2.1h-2.8l-.2-.1-.3-1.6a7.5 7.5 0 0 1-1.4-.8l-1.5.6-.2-.1-1.4-2.4.1-.2 1.2-1a7 7 0 0 1 0-1.6l-1.2-1-.1-.2 1.4-2.4.2-.1 1.5.6a7.5 7.5 0 0 1 1.4-.8l.3-1.6.2-.1h2.8l.2.1.3 1.6a7.5 7.5 0 0 1 1.4.8l1.5-.6.2.1 1.4 2.4-.1.2-1.2 1a7 7 0 0 1 0 1.6Z"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0 1.3 4"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" {...shared}>{paths[name] || paths.overview}</svg>;
}
