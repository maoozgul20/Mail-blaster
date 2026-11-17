/** WebCrypto helpers (identical behaviour in Cloudflare Workers, browsers and Node 20+). */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toB64Url = (buf: ArrayBuffer | Uint8Array): string => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64Url = (s: string): Uint8Array<ArrayBuffer> => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
export const utf8ToB64Url = (s: string): string => toB64Url(enc.encode(s));
export const b64UrlToUtf8 = (s: string): string => dec.decode(fromB64Url(s));

// Derived/imported keys are immutable: cache per isolate to keep CPU time per invocation low on the free plan.
const keyCache = new Map<string, Promise<CryptoKey>>();
const cached = (k: string, make: () => Promise<CryptoKey>) => {
  let p = keyCache.get(k);
  if (!p) { p = make(); keyCache.set(k, p); p.catch(() => keyCache.delete(k)); }
  return p;
};

function aesKey(keyB64: string): Promise<CryptoKey> {
  return cached(`aes:${keyB64}`, () => importAes(keyB64));
}

async function importAes(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = fromB64(keyB64); } catch { raw = new Uint8Array(0); }
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (run: openssl rand -base64 32)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM, random 96-bit IV, output "v1.<iv>.<ciphertext+tag>". */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plaintext));
  return `v1.${toB64Url(iv)}.${toB64Url(ct)}`;
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const [v, iv, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported ciphertext format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(iv) }, await aesKey(keyB64), fromB64Url(ct));
  return dec.decode(pt);
}

/** Derive a purpose-specific HMAC key from the master secret (never reuse the AES key directly for signing). */
function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  return cached(`hmac:${purpose}:${secret}`, () => deriveHmac(secret, purpose));
}

async function deriveHmac(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mailblaster'), info: enc.encode(purpose) },
    base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'],
  );
}

export async function hmacSign(secret: string, purpose: string, data: string): Promise<string> {
  return toB64Url(await crypto.subtle.sign('HMAC', await hmacKey(secret, purpose), enc.encode(data)));
}

export async function hmacVerify(secret: string, purpose: string, data: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, purpose), fromB64Url(sig), enc.encode(data));
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 24): string => toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
