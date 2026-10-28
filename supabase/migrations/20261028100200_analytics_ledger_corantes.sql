-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `reposicao.corantes_aberta` (sensor da aba Corantes)
--
-- POR QUÊ: a aba "Corantes" do baixo giro (giro de corante, Fase 1) nasce com sensor de uso, e a
-- Fase 2 é DECIDIDA por ele (docs/historico/fase-sem-sinal.md; spec §11.3). O ledger grava pelo
-- domínio do app (PostHog é censurado no Chrome do founder — docs/agent/analytics.md).
-- Spec:  docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §11.3
-- Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Task 4)
--
-- O corpo é o da 20261028031612_analytics_ledger_financeiro_ciclo_aberto.sql (outra sessão, mergeada e
-- APLICADA antes desta: md5 7eeebf3cbab6a16c30d430737a57b955 lido da PROD em 2026-10-28 via psql-ro); muda SÓ
-- a linha da allowlist (o teste de paridade src/lib/__tests__/analytics-ledger-paridade.test.ts lê ESTE
-- arquivo). Molde TRAVA → PRE → CREATE → PÓS: a PRE aborta se o corpo vivo não for esse nem este (b9f9b6cb…).
-- A PÓS exige os 9 eventos: recriação que esquece um antigo é o modo de falha do REPLACE.
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261028100200_analytics_ledger_corantes.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o fim.
DO $trava$
BEGIN
  ALTER FUNCTION public.analytics_ledger_registrar(text, text, jsonb) VOLATILE;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('7eeebf3cbab6a16c30d430737a57b955', 'b9f9b6cb56f40e9f44fd247f69133e24') THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_ledger_registrar vivo (md5 %) não é o predecessor revisado nem este — outra sessão mexeu na allowlist; reconcilie antes', v_vivo;
  END IF;
END
$pre$;

-- Corpo = o da 20261028031612 (o predecessor revisado); muda SÓ a allowlist.
CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(
  p_evento text,
  p_chave  text,
  p_props  jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
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
                      'venda.ficha_aberta', 'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                      'financeiro.ciclo_aberto', 'reposicao.corantes_aberta') THEN
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
$fn$;

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon. Reemitir é idempotente.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
  v_def text;
  v_ev  text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'b9f9b6cb56f40e9f44fd247f69133e24' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo vivo não é o desta migration';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  FOREACH v_ev IN ARRAY ARRAY['carteira.mixgap_servido', 'navegacao.rota_servida',
                              'dashboard.crescimento_comparavel_servido', 'venda.ficha_aberta',
                              'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                              'financeiro.ciclo_aberto', 'reposicao.corantes_aberta'] LOOP
    IF position(v_ev in v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem %', v_ev;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon executa o ledger';
  END IF;
END
$post$;
