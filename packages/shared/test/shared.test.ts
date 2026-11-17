import { describe, it, expect } from 'vitest';
import {
  isValidEmail, renderTemplate, buildMergeData, extractVariables, findUnresolvedVariables, sanitizeEmailHtml, htmlToText,
  encryptSecret, decryptSecret, hmacSign, hmacVerify, buildMime, injectTracking, guessMapping, rowsToRecipients,
  parsePastedList, analyzeRecipients, resolveSchedulePreset, localInputToUtc, estimateDuration, zonedToUtc, DELAY_PRESETS,
  encodeHeaderValue, utcToLocalInput,
} from '../src';

describe('email validation', () => {
  it('accepts normal and rejects malformed addresses', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.com', 'X@EXAMPLE.COM']) expect(isValidEmail(ok), ok).toBe(true);
    for (const bad of ['', 'a', 'a@b', '@x.com', 'a b@x.com', 'a@x..com', 'a@-x.com', 'a@x.com\nBcc: evil@x.com', null, undefined])
      expect(isValidEmail(bad as any), String(bad)).toBe(false);
  });
});

describe('personalization', () => {
  const r = { email: 'ali@acme.test', first_name: 'Ali', last_name: 'Khan', company: 'Acme', fields: { CustomField1: 'VIP', 'Last Meeting': 'May' } };
  it('replaces all standard variables, custom fields and FullName', () => {
    const d = buildMergeData(r);
    const t = '{{FirstName}} {{LastName}} / {{FullName}} / {{Email}} / {{Company}} / {{Website}} / {{Position}} / {{CustomField1}} / {{CustomField2}} / {{last_meeting}}';
    expect(renderTemplate(t, d).text).toBe('Ali Khan / Ali Khan / ali@acme.test / Acme /  /  / VIP /  / May');
  });
  it('supports fallbacks and reports missing variables', () => {
    const d = buildMergeData({ email: 'x@y.com' });
    const out = renderTemplate('Hi {{FirstName|there}}, {{Company}}', d);
    expect(out.text).toBe('Hi there, ');
    expect(out.missing).toEqual(['Company']);
  });
  it('escapes merged values in HTML mode to stop injection from CSV data', () => {
    const d = buildMergeData({ email: 'x@y.com', first_name: '<img src=x onerror=alert(1)>' });
    expect(renderTemplate('<p>{{FirstName}}</p>', d, { html: true }).text).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });
  it('finds variables that no recipient can satisfy', () => {
    expect(extractVariables('{{A}} {{B|x}} {{ A }}').sort()).toEqual(['A', 'B']);
    expect(findUnresolvedVariables('{{FirstName}} {{Nope}} {{Opt|x}}', [r])).toEqual(['Nope']);
  });
});

describe('html helpers', () => {
  it('sanitises scripts, event handlers and javascript: URLs', () => {
    const dirty = '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">a</a><iframe src="//e"></iframe><img src=x onerror=alert(1)>';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|iframe/i);
    expect(clean).toContain('<p');
  });
  it('produces readable plain text with link targets', () => {
    expect(htmlToText('<p>Hello <b>you</b></p><p><a href="https://x.com">site</a></p>')).toBe('Hello you\nsite (https://x.com)');
  });
});

describe('crypto', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('AES-GCM round-trips and never repeats ciphertext', async () => {
    const a = await encryptSecret('refresh-token-123', key);
    const b = await encryptSecret('refresh-token-123', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token');
    expect(await decryptSecret(a, key)).toBe('refresh-token-123');
  });
  it('rejects tampering and wrong keys', async () => {
    const a = await encryptSecret('secret', key);
    const tampered = a.slice(0, -3) + (a.endsWith('AAA') ? 'BBB' : 'AAA');
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
    await expect(decryptSecret(a, Buffer.alloc(32, 9).toString('base64'))).rejects.toThrow();
    await expect(encryptSecret('x', 'short')).rejects.toThrow(/32 bytes/);
  });
  it('HMAC signatures verify only for the same data/purpose', async () => {
    const sig = await hmacSign('k', 'click', 'https://a.com');
    expect(await hmacVerify('k', 'click', 'https://a.com', sig)).toBe(true);
    expect(await hmacVerify('k', 'click', 'https://evil.com', sig)).toBe(false);
    expect(await hmacVerify('k', 'other', 'https://a.com', sig)).toBe(false);
    expect(await hmacVerify('k2', 'click', 'https://a.com', sig)).toBe(false);
    expect(await hmacVerify('k', 'click', 'https://a.com', '!!!')).toBe(false);
  });
});

describe('MIME', () => {
  it('builds a single-recipient multipart/alternative message without Cc/Bcc', () => {
    const raw = buildMime({ from: { email: 's@x.com', name: 'Sender' }, to: 'r@y.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', messageId: 'abc@mb' });
    expect(raw).toMatch(/^From: "Sender" <s@x.com>\r\nTo: r@y.com\r\nSubject: Hi\r\n/);
    expect(raw).toContain('Message-ID: <abc@mb>');
    expect(raw).toContain('multipart/alternative');
    expect(raw).not.toMatch(/^(Cc|Bcc):/mi);
    expect((raw.match(/^To:/gm) ?? []).length).toBe(1);
  });
  it('encodes non-ASCII subjects and neutralises header injection', () => {
    expect(encodeHeaderValue('Héllo 🌍')).toMatch(/^=\?UTF-8\?B\?/);
    const raw = buildMime({ from: { email: 's@x.com' }, to: 'r@y.com', subject: 'a\r\nBcc: evil@x.com', html: '', text: '', messageId: 'm' });
    expect(raw).not.toMatch(/^Bcc:/m);
  });
  it('threads follow-ups and adds attachments', () => {
    const raw = buildMime({
      from: { email: 's@x.com' }, to: 'r@y.com', subject: 'Re: Hi', html: 'h', text: 't', messageId: 'm2', inReplyTo: 'm1@x', references: '<m1@x>',
      headers: { 'List-Unsubscribe': '<https://u>' }, attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }],
    });
    expect(raw).toContain('In-Reply-To: <m1@x>');
    expect(raw).toContain('References: <m1@x>');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('filename="a.pdf"');
    expect(raw).toContain('List-Unsubscribe: <https://u>');
  });
});

