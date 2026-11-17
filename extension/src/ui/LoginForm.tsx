import * as React from 'react';
import { call } from '../chrome-api';

export function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  return (
    <form className="in" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      try { await call('login', email, password); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="muted">Sign in with your MailBlaster dashboard account (not your Google password).</p>
      <div><label htmlFor="mb-email">Email</label><input id="mb-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
      <div><label htmlFor="mb-pw">Password</label><input id="mb-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
      {err && <div className="msg e" role="alert">{err}</div>}
      <button className="btn primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
