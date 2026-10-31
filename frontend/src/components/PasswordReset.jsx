import { useState } from 'react';
import { neonAuth } from '../lib/api.js';
import { formObject } from '../lib/format.js';
import { Button, Field } from './ui.jsx';

export function PasswordReset({ onCancel, notify }) {
  const [email, setEmail] = useState(''), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function send() {
    await neonAuth('email-otp/request-password-reset', { body: { email: email.trim().toLowerCase() } });
    setSent(true);
    notify('If that email has an account, a reset code is on its way.');
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!sent) await send();
      else {
        const values = formObject(event.currentTarget);
        if (values.password !== values.confirmPassword) throw new Error('The passwords do not match.');
        await neonAuth('email-otp/reset-password', { body: { email: email.trim().toLowerCase(), otp: values.otp.trim(), password: values.password } });
        notify('Password reset. Sign in with your new password.');
        onCancel();
      }
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError('');
    try { await send(); } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="form-grid">
    {error && <p className="form-error full" role="alert">{error}</p>}
    <Field label="Work email" name="email" type="email" value={email} onChange={event=>setEmail(event.target.value)} readOnly={sent} autoComplete="email" full/>
    {sent && <>
      <Field label="Reset code" name="otp" inputMode="numeric" pattern="[0-9]+" autoComplete="one-time-code" full/>
      <Field label="New password" name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" hint="Use 12 characters or more." full/>
      <Field label="Confirm new password" name="confirmPassword" type="password" minLength={12} maxLength={256} autoComplete="new-password" full/>
    </>}
    <div className="field full"><Button type="submit" kind="btn-primary" disabled={busy}>{busy ? 'Working…' : sent ? 'Reset password' : 'Send reset code'}</Button></div>
    {sent && <><button className="auth-switch" type="button" onClick={resend} disabled={busy}>Resend reset code</button><button className="auth-switch" type="button" onClick={()=>{setSent(false);setError('');}} disabled={busy}>Use a different email</button></>}
    <button className="auth-switch" type="button" onClick={onCancel} disabled={busy}>Back to sign in</button>
  </form>;
}
