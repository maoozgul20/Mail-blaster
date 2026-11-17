/** Minimal data-access seam used by the scheduler and public endpoints.
 *  Production: Supabase PostgREST RPC with the service role key. Tests: PGlite (real PostgreSQL). */
export interface Store {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}
