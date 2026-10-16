-- ============================================================
-- vendas_sync_cursor — FENCING TOKEN no lease do backfill de pedidos Omie.
--
-- O defeito (achado P1 do challenge Codex xhigh no #1518, 2026-07-21; aberto até aqui):
-- o lease de 20260617133633 é só COOPERATIVO. heartbeat/release/finish filtram pela PK +
-- `running_since IS NOT NULL` e não sabem QUEM segura o lease. Cenário: o worker A fica
-- >3 min sem heartbeat (página lenta, rate-limit), o cron vendas-sync-continuacao-6min
-- dispara B, que rouba o lease (cláusula `heartbeat_at < now()-3min`). Quando A acorda,
-- os heartbeat/release/finish DELE passam a valer sobre o lease de B: rebobinam o
-- next_page para a página de A, soltam o lease de B no meio do run (abrindo vaga para um
-- 3º worker) ou fecham a janela com o estado de A. O dano em sales_orders fica limitado a
-- retrabalho (uniq_sales_orders_omie_hash), mas a serialização vira ficção no takeover.
--
-- O conserto (mesmo princípio do #2916 no lease do farmer — o BANCO recusa quem perdeu o
-- lease, não a premissa "a plataforma mata a edge antes do TTL"):
--   • coluna `lease_token uuid` — nova a cada acquire (inclusive no roubo de lease morto);
--   • 4 RPCs NOVAS `*_fenced`: acquire devolve {resume_page, lease_token}; heartbeat /
--     finish / release EXIGEM o token (`lease_token = p_lease_token`, que é NULL-blind:
--     token NULL nunca casa — não há bypass) e devolvem boolean "eu ainda era o dono".
--     A edge para o laço quando o heartbeat devolve false e NÃO chama o finish.
--     Conferência e escrita são UM statement UPDATE: sob READ COMMITTED o Postgres
--     re-avalia o WHERE na versão nova da linha (EPQ) depois de esperar o lock de um
--     acquire concorrente — sem janela check-then-act (provado com 2 sessões no harness);
--   • as 4 RPCs ANTIGAS seguem existindo (o edge de hoje as chama — a ordem migration→edge
--     tem de ser segura) mas ganham `lease_token IS NULL`: só agem sobre lease tomado pelo
--     caminho antigo. O acquire antigo zera o token ao tomar o lease. Efeito: uma edge
--     VELHA (deploy atrasado, ou o sync do Lovable revertendo o arquivo — já aconteceu
--     neste repo) continua funcionando sozinha, mas NUNCA mexe num lease cercado; e, ao
--     roubar um lease morto cercado, cerca o worker novo para fora (heartbeat → false).
--
-- Granularidade declarada: o fencing é POR PÁGINA (o heartbeat roda no início de cada uma).
-- A escrita de pedidos de uma página que o zumbi já tinha em mãos ainda acontece — e é
-- insert-only/idempotente por hash, então é retrabalho, não corrupção.
--
-- Nada é DROPado: as assinaturas antigas ficam (aposentá-las é DROP = founder, depois de a
-- edge v1.19 estar atestada no ledger e nenhuma janela aberta por caminho antigo existir).
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`; no SQL
-- Editor, envolver em BEGIN; … COMMIT;.
-- Prova: db/test-vendas-sync-cursor-fencing.sh (PG17, falsificação, corrida com 2 sessões).
-- Validação pós-apply (lê catálogo): db/valida-vendas-sync-cursor-fencing.sql.
-- ============================================================

ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS lease_token uuid;

COMMENT ON COLUMN public.vendas_sync_cursor.lease_token IS
  'Fencing token do lease: novo a cada vendas_sync_lease_acquire_fenced (inclusive no roubo de '
  'lease morto). heartbeat/finish/release _fenced só agem com o token igual. NULL = sem lease, '
  'ou lease tomado pelo caminho antigo (não cercado).';

-- ─────────────────────────── RPCs cercadas (novas) ───────────────────────────

-- (1) acquire: toma o lease ATOMICAMENTE e emite um token NOVO. NULL = não conseguiu
-- (lease vivo de outro, janela completa ou inexistente).
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire_fenced(
  p_account text, p_date_from date, p_date_to date
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = now(), heartbeat_at = now(), updated_at = now(),
         lease_token   = gen_random_uuid()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING jsonb_build_object('resume_page', COALESCE(next_page, 1), 'lease_token', lease_token);
$$;

-- (2) heartbeat: renova o lease e persiste o progresso SÓ para o dono do token.
-- false = perdi o lease (outro worker o tomou, ou a janela foi liberada/fechada) → PARE.
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_page integer
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET heartbeat_at = now(), next_page = p_page, updated_at = now()
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- (3) finish: encerra e libera o lease SÓ para o dono do token (mesma semântica do
-- vendas_sync_finish: complete=true fecha completed_at; false pausa no p_next_page).
CREATE OR REPLACE FUNCTION public.vendas_sync_finish_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid,
  p_complete boolean, p_next_page integer, p_last_error_kind text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET next_page       = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
           completed_at    = CASE WHEN p_complete THEN now() ELSE completed_at END,
           last_error_kind = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
           running_since   = NULL,
           lease_token     = NULL,
           heartbeat_at    = now(),
           updated_at      = now()
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- (4) release: libera o lease preservando o next_page (erro inesperado), SÓ para o dono.
CREATE OR REPLACE FUNCTION public.vendas_sync_release_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_last_error_kind text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET running_since = NULL, lease_token = NULL, last_error_kind = p_last_error_kind,
           heartbeat_at = now(), updated_at = now()
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Fronteira: só service_role (a edge). Função nova nasce com EXECUTE para anon e
-- authenticated (default privilege do Supabase) — REVOKE nominal, não só PUBLIC.
REVOKE ALL ON FUNCTION public.vendas_sync_lease_acquire_fenced(text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_heartbeat_fenced(text, date, date, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_finish_fenced(text, date, date, uuid, boolean, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_release_fenced(text, date, date, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendas_sync_lease_acquire_fenced(text, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_heartbeat_fenced(text, date, date, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_finish_fenced(text, date, date, uuid, boolean, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_release_fenced(text, date, date, uuid, text) TO service_role;

-- ─────────────── RPCs antigas: só agem sobre lease NÃO cercado ───────────────
-- CREATE OR REPLACE com a MESMA assinatura preserva o ACL (service_role-only) de 20260617133633.
-- Corpos de prod conferidos por psql-ro em 2026-10-15 (md5 idêntico ao repo): a única
-- mudança é a linha do lease_token.

CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire(
  p_account text, p_date_from date, p_date_to date
) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = now(), heartbeat_at = now(), updated_at = now(),
         lease_token   = NULL
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING COALESCE(next_page, 1);
$$;

CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat(
  p_account text, p_date_from date, p_date_to date, p_page integer
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET heartbeat_at = now(), next_page = p_page, updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND running_since IS NOT NULL
     AND lease_token IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.vendas_sync_release(
  p_account text, p_date_from date, p_date_to date, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = NULL, last_error_kind = p_last_error_kind,
         heartbeat_at = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND lease_token IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.vendas_sync_finish(
  p_account text, p_date_from date, p_date_to date,
  p_complete boolean, p_next_page integer, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET next_page       = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
         completed_at     = CASE WHEN p_complete THEN now() ELSE completed_at END,
         last_error_kind  = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
         running_since    = NULL,
         heartbeat_at     = now(),
         updated_at       = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND lease_token IS NULL;
$$;

-- PostgREST enxerga as RPCs novas sem esperar o reload periódico do cache de schema
-- (lição do #2916: PGRST202 de cache velho num banco que já tem a função).
NOTIFY pgrst, 'reload schema';

-- ─────────────────────────── Postcondição ───────────────────────────
-- Mesmo predicado de db/valida-vendas-sync-cursor-fencing.sql. Lê catálogo; não invoca.
DO $pos$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'vendas_sync_cursor'
                    AND column_name = 'lease_token' AND data_type = 'uuid') THEN
    RAISE EXCEPTION 'POS1 FALHOU: coluna vendas_sync_cursor.lease_token (uuid) ausente';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_lease_acquire_fenced(text,date,date)',
    'public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)',
    'public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)',
    'public.vendas_sync_release_fenced(text,date,date,uuid,text)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'POS2 FALHOU: % ausente', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS3 FALHOU: service_role sem EXECUTE em % — a edge nao conseguiria usar', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS4 FALHOU: % executavel por anon/authenticated — o lease seria manipulavel pelo browser', v_fn;
    END IF;
    v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)), '--[^\n]*', '', 'g');
    IF v_fn LIKE '%acquire%' THEN
      IF v_src !~ 'lease_token\s*=\s*gen_random_uuid\(\)' THEN
        RAISE EXCEPTION 'POS5 FALHOU: % nao emite token novo', v_fn;
      END IF;
    ELSIF v_src !~ 'AND lease_token = p_lease_token' THEN
      RAISE EXCEPTION 'POS5 FALHOU: % nao exige o token do dono', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_heartbeat(text,date,date,integer)',
    'public.vendas_sync_finish(text,date,date,boolean,integer,text)',
    'public.vendas_sync_release(text,date,date,text)'
  ] LOOP
    v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)), '--[^\n]*', '', 'g');
    IF v_src IS NULL OR v_src !~ 'AND lease_token IS NULL' THEN
      RAISE EXCEPTION 'POS6 FALHOU: % (caminho antigo) ainda age sobre lease cercado', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS7 FALHOU: % ganhou EXECUTE para authenticated', v_fn;
    END IF;
  END LOOP;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_lease_acquire(text,date,date)'));
  IF v_src IS NULL OR v_src !~ 'lease_token\s*=\s*NULL' THEN
    RAISE EXCEPTION 'POS8 FALHOU: o acquire antigo nao zera o token — roubar lease cercado deixaria o worker novo dono';
  END IF;
END
$pos$;
