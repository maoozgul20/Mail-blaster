import { escapeHtml } from './html';

export interface TrackingOptions {
  /** 1x1 pixel URL (omit to disable open tracking) */
  openPixelUrl?: string;
  /** turns an original http(s) URL into a signed tracking URL (omit to disable click tracking) */
  trackLink?: (url: string) => Promise<string>;
  unsubscribeUrl?: string;
  unsubscribeText?: string;
  disclosure?: string | null;
}

const A_HREF = /(<a\b[^>]*?\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi;

export async function injectTracking(html: string, o: TrackingOptions): Promise<string> {
  let out = html;
  if (o.trackLink) {
    const urls = new Set<string>();
    for (const m of out.matchAll(A_HREF)) {
      const u = (m[3] ?? m[4] ?? '').replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(u) && u !== o.unsubscribeUrl) urls.add(u);
    }
    const map = new Map<string, string>();
    await Promise.all([...urls].map(async (u) => map.set(u, await o.trackLink!(u))));
    out = out.replace(A_HREF, (full, pre: string, quoted: string, d?: string, s?: string) => {
      const u = (d ?? s ?? '').replace(/&amp;/g, '&');
      const t = map.get(u);
      return t ? `${pre}"${escapeHtml(t)}"` : full;
    });
  }
  let footer = '';
  if (o.unsubscribeUrl) {
    footer += `<a href="${escapeHtml(o.unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline">${escapeHtml(o.unsubscribeText || 'Unsubscribe')}</a>`;
  }
  if (o.disclosure) footer += `${footer ? '<br>' : ''}${escapeHtml(o.disclosure)}`;
  if (footer) out += `<div style="margin-top:24px;font-size:12px;line-height:1.4;color:#6b7280">${footer}</div>`;
  if (o.openPixelUrl) out += `<img src="${escapeHtml(o.openPixelUrl)}" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">`;
  return out;
}
