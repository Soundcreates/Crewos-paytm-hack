import { useState } from 'react';
import { api, neonAuth } from '../lib/api.js';
import { formObject } from '../lib/format.js';
import { Brand, Button, Field, IconButton } from '../components/ui.jsx';

import {WorkExample} from '../components/WorkExample.jsx';
import {useAppearance} from '../lib/appearance.jsx';
import {PasswordReset} from '../components/PasswordReset.jsx';

export function AuthView({ invite, signedIn, authProvider, onComplete, notify }) {
  const {theme,toggleTheme}=useAppearance();
  const [mode, setMode] = useState(invite ? 'join' : 'login');
  const [working, setWorking] = useState(false),[error,setError]=useState('');
  const [awaitingOtp, setAwaitingOtp] = useState(null);
  const [resetting, setResetting] = useState(false);
  async function finishNeonFlow(email) {
    if (mode === 'signup') await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email }) });
    else if (mode === 'join') await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: invite }) });
    else if (invite) await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: invite }) });
    else await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email }) });
  }
  async function submit(event) {
    event.preventDefault();setError('');setWorking(true);
    const form = event.currentTarget, values = formObject(form);
    try {
      if (authProvider === 'neon') {
        const email = String(values.email).trim().toLowerCase();
        if (mode === 'signup') {
          const pending = { name: values.name, email, organization: values.organization };
          await api('/api/auth/signup-intent', { method: 'POST', body: JSON.stringify(pending) });
          await neonAuth('sign-up/email', { body: { ...pending, password: values.password } });
        } else if (mode === 'join') {
          await neonAuth('sign-up/email', { body: { name: values.name, email, password: values.password } });
        } else {
          await neonAuth('sign-in/email', { body: { email, password: values.password } });
        }
        const current = await neonAuth('get-session', { method: 'GET' });
        if (!current?.user?.emailVerified) {
          setWorking(false);
          setAwaitingOtp({ email, password: values.password });
          notify('Enter the verification code we emailed you.');
          return;
        }
        await finishNeonFlow(email);
      } else if (mode === 'signup') await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(values) });
      else if (mode === 'join') await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ ...values, token: invite }) });
      else {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
        if (invite) await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: invite }) });
      }
      if (invite) history.replaceState({}, '', '/');
      await onComplete(mode === 'signup' ? 'chief' : null); notify(mode === 'signup' ? 'Workspace created. Meet Chief to shape your team.' : mode === 'join' ? 'Invitation accepted.' : 'You’re signed in.');
    } catch (error) {
      if (authProvider === 'neon' && String(error.code).toUpperCase() === 'EMAIL_NOT_VERIFIED') {
        const email = String(values.email).trim().toLowerCase();
        setAwaitingOtp({ email, password: values.password });
        try { await neonAuth('email-otp/send-verification-otp', { body: { email, type: 'email-verification' } }); }
        catch (failure) { setError(failure.message); }
      } else setError(error.message);
      setWorking(false);
    }
  }
  async function verifyOtp(event) {
    event.preventDefault();setError('');setWorking(true);
    const otp = String(formObject(event.currentTarget).otp || '').trim();
    try {
      await neonAuth('email-otp/verify-email', { body: { email: awaitingOtp.email, otp } });
      await neonAuth('sign-in/email', { body: { email: awaitingOtp.email, password: awaitingOtp.password } });
      const current = await neonAuth('get-session', { method: 'GET' });
      if (!current?.user?.emailVerified) throw new Error('Email verified, but Neon Auth did not start a verified session. Sign in again.');
      await finishNeonFlow(awaitingOtp.email);
      setAwaitingOtp(null);
      if (invite) history.replaceState({}, '', '/');
      await onComplete(mode === 'signup' ? 'chief' : null); notify(mode === 'signup' ? 'Workspace created. Meet Chief to shape your team.' : mode === 'join' ? 'Invitation accepted.' : 'You’re signed in.');
    } catch (error) { setError(error.message); setWorking(false); }
  }
  async function resendOtp() {
    setWorking(true); setError('');
    try { await neonAuth('email-otp/send-verification-otp', { body: { email: awaitingOtp.email, type: 'email-verification' } }); notify('Sent a new code.'); }
    catch (error) { setError(error.message); }
    finally { setWorking(false); }
  }
  async function acceptExisting() {
    setWorking(true);
    try { await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: invite }) }); history.replaceState({}, '', '/'); await onComplete(); notify('Invitation accepted.'); }
    catch (error) { setError(error.message); setWorking(false); }
  }
  const title = resetting ? 'Reset your password' : awaitingOtp ? 'Check your email' : invite ? 'Accept your invitation' : mode === 'signup' ? 'Create your workspace' : 'Sign in to CrewOS';
  const copy = resetting ? 'We’ll send a reset code to your workspace email.' : awaitingOtp ? `Enter the verification code we sent to ${awaitingOtp.email}.` : invite ? 'Join your team workspace. Use a password of at least 12 characters.' : mode === 'signup' ? 'Create an account to hire and manage your AI employees.' : 'Use your workspace email and password.';
  const label = invite ? mode === 'login' ? 'Sign in and join' : 'Create account and join' : mode === 'signup' ? 'Create workspace' : 'Sign in';
  return <main className="auth-layout"><section className="auth-story"><div className="auth-brand-row"><Brand/><IconButton label={theme==='dark'?'Switch to light mode':'Switch to dark mode'} icon={theme==='dark'?'sun':'moon'} onClick={toggleTheme}/></div><div className="story-content"><h1>A workspace<br/>for your AI team<span className="accent-dot">.</span></h1><p>Define roles, test them in probation, and review the work they deliver.</p><WorkExample/></div><div className="story-foot"><span>Roles. Work. Evidence.</span><span>CrewOS</span></div></section><section className="auth-panel"><div className="auth-box"><h2>{title}</h2><p>{copy}</p>{error&&<p className="form-error" role="alert">{error}</p>}{resetting ? <PasswordReset notify={notify} onCancel={()=>{setResetting(false);setMode('login');setError('');}}/> : awaitingOtp ? <form onSubmit={verifyOtp} className="form-grid"><Field label="Verification code" name="otp" inputMode="numeric" pattern="[0-9]+" autoComplete="one-time-code"/><div className="field full"><Button type="submit" kind="btn-primary" disabled={working}>Verify email</Button></div><button type="button" className="auth-switch" onClick={resendOtp} disabled={working}>Resend code</button><button type="button" className="auth-switch" onClick={() => setAwaitingOtp(null)} disabled={working}>Use a different email</button></form> : <>{!invite && <div className="auth-tabs"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button><button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Create workspace</button></div>}{invite && !signedIn && <button type="button" className="auth-switch" onClick={() => setMode(mode === 'join' ? 'login' : 'join')}>{mode === 'join' ? 'Already have an account? Sign in' : 'Create an account to join'}</button>}{invite && signedIn ? <Button kind="btn-primary" onClick={acceptExisting} disabled={working}>Accept with {signedIn.email}</Button> : <form onSubmit={submit} className="form-grid">{(mode === 'signup' || mode === 'join') && <Field label="Your name" name="name" autoComplete="name"/>}{mode === 'signup' && <Field label="Organization" name="organization" autoComplete="organization"/>}<Field label="Work email" name="email" type="email" autoComplete="email"/><Field label="Password" name="password" type="password" minLength={mode === 'login' ? 1 : 12} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} hint={mode === 'login' ? '' : 'Use 12 characters or more.'}/><div className="field full"><Button type="submit" kind="btn-primary" disabled={working}>{label}</Button></div></form>}{authProvider==='neon' && mode==='login' && !signedIn && <button type="button" className="auth-switch" disabled={working} onClick={()=>{setResetting(true);setError('');}}>Forgot password?</button>}</>}</div></section></main>;
}
