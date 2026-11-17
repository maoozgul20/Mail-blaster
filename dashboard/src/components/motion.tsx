import * as React from 'react';
import { useLocation } from 'react-router-dom';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Smoothly counts from the previous value to the new one (instant with reduced motion). */
export function CountUp({ value, suffix = '', duration = 800 }: { value: number; suffix?: string; duration?: number }) {
  const [shown, setShown] = React.useState(reduced() ? value : 0);
  const from = React.useRef(0);
  React.useEffect(() => {
    if (reduced()) { setShown(value); return; }
    const start = performance.now(); const a = from.current; let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration); const e = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * e));
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown.toLocaleString()}{suffix}</>;
}

/** Fades/slides the page in on navigation. Does not remount (so the campaign editor keeps its state when autosave changes the URL). */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const prev = React.useRef(pathname);
  React.useEffect(() => {
    const editor = (p: string) => p === '/campaigns/new' || /^\/campaigns\/[^/]+\/edit$/.test(p);
    const skip = editor(prev.current) && editor(pathname);
    prev.current = pathname;
    if (skip || reduced() || !ref.current?.animate) return;
    ref.current.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, [pathname]);
  return <div ref={ref}>{children}</div>;
}

export const Orbs = () => (<div className="orbs" aria-hidden="true"><i className="orb a" /><i className="orb b" /><i className="orb c" /></div>);
