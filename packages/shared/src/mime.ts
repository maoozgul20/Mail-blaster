import { toB64 } from './crypto';

export interface MimeAttachment { filename: string; contentType: string; data: Uint8Array }

export interface MimeInput {
  from: { email: string; name?: string | null };
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string; // without angle brackets
  inReplyTo?: string | null; // message-id of previous message (with or without <>)
  references?: string | null;
  headers?: Record<string, string>;
  attachments?: MimeAttachment[];
  date?: Date;
}

const enc = new TextEncoder();
/** CR/LF in a header value would allow header injection (e.g. via CSV data): remove them. */
const clean = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ').trim();
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, '$1\r\n');
const angle = (id: string) => (id.startsWith('<') ? id : `<${id}>`);

/** RFC 2047 encoded-word, split on code point boundaries so multi-byte characters are never cut. */
export function encodeHeaderValue(v: string): string {
  const s = clean(v);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (enc.encode(cur + ch).length > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${toB64(enc.encode(w))}?=`).join('\r\n ');
}

function formatAddress(a: { email: string; name?: string | null }): string {
  const name = clean(a.name ?? '').replace(/["\\]/g, '');
  const email = clean(a.email);
  if (!name) return email;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${email}>` : `${encodeHeaderValue(name)} <${email}>`;
}

const boundary = () => `mb_${crypto.randomUUID().replace(/-/g, '')}`;
const part = (type: string, body: string) =>
  `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(toB64(enc.encode(body)))}`;

/** Builds one RFC 5322 message for ONE recipient. There is deliberately no Cc/Bcc support. */
export function buildMime(m: MimeInput): string {
  const h: string[] = [];
  h.push(`From: ${formatAddress(m.from)}`);
  h.push(`To: ${clean(m.to)}`);
  h.push(`Subject: ${encodeHeaderValue(m.subject)}`);
  h.push(`Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`);
  h.push(`Message-ID: ${angle(clean(m.messageId))}`);
  if (m.inReplyTo) h.push(`In-Reply-To: ${angle(clean(m.inReplyTo))}`);
  if (m.references) h.push(`References: ${clean(m.references)}`);
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(k)) h.push(`${k}: ${clean(v)}`);
  }
  h.push('MIME-Version: 1.0');

  const altB = boundary();
  const alt =
    `--${altB}\r\n${part('text/plain', m.text)}\r\n` +
    `--${altB}\r\n${part('text/html', m.html)}\r\n` +
    `--${altB}--`;

  if (!m.attachments?.length) {
    h.push(`Content-Type: multipart/alternative; boundary="${altB}"`);
    return `${h.join('\r\n')}\r\n\r\n${alt}\r\n`;
  }
  const mixB = boundary();
  h.push(`Content-Type: multipart/mixed; boundary="${mixB}"`);
  let body = `--${mixB}\r\nContent-Type: multipart/alternative; boundary="${altB}"\r\n\r\n${alt}\r\n`;
  for (const a of m.attachments) {
    const fn = clean(a.filename).replace(/["\\]/g, '_');
    body +=
      `--${mixB}\r\nContent-Type: ${clean(a.contentType) || 'application/octet-stream'}; name="${fn}"\r\n` +
      `Content-Disposition: attachment; filename="${fn}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(toB64(a.data))}\r\n`;
  }
  body += `--${mixB}--`;
  return `${h.join('\r\n')}\r\n\r\n${body}\r\n`;
}
