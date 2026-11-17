/** Must stay in sync with public._valid_email() in the database. */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const normalizeEmail = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

export function isValidEmail(s: string | null | undefined): boolean {
  const e = normalizeEmail(s);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}
