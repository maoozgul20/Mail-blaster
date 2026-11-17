import { ApiClient, type Session } from '@mailblaster/shared';

const KEY = 'mailblaster.session';
const listeners = new Set<(s: Session | null) => void>();

export const readSession = (): Session | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
};
const writeSession = (s: Session | null) => {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l(s));
};
export const onSession = (l: (s: Session | null) => void) => { listeners.add(l); return () => listeners.delete(l); };

export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export const api = new ApiClient({ baseUrl: API_BASE_URL, getSession: readSession, setSession: writeSession });
