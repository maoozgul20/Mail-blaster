export interface Env {
  // non-secret vars (wrangler.toml [vars])
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  GOOGLE_REDIRECT_URI: string;
  API_BASE_URL: string;
  FRONTEND_URL: string;
  ALLOWED_ORIGINS?: string; // optional extra comma-separated origins for CORS (e.g. http://localhost:5173 in development)
  // secrets (wrangler secret put ...)
  SUPABASE_SERVICE_ROLE_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string; // base64, 32 bytes
  // optional overrides (tests / emulators)
  GMAIL_API_BASE?: string;
}
