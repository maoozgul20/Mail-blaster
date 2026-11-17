import {
  buildMergeData, buildMime, hmacSign, htmlToText, injectTracking, renderTemplate, sanitizeEmailHtml, utf8ToB64Url, type MimeAttachment,
} from '@mailblaster/shared';
import type { ClaimedJob } from './types';

export interface RenderEnv { API_BASE_URL: string; ENCRYPTION_KEY: string }

export interface RenderedEmail {
  raw: string; // base64url RFC 5322 message, ready for Gmail
  subject: string;
  rfcId: string;
  to: string;
  threadId: string | null;
  missing: string[];
}

const stripRe = (s: string) => s.replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim();
const domainOf = (email: string) => email.split('@')[1] ?? 'mailblaster.local';

export async function signedClickUrl(env: RenderEnv, token: string, url: string): Promise<string> {
  const sig = await hmacSign(env.ENCRYPTION_KEY, 'click', `${token}|${url}`);
  return `${env.API_BASE_URL}/t/c/${token}?u=${utf8ToB64Url(url)}&s=${sig}`;
}

/** Message-ID is derived from the job so it is stable across attempts and traceable. */
export const rfcIdForJob = (jobId: string, senderEmail: string) => `mb.${jobId}@${domainOf(senderEmail)}`;

export interface RenderOptions {
  attachments?: MimeAttachment[];
  /** test emails: no tracking pixel/links and no unsubscribe footer */
  test?: boolean;
  testPrefix?: string;
}

export async function renderEmail(job: ClaimedJob, env: RenderEnv, opts: RenderOptions = {}): Promise<RenderedEmail> {
  const { campaign: c, recipient: r, account, step, thread, user_settings: us } = job;
  const data = buildMergeData(r);
  const isFollowUp = job.job.step_number > 0 && step;

  const subjTpl = isFollowUp
    ? (step!.subject?.trim() ? step!.subject : `Re: ${stripRe(thread?.subject || c.subject)}`)
    : c.subject;
  const bodyTpl = isFollowUp ? step!.body_html : c.body_html;
  const subj = renderTemplate(subjTpl, data);
  const body = renderTemplate(sanitizeEmailHtml(bodyTpl), data, { html: true });
  const sig = us.signature_html ? sanitizeEmailHtml(us.signature_html) : '';
  const missing = [...new Set([...subj.missing, ...body.missing])];

  const settings = c.settings as Record<string, any>;
  const trackOpens = !opts.test && (settings.track_opens ?? us.track_opens) !== false;
  const trackClicks = !opts.test && (settings.track_clicks ?? us.track_clicks) !== false;
  const unsub = !opts.test && (settings.unsubscribe_link ?? us.unsubscribe_footer) !== false;
  const unsubUrl = `${env.API_BASE_URL}/u/${r.token}`;

  let inner = `<div dir="ltr">${body.text}${sig ? `<br><div>${sig}</div>` : ''}</div>`;
  const plainBase = c.body_text && !isFollowUp ? renderTemplate(c.body_text, data).text : htmlToText(inner);
  inner = await injectTracking(inner, {
    openPixelUrl: trackOpens ? `${env.API_BASE_URL}/t/o/${r.token}.gif` : undefined,
    trackLink: trackClicks ? (u) => signedClickUrl(env, r.token, u) : undefined,
    unsubscribeUrl: unsub ? unsubUrl : undefined,
    unsubscribeText: us.unsubscribe_text,
    disclosure: trackOpens || trackClicks ? us.tracking_disclosure : null,
  });
  const text = unsub ? `${plainBase}\n\n--\n${us.unsubscribe_text}: ${unsubUrl}` : plainBase;

  const rfcId = rfcIdForJob(job.job.id, account.email);
  const sendInThread = !!isFollowUp && thread?.thread_id && step!.reply_in_thread !== false;
  const headers: Record<string, string> = { 'X-MergeBlast-Job': job.job.id };
  if (unsub) {
    headers['List-Unsubscribe'] = `<${unsubUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const subject = `${opts.testPrefix ?? ''}${subj.text}`.replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
  const mime = buildMime({
    from: { email: account.email, name: account.display_name },
    to: r.email,
    subject,
    html: inner,
    text,
    messageId: rfcId,
    inReplyTo: sendInThread ? thread!.rfc_message_id : null,
    references: sendInThread ? thread!.rfc_message_id : null,
    headers,
    attachments: opts.attachments,
  });
  return { raw: utf8ToB64Url(mime), subject, rfcId, to: r.email, threadId: sendInThread ? thread!.thread_id : null, missing };
}
