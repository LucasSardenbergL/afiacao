-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `venda.painel_aberto`
--
-- POR QUÊ: o painel do founder do programa Venda por cliente (`/admin/venda-cliente`, Task 7) nasce com
-- o sensor de uso no LEDGER (CLAUDE.md: "superfície de uso nasce com o sensor"; o PostHog é censurado no
-- Chrome do founder — docs/agent/analytics.md). 1 evento por titular/dia (dedup da RPC).
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md, Task 7 Step 5.
--
-- O corpo é o VIVO da prod, lido por psql-ro em 2026-10-20 (md5(prosrc) 977288a80b440c103479f953bb8f3dae,
-- = 20261012233500_analytics_ledger_crescimento_comparavel). Muda SÓ a linha da allowlist; a PÓS exige os
-- md5 EXATO deste corpo (recriação que esquece um evento antigo é o modo de falha do CREATE OR REPLACE).
-- Molde TRAVA → PRE → CREATE → PÓS (.claude/skills/lovable-db-operator/references/sql-house-style.md):
-- outra sessão que recrie esta função depois do meu pré-voo faz a PRE abortar, em vez de ser apagada.
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR (arquivo sem BEGIN/COMMIT).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (volatilidade VIVA = VOLATILE) segura o objeto até o fim da transação.
DO $trava$
BEGIN
  IF to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.analytics_ledger_registrar(text, text, jsonb) VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('977288a80b440c103479f953bb8f3dae', 'c4628e2c1cf94bbcd022ade37f7ddf92') THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_ledger_registrar vivo (md5 %) nao e o predecessor revisado nem este — outra sessao mexeu; reconcilie antes', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(p_evento text, p_chave text, p_props jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_dia  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  -- SECURITY DEFINER bypassa RLS ⇒ o gate vive AQUI, na fronteira.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: exige usuario autenticado'
      USING ERRCODE = '28000';
  END IF;

  -- Allowlist FECHADA: o ledger não é canal genérico de escrita no banco.
  IF p_evento NOT IN ('carteira.mixgap_servido', 'navegacao.rota_servida', 'dashboard.crescimento_comparavel_servido',
                      'venda.painel_aberto') THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: evento % fora da allowlist', p_evento
      USING ERRCODE = '22023';
  END IF;

  IF pg_column_size(coalesce(p_props, '{}'::jsonb)) > 2048 THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: props acima do teto'
      USING ERRCODE = '22023';
  END IF;

  -- Teto por titular/dia — guard contra flood por chave variada. Silencioso de
  -- propósito: telemetria nunca quebra a tela de quem está trabalhando.
  IF (
    SELECT count(*) FROM public.analytics_outbox
    WHERE user_id = v_uid AND ocorrido_em > now() - interval '1 day'
  ) >= 500 THEN
    RETURN;
  END IF;

  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
  VALUES (
    p_evento,
    v_uid::text,                       -- casa com identify(userId) do front
    v_uid,
    coalesce(p_props, '{}'::jsonb),
    -- left() protege o teto do CHECK e do índice B-tree; o dia fecha a janela
    -- de dedup (mesmo estado revisto amanhã é sinal NOVO, não repetição).
    'ledger:' || v_uid::text || ':' || p_evento || ':' || left(coalesce(p_chave, ''), 100) || ':' || v_dia
  )
  ON CONFLICT (chave_dedup) DO NOTHING;
END;
$function$;

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- PÓS: lê o CATÁLOGO, nunca invoca a função (o psql-ro não tem EXECUTE — e não ter é o REVOKE funcionando).
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
  v_def text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: analytics_ledger_registrar(text,text,jsonb) nao existe — o ledger inteiro fica mudo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) <> 'c4628e2c1cf94bbcd022ade37f7ddf92' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo de analytics_ledger_registrar nao e o deste arquivo (allowlist com venda.painel_aberto + os 3 antigos)';
  END IF;
  -- md5 EXATO: cobre a allowlist inteira (os 4 eventos) e o resto do corpo de uma vez
  v_def := pg_get_functiondef(v_oid);
  IF v_def NOT LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: funcao perdeu SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem EXECUTE — o ledger nao registra nada';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon/PUBLIC COM EXECUTE — escrita no banco disparavel sem autenticacao';
  END IF;
  RAISE NOTICE 'analytics_ledger_registrar OK: 4 eventos na allowlist (venda.painel_aberto novo), ACL fechada';
END
$post$;
