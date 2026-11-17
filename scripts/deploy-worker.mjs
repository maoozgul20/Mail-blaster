#!/usr/bin/env node
// Configures wrangler.toml [vars] from .env, uploads the 4 secrets to Cloudflare, and deploys the Worker (free plan).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnv, need, root } from './env.mjs';

const env = loadEnv();
need(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ENCRYPTION_KEY', 'API_BASE_URL', 'FRONTEND_URL']);
if (Buffer.from(env.ENCRYPTION_KEY, 'base64').length !== 32) { console.error('ENCRYPTION_KEY must be 32 random bytes, base64 encoded. Run: node scripts/gen-key.mjs'); process.exit(1); }
const redirect = env.GOOGLE_REDIRECT_URI || `${env.API_BASE_URL.replace(/\/$/, '')}/oauth/google/callback`;

// 1. non-secret vars -> wrangler.toml
const file = join(root, 'worker/wrangler.toml');
let toml = readFileSync(file, 'utf8');
const vars = { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY, API_BASE_URL: env.API_BASE_URL.replace(/\/$/, ''), FRONTEND_URL: env.FRONTEND_URL.replace(/\/$/, ''), GOOGLE_REDIRECT_URI: redirect };
for (const k of ['ALLOW_SIGNUPS', 'ALLOWED_EXTENSION_IDS', 'MAX_JOBS_PER_RUN']) if (env[k]) vars[k] = env[k];
for (const [k, v] of Object.entries(vars)) {
  const re = new RegExp(`^#?\\s*${k}\\s*=.*$`, 'm');
  const line = `${k} = ${JSON.stringify(v)}`;
  toml = re.test(toml) ? toml.replace(re, line) : toml.replace(/(\[vars\][^\n]*\n)/, `$1${line}\n`);
}
writeFileSync(file, toml);
console.log('wrangler.toml [vars] updated.');

// 2. secrets (value passed through stdin, never on the command line or in logs)
const run = (args, input) => spawnSync('npx', ['wrangler', ...args], { cwd: join(root, 'worker'), input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], shell: process.platform === 'win32', env: { ...process.env } });
const first = run(['deploy'], undefined); // creates the Worker if it does not exist yet (secrets need an existing Worker)
if (first.status !== 0) process.exit(first.status ?? 1);
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ENCRYPTION_KEY']) {
  const r = run(['secret', 'put', k], env[k]);
  if (r.status !== 0) { console.error(`failed to set secret ${k}`); process.exit(1); }
}
console.log('\nWorker deployed and secrets stored. Check it:  ' + vars.API_BASE_URL + '/health');
console.log('Remember: Google redirect URI to authorize = ' + redirect);
