import { createApp } from './app';
import { productionDeps } from './deps';
import type { Env } from './env';
import { runInbound } from './inbound';
import { runScheduler } from './scheduler';

const app = createApp(productionDeps);

export default {
  fetch: app.fetch,

  /**
   * Cloudflare Cron Triggers (see wrangler.toml):
   *   "* * * * *"   -> send engine: claim due jobs from PostgreSQL, send through Gmail, record outcomes
   *   every 5 minutes -> inbound: reply/bounce detection (needs the optional read scope) + housekeeping
   * All state lives in PostgreSQL, so a missed or overlapping invocation can never lose or duplicate an email.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const deps = productionDeps;
    const store = deps.store(env);
    const getToken = deps.accessToken(env, store);
    const gmail = deps.gmail(env);
    const task = (async () => {
      if (event.cron === '*/5 * * * *') {
        const r = await runInbound({ store, gmail, getToken });
        await store.rpc('wk_cleanup', {}).catch(() => undefined);
        console.log('inbound', JSON.stringify(r));
        return;
      }
      const loader = deps.attachmentLoader(env);
      const maxJobs = Math.max(1, Math.min(10, Number((env as any).MAX_JOBS_PER_RUN ?? 3)));
      const r = await runScheduler(
        { store, gmail, env, getToken, loadAttachment: loader, workerId: `cron-${event.scheduledTime}` },
        { maxJobs },
      );
      console.log('scheduler', JSON.stringify(r));
    })().catch((e) => console.error('scheduled task failed', e));
    ctx.waitUntil(task);
  },
} satisfies ExportedHandler<Env>;
