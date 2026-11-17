// Builds the Chrome extension (Manifest V3) into ./dist and packs ./mailblaster-extension.zip
//   API_BASE_URL=https://mailblaster-api.<you>.workers.dev DASHBOARD_URL=https://<project>.pages.dev npm run build
// Values are also read from ../.env (see .env.example). The URLs are only DEFAULTS: they can be changed later in the extension options.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

function dotenv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }));
}
const env = { ...dotenv(join(root, '../.env')), ...dotenv(join(root, '.env')), ...process.env };
const API = (env.API_BASE_URL || 'https://mailblaster-api.your-subdomain.workers.dev').replace(/\/$/, '');
const DASH = (env.DASHBOARD_URL || env.FRONTEND_URL || 'https://mailblaster-dashboard.pages.dev').replace(/\/$/, '');
const apiOrigin = new URL(API).origin;
if (/your-subdomain/i.test(API)) console.warn('\n  ! API_BASE_URL is not set: the extension is built with a placeholder. Set the real URL in the extension options after installing.\n');

const define = {
  __API_BASE_URL__: JSON.stringify(API),
  __DASHBOARD_URL__: JSON.stringify(DASH),
  'process.env.NODE_ENV': JSON.stringify('production'),
};
const common = { configFile: false, logLevel: 'warn', plugins: [react()], define };

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. content script (single IIFE file, no external chunks: required for content scripts)
await build({ ...common, root, build: { outDir: dist, emptyOutDir: false, minify: true, lib: { entry: join(root, 'src/content/index.tsx'), formats: ['iife'], name: 'MailBlasterContent', fileName: () => 'content.js' } } });
// 2. background service worker
await build({ ...common, root, build: { outDir: dist, emptyOutDir: false, minify: true, lib: { entry: join(root, 'src/background.ts'), formats: ['iife'], name: 'MailBlasterBackground', fileName: () => 'background.js' } } });
// 3. popup + options pages
await build({ ...common, root, base: './', build: { outDir: dist, emptyOutDir: false, minify: true, rollupOptions: { input: { popup: join(root, 'popup.html'), options: join(root, 'options.html') } } } });

// 4. icons (generated, no binary assets in the repo)
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3; // supersampling
  const inRound = (x, y, w, r) => { const dx = Math.max(Math.abs(x - w / 2) - (w / 2 - r), 0), dy = Math.max(Math.abs(y - w / 2) - (w / 2 - r), 0); return dx * dx + dy * dy <= r * r; };
  const segDist = (px_, py, ax, ay, bx, by) => { const t = Math.max(0, Math.min(1, ((px_ - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); return Math.hypot(px_ - (ax + t * (bx - ax)), py - (ay + t * (by - ay))); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const fx = (x + (sx + 0.5) / S) / size, fy = (y + (sy + 0.5) / S) / size;
      if (!inRound(fx, fy, 1, 0.22)) continue;
      const t = (fx + fy) / 2;
      let cr = 79 + (124 - 79) * t, cg = 70 + (58 - 70) * t, cb = 229 + (237 - 229) * t;
      const w = 0.07; // envelope
      const inBody = fx > 0.2 && fx < 0.8 && fy > 0.3 && fy < 0.7;
      const edge = inBody && (fx < 0.2 + w || fx > 0.8 - w || fy < 0.3 + w || fy > 0.7 - w);
      const flap = inBody && (segDist(fx, fy, 0.2, 0.3, 0.5, 0.52) < w / 1.6 || segDist(fx, fy, 0.8, 0.3, 0.5, 0.52) < w / 1.6);
      if (edge || flap) { cr = cg = cb = 255; }
      r += cr; g += cg; b += cb; a += 255;
    }
    const n = S * S, o = (y * size + x) * 4;
    px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = a / n;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(join(dist, 'icons'), { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(join(dist, 'icons', `icon${s}.png`), png(s));

// 5. manifest (host permissions are derived from the configured API origin; nothing else is requested up front)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const manifest = {
  manifest_version: 3,
  name: 'MailBlaster AI',
  version: pkg.version,
  description: 'Personalised, individually-sent email campaigns from Gmail with scheduling, follow-ups and tracking. Runs in the cloud.',
  icons,
  action: { default_title: 'MailBlaster AI', default_popup: 'popup.html', default_icon: icons },
  options_page: 'options.html',
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['content.js'], run_at: 'document_idle' }],
  permissions: ['storage'],
  host_permissions: ['https://mail.google.com/*', `${apiOrigin}/*`],
  optional_host_permissions: ['https://*/*'],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 6. zip
const files = {};
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (!f.endsWith('.map')) files[relative(dist, p).replace(/\\/g, '/')] = readFileSync(p);
  }
})(dist);
writeFileSync(join(root, 'mailblaster-extension.zip'), zipSync(files, { level: 9 }));
console.log(`\n  extension built: ${Object.keys(files).length} files -> extension/dist and extension/mailblaster-extension.zip`);
console.log(`  API: ${API}\n  Dashboard: ${DASH}\n`);
