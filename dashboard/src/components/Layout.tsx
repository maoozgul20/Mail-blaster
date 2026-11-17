import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BarChart3, Bell, FileText, LayoutDashboard, LogOut, Mail, Menu, PlusCircle, Repeat, Settings, ShieldBan, Users, X, KeyRound, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, timeAgo } from '@/lib/utils';
import { Button } from './ui';
import { Orbs, PageTransition } from './motion';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/campaigns', label: 'Campaigns', icon: Send, end: true },
  { to: '/campaigns/new', label: 'New Campaign', icon: PlusCircle },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/follow-ups', label: 'Follow-ups', icon: Repeat },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/suppression', label: 'Suppression List', icon: ShieldBan },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings, end: true },
  { to: '/settings/account', label: 'Account & Integrations', icon: KeyRound },
];

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="gradient-bg grid h-9 w-9 place-items-center rounded-xl shadow-lg shadow-indigo-900/40 transition-transform duration-300 hover:rotate-6 hover:scale-110"><Mail className="h-5 w-5 text-white" /></div>
      <span className="text-lg font-semibold tracking-tight">MailBlaster <span className="gradient-text">AI</span></span>
    </div>
  );
}

function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const qc = useQueryClient();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(), enabled: open });
  const unread = me?.unread_notifications ?? 0;
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => setOpen((o) => !o)}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold">{unread > 9 ? '9+' : unread}</span>}
      </Button>
      {open && (
        <div className="glass absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-card/95 p-2 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm font-medium">Notifications</span>
            <Button size="sm" variant="ghost" onClick={async () => { await api.markNotificationsRead(); qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Mark all read</Button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {q.data?.rows.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet</p>}
            {q.data?.rows.map((n) => (
              <div key={n.id} className={cn('rounded-md px-3 py-2 text-sm', !n.read_at && 'bg-primary/10')}>
                <p className="font-medium">{n.title}</p>
                {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{timeAgo(n.created_at)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = React.useState(false);
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  React.useEffect(() => setOpen(false), [loc.pathname]);
  const account = me?.accounts.find((a) => a.status === 'active');
  const needsReauth = me?.accounts.some((a) => a.status === 'reauth_required');

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-5 py-5"><Logo /></div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={!!n.end}
            className={({ isActive }) => cn('group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-all duration-200 hover:translate-x-0.5 hover:bg-white/5 hover:text-foreground', isActive && 'bg-gradient-to-r from-primary/25 to-secondary/10 text-foreground ring-1 ring-primary/30 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-gradient-to-b before:from-indigo-300 before:to-fuchsia-400')}>
            <n.icon className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />{n.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-border/60 p-4 text-xs">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', account ? 'bg-emerald-400' : needsReauth ? 'bg-amber-400' : 'bg-rose-400')} />
          <span className="text-muted-foreground">{account ? 'Connected' : needsReauth ? 'Reauthorization needed' : 'Gmail not connected'}</span>
        </div>
        <p className="mt-1 truncate font-medium">{account?.email ?? me?.user.email}</p>
        <Button variant="ghost" size="sm" className="mt-2 -ml-2" onClick={async () => { await signOut(); nav('/login'); }}><LogOut className="h-3.5 w-3.5" /> Sign out</Button>
      </div>
    </div>
  );

  return (
    <div className="relative flex min-h-screen">
      <Orbs />
      <aside className="sticky top-0 z-20 hidden h-screen w-64 shrink-0 border-r border-border/60 bg-card/40 backdrop-blur lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-in border-r border-border bg-card">{sidebar}</aside>
        </div>
      )}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</Button>
          <div className="lg:hidden"><Logo /></div>
          <div className="ml-auto flex items-center gap-1"><NotificationBell /></div>
        </header>
        {needsReauth && (
          <div className="border-b border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100 lg:px-8">
            Google authorization expired or was revoked, so sending is on hold. <NavLink className="font-medium underline" to="/settings/account">Reconnect Gmail</NavLink>
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8"><PageTransition><Outlet /></PageTransition></main>
      </div>
    </div>
  );
}
