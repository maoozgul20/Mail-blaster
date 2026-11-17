#!/usr/bin/env node
// Builds the dashboard with the public API/Supabase URLs baked in and publishes it to Cloudflare Pages (free).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnv, need, root } from './env.mjs';

const env = loadEnv();
need(env, ['API_BASE_URL']);
const dash = join(root, 'dashboard');
const sh = process.platform === 'win32';
const buildEnv = { ...process.env, VITE_API_BASE_URL: env.API_BASE_URL.replace(/\/$/, ''), VITE_SUPABASE_URL: env.SUPABASE_URL ?? '', VITE_SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY ?? '' };
let r = spawnSync('npm', ['run', 'build'], { cwd: dash, stdio: 'inherit', shell: sh, env: buildEnv });
if (r.status !== 0) process.exit(r.status ?? 1);
const project = env.PAGES_PROJECT || 'mailblaster-dashboard';
// first run creates the project; --branch=main makes this the production deployment on the free *.pages.dev URL
r = spawnSync('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', 'main', '--commit-dirty=true'], { cwd: dash, stdio: 'inherit', shell: sh, env: process.env });
process.exit(r.status ?? 0);
