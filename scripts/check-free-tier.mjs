#!/usr/bin/env node
// Fails if the project configuration enables anything that is not part of the Cloudflare / Supabase free plans.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const toml = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const paidWorkerFeatures = [
  [/^\s*\[\[?queues/m, 'Cloudflare Queues require the Workers Paid plan'],
  [/^\s*\[\[?durable_objects/m, 'Durable Objects: keep off the free path unless you know the free limits'],
  [/^\s*\[limits\]/m, '[limits] (custom CPU limits) is a paid-plan feature'],
  [/usage_model\s*=/m, 'usage_model is a legacy paid setting'],
  [/^\s*\[\[?(r2_buckets|d1_databases|vectorize|hyperdrive|ai)\b/m, 'extra Cloudflare products are not needed and may bill'],
  [/^\s*\[(placement|smart_placement)/m, 'Smart Placement is not needed'],
  [/^\s*route(s)?\s*=/m, 'custom routes/domains are not required (workers.dev is free)'],
];
for (const [re, msg] of paidWorkerFeatures) if (re.test(toml)) problems.push(`worker/wrangler.toml: ${msg}`);
const cronCount = (toml.match(/"[^"\n]*\*[^"\n]*"/g) ?? []).length;
if (cronCount > 5) problems.push(`worker/wrangler.toml: ${cronCount} cron triggers (free plan allows 5)`);

// secrets must never be committed
for (const f of ['.env', 'worker/.dev.vars', 'dashboard/.env', 'dashboard/.env.local']) {
  if (existsSync(join(root, f))) {
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    const base = f.split('/').pop();
    if (!gi.includes(base)) problems.push(`${f} exists but is not git-ignored`);
  }
}
if (/SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']?ey/.test(readFileSync(join(root, 'worker/wrangler.toml'), 'utf8'))) problems.push('service role key must never be in wrangler.toml');

if (problems.length) {
  console.error('FREE-TIER CHECK FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('free-tier check passed: no paid Cloudflare features configured, secrets are not committed.');
