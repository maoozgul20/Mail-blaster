/** Sets/updates top-level keys in the [vars] table of a wrangler.toml, line by line (safe for LF and CRLF files). */
export function setVars(toml, vars) {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const lines = toml.split(/\r?\n/);
  const vi = lines.findIndex((l) => /^\s*\[vars\]\s*(#.*)?$/.test(l));
  if (vi < 0) throw new Error('wrangler.toml has no [vars] table');
  let end = lines.findIndex((l, i) => i > vi && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k} = ${JSON.stringify(v)}`;
    const active = new RegExp(`^\\s*${k}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${k}\\s*=`);
    let i = lines.findIndex((l, n) => n > vi && n < end && active.test(l));
    if (i < 0) i = lines.findIndex((l, n) => n > vi && n < end && commented.test(l));
    if (i >= 0) lines[i] = line;
    else { lines.splice(vi + 1, 0, line); end++; }
  }
  return lines.join(eol);
}
