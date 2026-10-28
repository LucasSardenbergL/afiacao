-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `financeiro.ciclo_aberto` (aba Ciclo do Capital de giro)
--
-- POR QUÊ: plano de melhoria v3, decisão 3 do founder (2026-10-21): a fase seguinte do ciclo
-- financeiro (alerta de vencimento com desconto, piloto desconto/degrau) é desejada, e ela só é
-- liberada com SINAL de uso da fase atual (docs/historico/fase-sem-sinal.md). Hoje a aba só emite
-- `track('financeiro.ciclo_aberto')`, que vai ao PostHog — censurado no Chrome do founder, o único
-- leitor da aba (docs/agent/analytics.md §"A amostra é CENSURADA"). O ledger grava pelo domínio do
-- app. UM evento e só isso (o sensor M de 4 seções foi cortado no plano):
--   financeiro.ciclo_aberto — a aba Ciclo montou (chave fixa `aba`: 1 linha por titular/dia).
-- Plano: docs/superpowers/plans/2026-10-21-plano-melhoria-v3/README.md §5, resposta 3.
--
-- O corpo é o da `20261020202720_analytics_ledger_venda_cliente.sql`. Muda SÓ a linha da
-- allowlist. Molde TRAVA → PRE → CREATE → PÓS (recriar objeto VIVO): a PRE aborta se o corpo vivo
-- não for o predecessor revisado (md5(prosrc) 6eaf1d41626ece3a6fe6b51617788f21, lido da PROD em
-- 2026-10-28 via psql-ro) nem este — outra sessão que tenha mexido na allowlist depois NÃO é apagada.
-- A postcondição exige os 8 eventos (recriação que esquece um antigo é o modo de falha do REPLACE).
--
-- Aplicação: `bun run db:aplicar db/2026-10-28-analytics-ledger-financeiro-ciclo.sql` (mesmo corpo,
-- sem o envelope — paridade conferida no cabeçalho daquele arquivo).
-- ============================================================

BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o COMMIT.
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
  IF v_vivo IS NULL OR v_vivo NOT IN ('6eaf1d41626ece3a6fe6b51617788f21', '7eeebf3cbab6a16c30d430737a57b955') THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_ledger_registrar vivo (md5 %) nao e o predecessor revisado nem este — outra sessao mexeu na allowlist; reconcilie antes', v_vivo;
  END IF;
END
$pre$;

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
                      'financeiro.ciclo_aberto') THEN
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

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon.
-- CREATE OR REPLACE preserva o ACL (só DROP+CREATE o reseta); reemitir é idempotente.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- Postcondição embutida: lê o CATÁLOGO (invocar exige EXECUTE, que o psql-ro não tem).
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
  v_def text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: analytics_ledger_registrar(text,text,jsonb) nao existe — o ledger inteiro fica mudo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM '7eeebf3cbab6a16c30d430737a57b955' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo vivo nao e o desta migration';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF v_def NOT LIKE '%carteira.mixgap_servido%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem carteira.mixgap_servido';
  END IF;
  IF v_def NOT LIKE '%navegacao.rota_servida%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem navegacao.rota_servida';
  END IF;
  IF v_def NOT LIKE '%dashboard.crescimento_comparavel_servido%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem dashboard.crescimento_comparavel_servido';
  END IF;
  IF v_def NOT LIKE '%venda.ficha_aberta%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem venda.ficha_aberta';
  END IF;
  IF v_def NOT LIKE '%venda.contato_registrado%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem venda.contato_registrado';
  END IF;
  IF v_def NOT LIKE '%venda.tel_clicado%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem venda.tel_clicado';
  END IF;
  IF v_def NOT LIKE '%venda.painel_aberto%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem venda.painel_aberto';
  END IF;
  IF v_def NOT LIKE '%financeiro.ciclo_aberto%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem financeiro.ciclo_aberto';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon com EXECUTE no ledger';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem EXECUTE — o front levaria 42501 calado (fail-open)';
  END IF;
  RAISE NOTICE 'analytics_ledger_registrar: allowlist com os 8 eventos, ACL ok';
END
$post$;

COMMIT;
