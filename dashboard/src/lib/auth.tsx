import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me, Session } from '@mailblaster/shared';
import { api, onSession, readSession } from './api';

interface AuthCtx { session: Session | null; me: Me | undefined; loading: boolean; refreshMe: () => Promise<unknown>; signOut: () => Promise<void> }
const Ctx = React.createContext<AuthCtx>(null as never);
export const useAuth = () => React.useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = React.useState<Session | null>(readSession());
  React.useEffect(() => { const off = onSession((s) => { setSession(s); if (!s) qc.clear(); }); return () => { off(); }; }, [qc]);
  const q = useQuery({ queryKey: ['me'], queryFn: () => api.me(), enabled: !!session, staleTime: 30_000, retry: false });
  const value = React.useMemo<AuthCtx>(() => ({
    session, me: q.data, loading: !!session && q.isLoading,
    refreshMe: () => q.refetch(), signOut: () => api.logout(),
  }), [session, q.data, q.isLoading, q.refetch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
