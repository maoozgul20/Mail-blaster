import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader (KEY=value, # comments). Process environment variables win over the file. */
export function loadEnv() {
  const file = join(root, '.env');
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) };
}

export function need(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.error(`\nMissing in .env: ${missing.join(', ')}\nCopy .env.example to .env and fill these in (see INSTALL.md).\n`);
    process.exit(1);
  }
}
