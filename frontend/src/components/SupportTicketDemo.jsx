import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Button, Panel } from './ui.jsx';

const demoExamples = [
  { subject: 'My order is late', message: 'My package has not arrived yet. Can someone look into it?' },
  { subject: 'Report a damaged product', message: 'The bottle arrived with a cracked lid. What should I do?' },
  { subject: 'Question about a charge', message: 'I think I was charged twice for my order.' },
];

export default function SupportTicketDemo() {
  const [clientName, setClientName] = useState('Taylor Morgan');
  const [subject, setSubject] = useState(demoExamples[0].subject);
  const [message, setMessage] = useState(demoExamples[0].message);
  const [mode, setMode] = useState('collaborate');
  const [tickets, setTickets] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refreshTickets() {
    const result = await api('/api/demo/support-tickets');
    setTickets(result.tickets || []);
  }

  useEffect(() => { refreshTickets().catch(failure => setError(failure.message)); }, []);

  async function createTicket(event) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('Client is submitting the ticket…');
    try {
      const ticket = await api('/api/demo/support-tickets', {
        method: 'POST',
        body: JSON.stringify({ clientName, subject, message, mode }),
      });
      setTickets(current => [ticket, ...current.filter(item => item.ticketId !== ticket.ticketId)]);
      setNotice(mode === 'collaborate' ? 'Ticket answered after a coworker review.' : 'Ticket answered by one agent.');
    } catch (failure) { setError(failure.message); setNotice(''); }
    finally { setBusy(false); }
  }

  return <Panel title="Client support ticket demo" subtitle="Create a sample customer report. One local demo agent answers alone or asks a coworker for help; no external customer or store is contacted.">
    <form className="support-demo-form" onSubmit={createTicket}>
      <label>Client name<input value={clientName} onChange={event => setClientName(event.target.value)} maxLength={80} required /></label>
      <label>Report title<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={140} required /></label>
      <label className="support-demo-wide">What happened?<textarea value={message} onChange={event => setMessage(event.target.value)} rows={3} maxLength={2000} required /></label>
      <label>How should the team handle it?<select value={mode} onChange={event => setMode(event.target.value)}><option value="solo">One agent handles it</option><option value="collaborate">Ask a coworker, then reply</option></select></label>
      <div className="support-demo-wide support-demo-actions"><Button kind="btn-primary" type="submit" disabled={busy}>{busy ? 'Working…' : 'Create client ticket'}</Button><Button type="button" disabled={busy} onClick={() => { const example = demoExamples[(demoExamples.findIndex(item => item.subject === subject) + 1) % demoExamples.length]; setSubject(example.subject); setMessage(example.message); }}>Try another sample</Button></div>
    </form>
    {notice && <p role="status" className="field-hint">{notice}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="support-ticket-list">
      {tickets.map(ticket => <article className="support-ticket-card" key={ticket.ticketId || ticket.id}>
        <header><div><b>{ticket.subject}</b><span>{ticket.clientName} · {ticket.topic?.replace('_', ' ')} · {ticket.mode === 'collaborate' ? 'coworker review' : 'solo'}</span></div><span className="support-ticket-badge">Answered · simulated</span></header>
        <p className="support-ticket-message">“{ticket.message}”</p>
        {ticket.helperNote && <div className="support-ticket-note"><b>{ticket.agents?.[1]?.name || 'Coworker'} · internal review</b><p>{ticket.helperNote}</p></div>}
        <div className="support-ticket-reply"><b>{ticket.agents?.[0]?.name || 'Support agent'} · reply to client</b><p>{ticket.reply}</p></div>
      </article>)}
      {!tickets.length && <p className="field-hint">No tickets yet. Submit the sample report to see the agents answer.</p>}
    </div>
    <style>{`.support-demo-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.support-demo-form label{display:grid;gap:7px;color:var(--text-muted);font-size:13px}.support-demo-form input,.support-demo-form textarea,.support-demo-form select{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:9px;padding:11px 12px;background:var(--surface);color:var(--text);font:inherit}.support-demo-wide{grid-column:1/-1}.support-demo-actions{display:flex;gap:10px;flex-wrap:wrap}.support-ticket-list{display:grid;gap:12px;margin-top:18px}.support-ticket-card{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface)}.support-ticket-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.support-ticket-card header div{display:grid;gap:5px}.support-ticket-card header span,.support-ticket-card p{color:var(--text-muted);font-size:13px}.support-ticket-badge{white-space:nowrap;color:#69c9aa!important}.support-ticket-message{margin:14px 0}.support-ticket-note,.support-ticket-reply{padding:12px;border-radius:9px;background:var(--surface-muted);margin-top:9px}.support-ticket-note p,.support-ticket-reply p{margin:7px 0 0;line-height:1.5}.support-ticket-reply{border-left:3px solid #8fa5ff}@media(max-width:600px){.support-demo-form{grid-template-columns:1fr}.support-demo-wide{grid-column:auto}.support-ticket-card header{display:grid}}`}</style>
  </Panel>;
}
