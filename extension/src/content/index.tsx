import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CSS } from '../ui/styles';
import { Panel } from '../ui/Panel';
import { bg } from '../chrome-api';
import { findComposes, type Compose } from './gmail';

/** Each UI piece lives in its own Shadow DOM so Gmail's CSS cannot affect it (and ours cannot leak into Gmail). */
function shadowHost(id: string): { host: HTMLElement; mount: HTMLElement } {
  const host = document.createElement('div');
  host.id = id;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const mount = document.createElement('div');
  mount.className = 'mb';
  shadow.append(style, mount);
  return { host, mount };
}

const seen = new WeakSet<HTMLElement>();
const panels = new Map<HTMLElement, { root: Root; host: HTMLElement }>();

function togglePanel(c: Compose) {
  const existing = panels.get(c.root);
  if (existing) { existing.root.unmount(); existing.host.remove(); panels.delete(c.root); return; }
  const { host, mount } = shadowHost('mailblaster-panel');
  document.body.appendChild(host);
  const root = createRoot(mount);
  panels.set(c.root, { root, host });
  root.render(<Panel compose={c} onClose={() => togglePanel(c)} />);
}

function mountLauncher(c: Compose) {
  const { host, mount } = shadowHost('mailblaster-launcher');
  host.style.display = 'inline-block';
  const btn = document.createElement('button');
  btn.className = 'launch';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'MailBlaster campaign options');
  btn.innerHTML = '✉ MailBlaster <span aria-hidden="true">▲</span>';
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(c); });
  mount.appendChild(btn);
  const send = c.sendButton();
  const anchor = send?.closest<HTMLElement>('.dC') ?? send?.parentElement;
  if (anchor) anchor.insertAdjacentElement('afterend', host);
  else { host.style.cssText = 'position:absolute;right:12px;bottom:12px;z-index:5'; c.root.appendChild(host); }
}

function scan() {
  for (const c of findComposes()) {
    if (seen.has(c.root)) continue;
    // wait until Gmail has rendered the toolbar with the Send button
    if (!c.sendButton() && !c.root.dataset.mbWait) { c.root.dataset.mbWait = '1'; setTimeout(scan, 600); continue; }
    seen.add(c.root);
    mountLauncher(c);
  }
}

/** Small always-visible status pill + menu shown whenever Gmail is open. */
async function mountGlobalPill() {
  if (document.getElementById('mailblaster-pill')) return;
  const { host, mount } = shadowHost('mailblaster-pill');
  document.body.appendChild(host);
  const root = createRoot(mount);
  function Pill() {
    const [st, setSt] = React.useState<{ signedIn: boolean; email: string | null } | null>(null);
    const [open, setOpen] = React.useState(false);
    const refresh = () => bg<{ signedIn: boolean; email: string | null }>({ type: 'status' }).then(setSt).catch(() => setSt({ signedIn: false, email: null }));
    React.useEffect(() => { refresh(); }, []);
    return (<>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { bg({ type: 'openTab', url: '/' }); setOpen(false); }}>Open dashboard</button>
          <button role="menuitem" onClick={() => { bg({ type: 'openTab', url: '/campaigns/new' }); setOpen(false); }}>New campaign (full editor)</button>
          <button role="menuitem" onClick={() => { bg({ type: 'openTab', url: '/campaigns' }); setOpen(false); }}>Campaigns</button>
          <button role="menuitem" onClick={() => { document.querySelector<HTMLElement>('div[role="button"][gh="cm"]')?.click(); setOpen(false); }}>Compose with MailBlaster</button>
        </div>)}
      <button className="pill-global" aria-haspopup="menu" aria-expanded={open} onClick={() => { refresh(); setOpen((o) => !o); }}>
        <span className={`dot ${st?.signedIn ? '' : 'off'}`} />MailBlaster AI · {st === null ? '…' : st.signedIn ? 'Connected' : 'Sign in'}
      </button></>);
  }
  root.render(<Pill />);
}

function init() {
  mountGlobalPill();
  scan();
  let t: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => {
    scan();
    // tear down panels whose compose window was closed
    for (const [rootEl, p] of [...panels]) if (!rootEl.isConnected) { p.root.unmount(); p.host.remove(); panels.delete(rootEl); }
  }, 250); }).observe(document.body, { childList: true, subtree: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
