export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Defence in depth for HTML that goes into an email or a preview. Previews additionally render in a sandboxed iframe. */
export function sanitizeEmailHtml(html: string): string {
  let h = html ?? '';
  h = h.replace(/<\s*(script|iframe|object|embed|applet|meta|link|base|form)\b[\s\S]*?(<\/\s*\1\s*>|$)/gi, '');
  h = h.replace(/<\s*(script|iframe|object|embed|applet|meta|link|base|form)\b[^>]*>/gi, '');
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  h = h.replace(/(href|src|xlink:href|action|formaction)\s*=\s*("|')\s*(javascript|vbscript|data\s*:\s*text\/html)[^"']*\2/gi, '$1=$2#$2');
  h = h.replace(/(href|src)\s*=\s*(javascript|vbscript):[^\s>]*/gi, '$1="#"');
  return h;
}

export function htmlToText(html: string): string {
  return (html ?? '')
    .replace(/<\s*(style|script)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      return !l || l === href ? href : `${l} (${href})`;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
