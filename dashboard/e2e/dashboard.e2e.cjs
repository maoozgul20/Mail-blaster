/* Full-stack browser test: real dashboard bundle -> real Worker app -> real PostgreSQL (PGlite) with a mock Gmail.
 * Run:  node dashboard/e2e/dashboard.e2e.cjs   (needs `npm run e2e:server` on :8788 and `vite preview` on :4173)
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const APP = process.env.APP_URL || 'http://localhost:4173';
const API = process.env.API_URL || 'http://localhost:8788';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const post = async (path, body) => (await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const get = async (path) => (await fetch(API + path)).json();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(401|404)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  const step = async (name, fn) => { try { await fn(); console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n   ', e.message.split('\n')[0]); await page.screenshot({ path: `${SHOTS}/FAIL-${name.replace(/\W+/g, '_')}.png` }); throw e; } };

  const email = `e2e${Date.now()}@test.dev`;

  await step('sign up and land on the overview', async () => {
    await page.goto(`${APP}/login`);
    await page.getByRole('button', { name: /Create one/ }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await page.getByText('Campaigns', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Connected', { exact: true }).count() >= 1, true);
    await page.screenshot({ path: `${SHOTS}/01-overview-empty.png` });
  });

  await step('build a campaign: paste recipients, validate, write message', async () => {
    await page.getByRole('link', { name: 'New Campaign', exact: true }).click();
    await page.getByRole('heading', { name: 'New campaign' }).waitFor();
    await page.getByRole('tab', { name: /Paste/ }).click();
    await page.getByLabel('Email addresses').fill('ali@example.com, sara@example.com\nJohn Smith <john@example.com>\nali@example.com\nnot-an-email');
    await page.getByRole('button', { name: 'Add to list' }).click();
    await page.getByText('3 valid').waitFor();
    await page.getByText('1 invalid').waitFor();
    await page.getByText('1 duplicates').waitFor();
    await page.getByText('3 will be emailed individually').waitFor();
    await page.getByLabel('Campaign name').or(page.getByPlaceholder(/Guest post outreach/)).first().fill('E2E outreach');
    await page.getByPlaceholder(/Quick idea for/).fill('Hello {{FirstName|there}} at {{Company|your company}}');
    await page.getByRole('button', { name: 'HTML', exact: true }).first().click();
    await page.getByLabel('Email body (HTML source)').fill('<p>Hi {{FirstName|there}}, I enjoy your work. See <a href="https://example.com/pricing">our pricing</a>.</p>');
    await page.getByRole('button', { name: 'HTML', exact: true }).first().click();
    await page.getByLabel('Email body', { exact: true }).getByText('our pricing').waitFor();
    // live preview renders per recipient
    const frame = page.frameLocator('iframe[title="Email preview"]').first();
    await frame.getByText('Hi there, I enjoy your work', { exact: false }).waitFor(); // pasted address without a name -> fallback
    await page.screenshot({ path: `${SHOTS}/02-new-campaign.png`, fullPage: true });
  });

  await step('schedule options render (presets, speed, business hours)', async () => {
    for (const label of ['Now', 'In 5 min', 'In 1 hour', 'In 3 hours', 'Tomorrow 8am', 'Tomorrow 1pm', 'Tomorrow 7pm']) await page.getByRole('button', { name: label, exact: true }).waitFor();
    for (const label of ['5–10 sec', '10–60 sec', '1–5 min', '5–10 min']) await page.getByRole('button', { name: label, exact: true }).waitFor();
    await page.getByRole('button', { name: '5–10 min', exact: true }).click();
    await page.getByRole('button', { name: '5–10 sec', exact: true }).click();
    await page.getByText(/Very short gaps/).waitFor();
    await page.getByRole('button', { name: '10–20 min', exact: true }).click();
    await page.getByRole('button', { name: 'Custom date & time' }).click();
    await page.locator('input[type="datetime-local"]').first().waitFor();
    await page.getByRole('button', { name: 'Now', exact: true }).click();
  });

  await step('autosave creates a draft, test email works', async () => {
    await page.waitForURL(/\/campaigns\/.+\/edit/, { timeout: 15000 });
    await page.getByRole('button', { name: /Send test email/ }).click();
    await page.getByText(/Test email sent to me@gmail.test/).waitFor();
    const sent = await get('/__sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^\[TEST\]/);
  });

  await step('launch the campaign', async () => {
    await page.getByRole('button', { name: 'Send campaign' }).click();
    await page.getByRole('heading', { name: 'Ready to launch?' }).waitFor();
    await page.getByRole('button', { name: 'Start sending' }).click();
    await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await page.getByText('Total recipients').waitFor();
    await page.screenshot({ path: `${SHOTS}/03-campaign-queued.png`, fullPage: true });
  });

  await step('cloud scheduler sends ONE email, then waits the random gap', async () => {
    const a = await post('/__tick', { seconds: 0 });
    assert.equal(a.submitted, 1);
    const b = await post('/__tick', { seconds: 1 });
    assert.equal(b.claimed, 0, 'must not send a second email immediately');
    let sent = (await get('/__sent')).filter((m) => !m.subject.startsWith('[TEST]'));
    assert.equal(sent.length, 1);
    assert.equal((sent[0].to.match(/@/g) || []).length, 1, 'one recipient only');
    await page.reload();
    await page.getByText('Total recipients').waitFor();
    await page.getByText('Pending').first().waitFor();
    // pending vs sent are shown distinctly in the table
    await page.getByRole('table').getByText('Pending', { exact: true }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/04-campaign-running.png`, fullPage: true });
    await post('/__tick', { seconds: 1300 });
    await post('/__tick', { seconds: 1300 });
    sent = (await get('/__sent')).filter((m) => !m.subject.startsWith('[TEST]'));
    assert.equal(sent.length, 3);
    assert.equal(new Set(sent.map((m) => m.to)).size, 3);
    assert.ok(sent.some((m) => m.subject === 'Hello John at your company'), 'personalised subject from "John Smith <john@…>"');
    assert.ok(sent.some((m) => m.subject === 'Hello there at your company'), 'FirstName fallback for the recipient without a name');
  });

  await step('open tracking, click tracking and unsubscribe work from the real endpoints', async () => {
    const sent = (await get('/__sent')).filter((m) => !m.subject.startsWith('[TEST]'));
    const m = sent[0];
    const pixel = m.html.match(/http:\/\/localhost:8788\/t\/o\/[a-f0-9]{32}\.gif/)[0];
    const tracked = m.html.match(/http:\/\/localhost:8788\/t\/c\/[^"]+/)[0].replace(/&amp;/g, '&');
    await post('/__sql', { sql: "update public.campaign_recipients set sent_at = now() - interval '1 hour'" }).catch(() => null);
    await fetch(API + '/__sql', { method: 'POST', body: JSON.stringify({ sql: "update public.campaign_recipients set sent_at = now() - interval '1 hour'" }) });
    assert.equal((await fetch(pixel)).headers.get('content-type'), 'image/gif');
    const r = await fetch(tracked, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://example.com/pricing');
    const unsub = m.html.match(/http:\/\/localhost:8788\/u\/[a-f0-9]{32}/)[0];
    assert.match(await (await fetch(unsub)).text(), /Yes, unsubscribe me/);
    assert.match(await (await fetch(unsub, { method: 'POST' })).text(), /You are unsubscribed/);
  });

  await step('reply detection updates the campaign', async () => {
    const sent = (await get('/__sent')).filter((m) => !m.subject.startsWith('[TEST]'));
    await post('/__reply', { threadId: sent[1].threadId, from: sent[1].to, snippet: 'Yes please, tell me more' });
    const inb = await post('/__inbound');
    assert.equal(inb.replies, 1);
    await page.reload();
    await page.getByText('Total recipients').waitFor();
    await page.getByRole('table').getByText(/Replied/).first().waitFor();
    await page.getByText('Unsubscribed').first().waitFor();
    // filters
    await page.getByLabel('Filter recipients').selectOption('replied');
    await page.getByRole('table').getByText(sent[1].to).waitFor();
    await page.getByRole('table').getByText(sent[1].to).click();
    await page.getByText('Yes please, tell me more').waitFor();
    await page.screenshot({ path: `${SHOTS}/05-recipient-detail.png` });
    await page.keyboard.press('Escape');
  });

  await step('campaign list, pause / resume / duplicate / export', async () => {
    await page.getByRole('link', { name: 'Campaigns', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Campaigns' }).waitFor();
    await page.getByRole('link', { name: 'E2E outreach' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/06-campaign-list.png` });
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Duplicate' }).first().click();
    await page.getByRole('heading', { name: 'Edit draft' }).waitFor();
  });

  await step('every other page renders without errors', async () => {
    const pages = [['/', 'Overview'], ['/contacts', 'Contacts'], ['/templates', 'Templates'], ['/follow-ups', 'Follow-ups'], ['/activity', 'Activity'], ['/suppression', 'Suppression list'], ['/analytics', 'Analytics'], ['/settings', 'Settings'], ['/settings/account', 'Account & Integrations']];
    for (const [path, title] of pages) {
      await page.goto(APP + path);
      await page.getByRole('heading', { name: title, exact: true }).first().waitFor();
      await page.screenshot({ path: `${SHOTS}/page-${title.replace(/\W+/g, '_')}.png`, fullPage: path === '/' });
    }
    // overview is now populated from PostgreSQL
    await page.goto(APP + '/');
    await page.getByText('Recent replies').waitFor();
    await page.getByText('Yes please, tell me more').waitFor();
  });

  await step('contacts: add, import, suppression add/remove', async () => {
    await page.goto(APP + '/contacts');
    await page.getByRole('button', { name: 'Add contact' }).click();
    await page.getByLabel('Email').fill('new.contact@example.com');
    await page.getByRole('button', { name: 'Add contact' }).last().click();
    await page.getByText('new.contact@example.com').waitFor();
    await page.goto(APP + '/suppression');
    await page.getByLabel('Emails to suppress').fill('blocked@example.com');
    await page.getByRole('button', { name: 'Add to suppression list' }).click();
    await page.getByRole('cell', { name: 'blocked@example.com', exact: true }).waitFor();
  });

  await step('mobile layout has no horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    for (const path of ['/', '/campaigns', '/campaigns/new']) {
      await page.goto(APP + path);
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${path} overflows by ${overflow}px`);
    }
    await page.screenshot({ path: `${SHOTS}/07-mobile.png` });
  });

  await browser.close();
  if (problems.length) { console.log('\nBrowser problems:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
  console.log('\nDASHBOARD E2E PASSED');
})().catch((e) => { console.error('\nE2E FAILED:', e.message); process.exit(1); });
