import * as React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Mail, ShieldCheck, Clock, Repeat } from 'lucide-react';
import { api, API_BASE_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { errMsg } from '@/components/toast';
import { Logo } from '@/components/Layout';
import { Orbs } from '@/components/motion';

export default function Login() {
  const { session } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = React.useState<'login' | 'signup'>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [info, setInfo] = React.useState('');
  if (session) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setInfo('');
    try {
      if (mode === 'login') { await api.login(email, password); nav('/'); }
      else {
        const r = await api.signup(email, password, name || undefined);
        if (r.needs_confirmation) { setInfo('Account created. Check your inbox to confirm your email address, then sign in.'); setMode('login'); }
        else nav('/');
      }
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <div className="relative grid min-h-screen lg:grid-cols-2">
      <Orbs />
      <div className="relative z-10 hidden flex-col justify-between p-12 lg:flex">
        <Logo />
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">Personal outreach, <span className="gradient-text">sent one by one</span>, from your own Gmail.</h2>
          <ul className="stagger space-y-4 text-muted-foreground">
            {[{ I: Mail, t: 'Every recipient gets an individual, personalised email' }, { I: Clock, t: 'Randomised pacing that keeps running when your computer is off' }, { I: Repeat, t: 'Automatic follow-ups that stop the moment someone replies' }, { I: ShieldCheck, t: 'Your Gmail tokens are encrypted; unsubscribes are honoured automatically' }].map(({ I, t }) => (
              <li key={t} className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/20 text-indigo-200 transition-transform hover:scale-110 hover:rotate-3"><I className="h-4 w-4" /></span>{t}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">Runs entirely on free tiers: Cloudflare Workers + Pages and Supabase.</p>
      </div>
      <div className="relative z-10 flex items-center justify-center p-6">
        <Card className="w-full max-w-md animate-pop-in p-8">
          <div className="mb-6 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="mb-6 mt-1 text-sm text-muted-foreground">{mode === 'login' ? 'Sign in to manage your campaigns.' : 'This account is separate from your Gmail account.'}</p>
          {!API_BASE_URL && <Alert tone="error" className="mb-4" title="API URL missing">Set VITE_API_BASE_URL when building the dashboard (see DEPLOYMENT.md).</Alert>}
          {info && <Alert tone="success" className="mb-4">{info}</Alert>}
          {error && <Alert tone="error" className="mb-4">{error}</Alert>}
          <form onSubmit={submit} className="space-y-4">
            {mode === 'signup' && <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
            <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
            <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}><Input type="password" required minLength={mode === 'signup' ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
            <Button className="w-full" loading={busy} type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</Button>
          </form>
          <button className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>
            {mode === 'login' ? "No account yet? Create one" : 'Already have an account? Sign in'}
          </button>
        </Card>
      </div>
    </div>
  );
}
