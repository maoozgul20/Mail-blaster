import * as React from 'react';
import { bg, call, getConfig, setConfig, DEFAULTS } from '../chrome-api';
import { CSS } from './styles';
import { LoginForm } from './LoginForm';

/** Shared UI for the toolbar popup and the options page. */
export function App({ mode }: { mode: 'popup' | 'options' }) {
  const [st, setSt] = React.useState<{ signedIn: boolean; email: string | null; config: { apiBaseUrl: string; dashboardUrl: string } } | null>(null);
  const [api, setApi] = React.useState('');
  const [dash, setDash] = React.useState('');
  const [note, setNote] = React.useState('');
  const refresh = React.useCallback(async () => {
    const s = await bg<any>({ type: 'status' }); setSt(s); setApi(s.config.apiBaseUrl); setDash(s.config.dashboardUrl);
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  async function saveConfig() {
    try {
      const a = new URL(api), d = new URL(dash);
      if (!/^https:$/.test(a.protocol) && a.hostname !== 'localhost') throw new Error('The API URL must use https://');
      const granted = await chrome.permissions.request({ origins: [`${a.origin}/*`] }).catch(() => false);
      if (!granted && !(chrome.runtime.getManifest().host_permissions ?? []).some((h: string) => h.startsWith(a.origin))) throw new Error('Permission to contact that API address was not granted.');
      await setConfig({ apiBaseUrl: a.origin, dashboardUrl: d.origin });
      setNote('Saved.'); refresh();
    } catch (e) { setNote((e as Error).message); }
  }

  return (
    <div className="mb" style={{ width: mode === 'popup' ? 340 : 'auto', maxWidth: 520, margin: mode === 'options' ? '32px auto' : 0, padding: 14, background: '#0f1426', minHeight: mode === 'popup' ? 0 : '100vh' }}>
      <style>{CSS}</style>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>✉ MailBlaster AI</h2>
      {!st ? <p className="muted">Loading…</p> : st.signedIn ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p>Signed in as <b>{st.email}</b></p>
          <p className="muted">Open Gmail and click <b>Compose</b>: the MailBlaster button appears next to Send.</p>
          <button className="btn primary" onClick={() => bg({ type: 'openTab', url: '/' })}>Open dashboard</button>
          <button className="btn" onClick={async () => { await call('logout'); refresh(); }}>Sign out</button>
        </div>
      ) : <LoginForm onDone={refresh} />}
      {mode === 'options' && st && (
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Cloud connection</h3>
          <p className="muted">The extension talks to your deployed Cloudflare Worker, never to localhost. Your campaigns keep running when Chrome is closed.</p>
          <div><label htmlFor="api">API URL (Cloudflare Worker)</label><input id="api" type="url" value={api} onChange={(e) => setApi(e.target.value)} /></div>
          <div><label htmlFor="dash">Dashboard URL (Cloudflare Pages)</label><input id="dash" type="url" value={dash} onChange={(e) => setDash(e.target.value)} /></div>
          <div className="row"><button className="btn" onClick={saveConfig}>Save</button><button className="btn" onClick={() => { setApi(DEFAULTS.apiBaseUrl); setDash(DEFAULTS.dashboardUrl); }}>Reset to build defaults</button></div>
          {note && <div className="msg i">{note}</div>}
        </div>
      )}
    </div>
  );
}
