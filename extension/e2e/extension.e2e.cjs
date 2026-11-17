/* Loads the REAL built extension (extension/dist) into Chromium, opens a mock Gmail page that reproduces Gmail's compose DOM,
 * and drives the panel against the real Worker app + PostgreSQL (see scripts/run-e2e.sh). No Google traffic, no real email.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const API = process.env.API_URL || 'http://localhost:8788';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const DIST = path.join(__dirname, '..', 'dist');
const post = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json();
const get = async (p) => (await fetch(API + p)).json();

const GMAIL = `<!doctype html><html><head><meta charset="utf-8"><title>Inbox - Gmail (mock)</title></head><body style="font:14px sans-serif;background:#f6f8fc">
<div gh="cm" role="button" id="compose-btn" style="padding:10px;background:#c2e7ff;display:inline-block;border-radius:12px">Compose</div>
<div id="stage"></div>
<script>
  document.getElementById('compose-btn').addEventListener('click', () => {
    if (document.querySelector('[role=dialog]')) return;
    document.getElementById('stage').innerHTML = \`
    <div role="dialog" class="nH Hd" style="position:fixed;right:24px;bottom:0;width:520px;background:#fff;border:1px solid #ccc;box-shadow:0 0 8px #888;padding:8px">
      <form onsubmit="return false">
        <div name="to" style="padding:4px"><span email="ali@example.com" data-hovercard-id="ali@example.com">Ali</span> <span email="sara@example.com" data-hovercard-id="sara@example.com">Sara</span></div>
        <input name="subjectbox" placeholder="Subject" style="width:100%;padding:6px">
        <div role="textbox" g_editable="true" aria-label="Message Body" contenteditable="true" style="min-height:90px;border:1px solid #eee;margin:6px 0;padding:6px"></div>
        <div class="btC" style="display:flex;align-items:center">
          <div class="dC"><div role="button" data-tooltip="Send (Ctrl-Enter)" class="T-I J-J5-Ji aoO" style="background:#0b57d0;color:#fff;padding:8px 20px;border-radius:18px;cursor:pointer">Send</div></div>
          <div role="button" data-tooltip="Discard draft (Ctrl-Shift-D)" id="discard" style="margin-left:auto;cursor:pointer">🗑</div>
        </div>
      </form></div>\`;
    document.getElementById('discard').addEventListener('click', () => { document.getElementById('stage').innerHTML = ''; window.__discarded = true; });
  });
</script></body></html>`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ext-'));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: 'chromium', headless: true, viewport: { width: 1300, height: 900 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  await ctx.route('https://mail.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: GMAIL }));
  const problems = [];
  const step = async (name, fn) => { try { await fn(); console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n   ', e.message.split('\n')[0]); const p = ctx.pages().at(-1); if (p) await p.screenshot({ path: `${SHOTS}/FAIL-ext-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); throw e; } };

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const email = `ext${Date.now()}@test.dev`;
  // the extension opens its own options tab right after install: let it settle and close it so it cannot race with our navigation
  await new Promise((r) => setTimeout(r, 2500));
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();

  await step('options page: create an account, sign out, sign in again', async () => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`options: ${e.message}`));
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.getByRole('button', { name: 'No account yet? Create one' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('password-123');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByText('Signed in as').waitFor();
    await page.getByText(email).first().waitFor();
    assert.equal(await page.getByLabel(/API URL/).inputValue(), API);
    await page.waitForTimeout(1000); await page.screenshot({ path: `${SHOTS}/ext-1-options.png` });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Signed in as').waitFor();
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByText(email).waitFor();
    await popup.close(); await page.close();
  });

  const gmail = await ctx.newPage();
  gmail.on('pageerror', (e) => problems.push(`gmail: ${e.message}`));
  gmail.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`gmail console: ${m.text()}`); });

  await step('Gmail: status pill shows Connected and compose gets the MailBlaster button next to Send', async () => {
    await gmail.goto('https://mail.google.com/mail/u/0/#inbox');
    await gmail.getByText(/MailBlaster AI · Connected/).waitFor();
    await gmail.locator('#compose-btn').click();
    const launch = gmail.getByRole('button', { name: 'MailBlaster campaign options' });
    await launch.waitFor();
    // it is injected right after the Send button container
    const adjacent = await gmail.evaluate(() => { const dc = document.querySelector('.dC'); return dc?.nextElementSibling?.id === 'mailblaster-launcher'; });
    assert.equal(adjacent, true);
  });

  await step('panel opens: connected indicator, recipients from the To field', async () => {
    await gmail.locator('input[name="subjectbox"]').fill('Quick idea for {{Company}}');
    await gmail.locator('[role="textbox"][g_editable="true"]').click();
    await gmail.keyboard.type('Hi {{FirstName|there}}, here is my idea.');
    await gmail.getByRole('button', { name: 'MailBlaster campaign options' }).click();
    await gmail.getByRole('dialog', { name: 'MailBlaster campaign' }).waitFor();
    await gmail.getByText('Connected', { exact: true }).waitFor();
    await gmail.getByText('2 valid').first().waitFor();
    await gmail.getByText('from the To field').waitFor();
    await gmail.waitForTimeout(1000); await gmail.screenshot({ path: `${SHOTS}/ext-2-panel.png` });
  });

  await step('CSV import with column mapping, duplicates and invalid rows', async () => {
    const csv = path.join(os.tmpdir(), 'ext-recipients.csv');
    fs.writeFileSync(csv, 'Email,FirstName,Company,Website,Notes\nana@example.com,Ana,Acme,acme.test,vip\nben@example.com,Ben,Beta,beta.test,\nana@example.com,Ana,Acme,acme.test,dupe\nnot-an-email,X,Y,,\ncy@example.com,,Gamma,,\n');
    await gmail.locator('input[data-testid="file"]').setInputFiles(csv);
    await gmail.getByText('3 valid').first().waitFor();
    await gmail.getByText('1 invalid').waitFor();
    await gmail.getByText('1 duplicates').waitFor();
    await gmail.getByLabel('Map Notes').waitFor();
    assert.equal(await gmail.getByLabel('Map Email').inputValue(), 'email');
    await gmail.getByRole('button', { name: /Remove invalid/ }).click();
    await gmail.getByText('3 valid').first().waitFor();
    // live preview uses the chosen recipient
    const frame = gmail.frameLocator('iframe[title="Email preview"]');
    await frame.getByText('Hi Ana, here is my idea.').waitFor();
  });

  await step('follow-up stages, delivery, schedule, speed and advanced sections', async () => {
    const openSec = (n) => gmail.locator('summary', { hasText: new RegExp('^' + n) }).click();
    await openSec('Follow-ups');
    for (const i of [1, 2, 3]) await gmail.getByLabel(`Stage ${i} condition`).waitFor();
    assert.equal(await gmail.getByLabel('Stage 1 days').inputValue(), '3');
    assert.equal(await gmail.getByLabel('Stage 2 days').inputValue(), '4');
    assert.equal(await gmail.getByLabel('Stage 3 days').inputValue(), '7');
    await openSec('Delivery');
    await gmail.getByLabel('Send emails').waitFor();
    await openSec('Schedule');
    for (const l of ['Now', 'In 5 min', 'In 1 hour', 'In 3 hours', 'Tomorrow 8am', 'Tomorrow 1pm', 'Tomorrow 7pm']) await gmail.getByRole('button', { name: l, exact: true }).waitFor();
    for (const l of ['5–10 sec', '10–60 sec', '1–5 min', '5–10 min']) await gmail.getByRole('button', { name: l, exact: true }).waitFor();
    await gmail.getByRole('button', { name: '10–60 sec', exact: true }).click();
    await gmail.getByRole('button', { name: '10–20 min', exact: true }).click();
    assert.equal(await gmail.getByLabel('Emails per day').inputValue(), '30');
    assert.equal(await gmail.getByLabel('Minimum pause').inputValue(), '10');
    assert.equal(await gmail.getByLabel('Maximum pause').inputValue(), '20');
    await openSec('Advanced');
    await gmail.getByText('Track opens').waitFor();
    await gmail.waitForTimeout(1000); await gmail.screenshot({ path: `${SHOTS}/ext-3-sections.png` });
  });

  await step('Send campaign: one individual job per recipient, compose is discarded', async () => {
    await gmail.getByRole('button', { name: 'Send campaign' }).click();
    await gmail.getByText(/Campaign started: 3 individual emails/).waitFor();
    await gmail.waitForFunction(() => window.__discarded === true, null, { timeout: 5000 });
    const rows = await post('/__sql', { sql: "select r.email, r.status from public.campaign_recipients r join public.campaigns c on c.id=r.campaign_id where c.name like 'Quick idea%' order by r.email" });
    assert.deepEqual(rows.map((r) => r.email), ['ana@example.com', 'ben@example.com', 'cy@example.com']);
    assert.ok(rows.every((r) => r.status === 'queued'));
    const jobs = await post('/__sql', { sql: "select count(*)::int n from public.sending_jobs j join public.campaigns c on c.id=j.campaign_id where c.name like 'Quick idea%' and j.status='queued' and j.step_number=0" });
    assert.equal(jobs[0].n, 3);
    const fu = await post('/__sql', { sql: "select count(*)::int n, min(f.delay_minutes) mn, max(f.delay_minutes) mx from public.follow_up_steps f join public.follow_up_sequences q on q.id=f.sequence_id join public.campaigns c on c.id=q.campaign_id where c.name like 'Quick idea%'" });
    assert.equal(fu[0].n, 3); assert.equal(fu[0].mn, 3 * 1440); assert.equal(fu[0].mx, 7 * 1440);
    // the cloud scheduler sends them individually
    const before = (await get('/__sent')).length;
    await post('/__tick', { seconds: 0 }); await post('/__tick', { seconds: 1300 }); await post('/__tick', { seconds: 1300 });
    const mails = (await get('/__sent')).slice(before);
    assert.equal(mails.length, 3);
    assert.deepEqual(mails.map((m) => m.to).sort(), ['ana@example.com', 'ben@example.com', 'cy@example.com']);
    assert.ok(mails.some((m) => m.subject === 'Quick idea for Acme'));
    assert.ok(mails.every((m) => !/,/.test(m.to)));
  });

  await step('Open in full editor creates a draft and opens the dashboard editor', async () => {
    await gmail.locator('#compose-btn').click();
    await gmail.locator('input[name="subjectbox"]').fill('Editor handoff');
    await gmail.locator('[role="textbox"][g_editable="true"]').click();
    await gmail.keyboard.type('Draft body');
    await gmail.getByRole('button', { name: 'MailBlaster campaign options' }).click();
    const popupP = ctx.waitForEvent('page');
    await gmail.getByRole('button', { name: 'Open in full editor' }).click();
    const tab = await popupP;
    assert.match(tab.url(), /http:\/\/localhost:4173\/campaigns\/[0-9a-f-]{36}\/edit/);
    const d = await post('/__sql', { sql: "select subject, status from public.campaigns where name like 'Editor handoff%'" });
    assert.deepEqual(d[0], { subject: 'Editor handoff', status: 'draft' });
  });

  await ctx.close();
  if (problems.length) { console.log('\nBrowser problems:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
  console.log('\nEXTENSION E2E PASSED');
})().catch((e) => { console.error('\nEXTENSION E2E FAILED:', e.message); process.exit(1); });