describe('tracking injection', () => {
  it('rewrites links, skips the unsubscribe link, appends footer and pixel', async () => {
    const html = '<p><a href="https://a.com/x?y=1&amp;z=2">A</a> <a href="mailto:a@b.com">m</a> <a href="https://u.test/u/1">unsub</a></p>';
    const out = await injectTracking(html, {
      openPixelUrl: 'https://api/t/o/tok.gif', trackLink: async (u) => `https://api/t/c/tok?u=${encodeURIComponent(u)}`,
      unsubscribeUrl: 'https://u.test/u/1', unsubscribeText: 'Unsubscribe', disclosure: 'Tracked.',
    });
    expect(out).toContain('https://api/t/c/tok?u=https%3A%2F%2Fa.com%2Fx%3Fy%3D1%26z%3D2');
    expect(out).toContain('href="mailto:a@b.com"');
    expect(out).toContain('<img src="https://api/t/o/tok.gif"');
    expect(out).toContain('Tracked.');
    expect((out.match(/api\/t\/c/g) ?? []).length).toBe(1);
  });
});

describe('recipient import', () => {
  it('auto-maps columns and builds recipients with custom fields', () => {
    const headers = ['Email', 'FirstName', 'Company', 'Website', 'Notes'];
    const map = guessMapping(headers);
    expect(map).toEqual({ Email: 'email', FirstName: 'first_name', Company: 'company', Website: 'website', Notes: 'custom' });
    const rs = rowsToRecipients([{ Email: 'ALI@x.com', FirstName: 'Ali', Company: 'Acme', Website: 'a.com', Notes: 'met' }, { Email: '', Notes: '' }], map);
    expect(rs).toEqual([{ email: 'ali@x.com', first_name: 'Ali', company: 'Acme', website: 'a.com', fields: { Notes: 'met' } }]);
  });
  it('splits a single Name column', () => {
    const rs = rowsToRecipients([{ Mail: 'a@b.co', Name: 'Ann Marie Lee' }], guessMapping(['Mail', 'Name']));
    expect(rs[0]).toMatchObject({ first_name: 'Ann', last_name: 'Marie Lee' });
  });
  it('parses pasted lists in several formats and analyses validity/duplicates', () => {
    const list = parsePastedList('a@x.com, b@x.com; "Cara Doe" <c@x.com>\nA@x.com\nbad-address\n');
    expect(list.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'a@x.com', 'bad-address']);
    expect(list[2].first_name).toBe('Cara');
    const a = analyzeRecipients(list);
    expect([a.valid.length, a.duplicates.length, a.invalid.length]).toEqual([3, 1, 1]);
  });
});

describe('scheduling helpers', () => {
  const now = new Date('2030-01-07T22:30:00Z');
  it('resolves relative presets', () => {
    expect(resolveSchedulePreset('5min', now, 'UTC').toISOString()).toBe('2030-01-07T22:35:00.000Z');
    expect(resolveSchedulePreset('1hour', now, 'UTC').toISOString()).toBe('2030-01-07T23:30:00.000Z');
    expect(resolveSchedulePreset('3hours', now, 'UTC').toISOString()).toBe('2030-01-08T01:30:00.000Z');
  });
  it('resolves "tomorrow 8am/1pm/7pm" in the selected time zone (incl. DST)', () => {
    expect(resolveSchedulePreset('tomorrow8', now, 'UTC').toISOString()).toBe('2030-01-08T08:00:00.000Z');
    expect(resolveSchedulePreset('tomorrow8', now, 'America/New_York').toISOString()).toBe('2030-01-08T13:00:00.000Z');
    expect(resolveSchedulePreset('tomorrow19', now, 'Asia/Karachi').toISOString()).toBe('2030-01-09T14:00:00.000Z'); // already Jan 8 03:30 in Karachi
    // 17:30 New York on Jan 7 -> tomorrow is Jan 8 either way; DST case: Mar 9 2030 -> Mar 10 (spring forward)
    expect(resolveSchedulePreset('tomorrow8', new Date('2030-03-09T20:00:00Z'), 'America/New_York').toISOString()).toBe('2030-03-10T12:00:00.000Z');
  });
  it('converts datetime-local input in a zone to UTC and back', () => {
    const d = localInputToUtc('2030-06-01T09:30', 'Europe/London')!;
    expect(d.toISOString()).toBe('2030-06-01T08:30:00.000Z');
    expect(utcToLocalInput(d, 'Europe/London')).toBe('2030-06-01T09:30');
    expect(zonedToUtc(2030, 1, 1, 0, 0, 'UTC').toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
  it('estimates campaign duration from daily limit and interval', () => {
    expect(estimateDuration(100, 30, 600, 1200)).toEqual({ perDay: 30, days: 4, hours: 74.5 });
    expect(DELAY_PRESETS.map((p) => p.id)).toContain('5-10s');
  });
});
