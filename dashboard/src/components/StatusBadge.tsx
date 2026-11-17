import { Badge } from './ui';

const TONES: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  draft: 'neutral', scheduled: 'blue', queued: 'indigo', running: 'green', paused: 'amber', completed: 'violet', cancelled: 'neutral', failed: 'red',
  pending: 'neutral', sent: 'blue', drafted: 'violet', skipped: 'neutral', bounced: 'red', unsubscribed: 'amber', active: 'green',
  reauth_required: 'amber', disconnected: 'neutral', error: 'red', ambiguous: 'amber',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={TONES[status] ?? 'neutral'} className="capitalize">{status.replace(/_/g, ' ')}</Badge>;
}
