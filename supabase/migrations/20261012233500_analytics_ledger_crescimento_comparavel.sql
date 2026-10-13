-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `dashboard.crescimento_comparavel_servido`
--
-- POR QUÊ: o card "Crescimento na base comparável" (Dashboard Master) mede uso para liberar a fase
-- seguinte (ranking normalizado, #4) — sinal que DECIDE. Só no PostHog ele é censurado: o Chrome do
-- founder, o principal leitor do card, tem bloqueador que corta `us.i.posthog.com` (medido em
-- 2026-10-12: boots do app em `telemetria_probes` às 23:25/23:27 UTC e ZERO evento web no PostHog;
-- docs/agent/analytics.md §"A amostra é CENSURADA"). O ledger grava pelo domínio do app e é imune.
-- Decisão do founder: 2026-10-12. Diário: docs/historico/crescimento-base-comparavel.md.
--
-- O corpo é o da `20260908055405_analytics_ledger_navegacao_postcondicao_corrigida.sql`, conferido
-- IGUAL à prod em 2026-10-12 (md5(prosrc) 89e92e3178d37ce4dc83581bc2caaa2d = md5 de "\n" + corpo da
-- migration). Muda SÓ a linha da allowlist; a postcondição ganha o evento novo e passa a exigir os
-- três (recriação que esquece um antigo é o modo de falha do CREATE OR REPLACE).
-- Predicados da postcondição rodados contra a PROD antes desta entrega (função ainda antiga): todos
-- passam, exceto o do evento novo — que é o que esta migration muda.
--
-- Aplicação: `bun run db:aplicar db/2026-10-12-analytics-ledger-crescimento-comparavel.sql` (mesmo
-- corpo, sem o envelope — paridade conferida no cabeçalho daquele arquivo).
-- ============================================================

BEGIN;

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
  IF p_evento NOT IN ('carteira.mixgap_servido', 'navegacao.rota_servida', 'dashboard.crescimento_comparavel_servido') THEN
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
-- CREATE OR REPLACE preserva o ACL (só DROP+CREATE o reseta), mas reemitir é
-- idempotente e faz esta migration ser autossuficiente.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- Postcondição embutida — migration que não pegou NÃO termina em silêncio
-- ------------------------------------------------------------
-- Lê o CATÁLOGO, nunca invoca a função: invocar exige EXECUTE (o `psql-ro` não
-- tem, e não ter é o REVOKE funcionando) e produziria falso-negativo.
--
-- ⚠️ Cada predicado abaixo foi RODADO contra a PROD antes desta entrega, com a
-- função ainda na versão ANTIGA: todos devolveram o valor que os deixa passar,
-- exceto o do evento novo — que é justamente o que esta migration muda. Sem
-- essa medição, um predicado errado se apresenta como "a migration não pegou".
DO $post$
DECLARE
  v_oid oid;
  v_def text;
BEGIN
  -- `to_regprocedure` resolve pela assinatura de TIPOS e devolve NULL (não
  -- erro) quando não acha — não depende de como o catálogo formata a lista de
  -- argumentos, que foi onde a versão anterior desta migration se enganou.
  v_oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: analytics_ledger_registrar(text,text,jsonb) nao existe — o ledger inteiro fica mudo';
  END IF;

  v_def := pg_get_functiondef(v_oid);

  IF v_def NOT LIKE '%dashboard.crescimento_comparavel_servido%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem dashboard.crescimento_comparavel_servido — o card chamaria e levaria 22023';
  END IF;

  -- Recriação que ESQUECE um evento antigo é o modo de falha do CREATE OR REPLACE.
  IF v_def NOT LIKE '%navegacao.rota_servida%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist perdeu navegacao.rota_servida — regressao do evento que ja existia';
  END IF;

  -- Recriação que ESQUECE o evento antigo é o modo de falha do CREATE OR
  -- REPLACE: passa, e mata um sinal que já estava no ar.
  IF v_def NOT LIKE '%carteira.mixgap_servido%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist perdeu carteira.mixgap_servido — regressao do evento que ja existia';
  END IF;

  IF v_def NOT LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: funcao perdeu SECURITY DEFINER — o INSERT passaria a depender da RLS de quem chama';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem EXECUTE — o ledger nao registra nada';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon COM EXECUTE — escrita no banco disparavel sem autenticacao';
  END IF;

  -- PUBLIC é o pseudo-role de grantee VAZIO no ACL. `has_function_privilege`
  -- aceita o nome 'public' para ele, e cobre também o caso `proacl IS NULL`,
  -- em que o Postgres aplica o default de fábrica (EXECUTE para PUBLIC).
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: PUBLIC com EXECUTE — o REVOKE nao pegou';
  END IF;
END
$post$;

COMMIT;
