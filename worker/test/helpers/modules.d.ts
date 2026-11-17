declare module '*/combine-migrations.mjs' {
  export function combined(): string;
}
declare module '*/toml-vars.mjs' {
  export function setVars(toml: string, vars: Record<string, string>): string;
}
