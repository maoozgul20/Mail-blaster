import * as React from 'react';
import { call } from '../chrome-api';

/** Sign in OR create a MailBlaster account (the same account the dashboard uses; it is separate from your Google account). */
export function LoginForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = React.useState<'login' | 'signup'>('login');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [info, setInfo] = React.useState('');
  const signup = mode === 'signup';
  return (
    <form className="in form" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(''); setInfo('');
      try {
        if (signup) {
          const r = await call<{ needs_confirmation: boolean }>('signup', email, password, name || undefined);
          if (r.needs_confirmation) { setInfo('Account created. Check your inbox and click the confirmation link, then sign in here.'); setMode('login'); return; }
        } else await call('login', email, password);
        onDone();
      } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="muted">{signup ? 'Create your MailBlaster account. It is separate from your Google account.' : 'Sign in with your MailBlaster dashboard account (not your Google password).'}</p>
      {signup && <div><label htmlFor="mb-name">Name (optional)</label><input id="mb-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>}
      <div><label htmlFor="mb-email">Email</label><input id="mb-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
      <div><label htmlFor="mb-pw">Password</label><input id="mb-pw" type="password" required minLength={signup ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} />{signup && <span className="muted">At least 8 characters</span>}</div>
      {info && <div className="msg s" role="status">{info}</div>}
      {err && <div className="msg e" role="alert">{err}</div>}
      <button className="btn primary" disabled={busy} type="submit">{busy ? (signup ? 'Creating…' : 'Signing in…') : signup ? 'Create account' : 'Sign in'}</button>
      <button type="button" className="link" onClick={() => { setMode(signup ? 'login' : 'signup'); setErr(''); setInfo(''); }}>
        {signup ? 'Already have an account? Sign in' : 'No account yet? Create one'}
      </button>
    </form>
  );
}
