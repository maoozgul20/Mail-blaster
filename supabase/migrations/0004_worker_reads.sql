-- MailBlaster AI :: 0004b token / account reads for the Worker (service role only; see 0006).
-- Ciphertext is only ever decrypted inside the Worker; the key is a Cloudflare secret, never in the DB.

create or replace function public.wk_get_tokens(p_account uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
      'account_id', a.id, 'email', a.email, 'user_id', a.user_id, 'status', a.status, 'scopes', a.scopes,
      'refresh_token_enc', t.refresh_token_enc, 'access_token_enc', t.access_token_enc, 'access_expires_at', t.access_expires_at)
    from public.connected_accounts a left join public.oauth_tokens t on t.account_id = a.id where a.id = p_account
$$;

create or replace function public.wk_get_account(p_account uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(a) from public.connected_accounts a where a.id = p_account and a.user_id = p_user
$$;

create or replace function public.wk_mark_account_error(p_account uuid, p_status text, p_message text, p_now timestamptz default now())
returns void language sql security definer set search_path = public as $$
  update public.connected_accounts set status = p_status, last_error = left(p_message, 500), last_error_at = p_now where id = p_account;
$$;
