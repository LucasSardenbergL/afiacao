-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `navegacao.rota_servida`
--
-- Por quê: a re-avaliação de 2026-09-08 (docs/historico/proxy-posthog-reavaliado.md)
-- manteve a recusa do proxy first-party e apontou a via que responde à pergunta
-- do founder — "quanto do que entregamos chega a ser usado?" — sem contornar
-- bloqueador nenhum: o sinal que DECIDE nasce em canal nosso.
--
-- O probe pareado mediu, em 2026-09-07, um aparelho com 173 registros gravados
-- via PostgREST e ZERO eventos no PostHog desde 2026-08-20 — 91% das sessões do
-- único usuário ativo são invisíveis no canal censurável. Falta CANAL, não
-- sensor: o PageViewTracker já emite $pageview em toda rota.
--
-- O que muda: UMA linha da allowlist. A função é recriada por inteiro porque
-- CREATE OR REPLACE exige o corpo completo — o resto é byte-a-byte igual ao que
-- roda em PROD hoje (conferido por pg_get_functiondef antes de escrever isto:
-- md5 61a056d04526d3daa3b1d4ae08e3d9ec, allowlist 'carteira.mixgap_servido').
--
-- Cardinalidade e privacidade ficam do lado do CLIENTE, em
-- src/lib/analytics-rota-canonica.ts: a chave é a FORMA da rota (`/orders/:id`),
-- com todo segmento identificador mascarado por regra fail-closed. O teto de
-- 500 linhas/titular/dia da própria função continua sendo o limite duro.
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
  IF p_evento NOT IN ('carteira.mixgap_servido', 'navegacao.rota_servida') THEN
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
-- idempotente e faz esta migration ser autossuficiente se alguém a rodar num
-- ambiente onde a função foi recriada por outro caminho.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- Postcondição embutida — migration que não pegou NÃO termina em silêncio
-- ------------------------------------------------------------
-- Lê o CATÁLOGO, nunca invoca a função: invocar exige EXECUTE (o `psql-ro` não
-- tem, e não ter é o REVOKE funcionando) e produziria falso-negativo.
DO $post$
DECLARE
  v_oid oid;
  v_def text;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'analytics_ledger_registrar'
    AND pg_get_function_identity_arguments(p.oid) = 'text, text, jsonb';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: analytics_ledger_registrar(text,text,jsonb) nao existe — o ledger inteiro fica mudo';
  END IF;

  v_def := pg_get_functiondef(v_oid);

  IF v_def NOT LIKE '%navegacao.rota_servida%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem navegacao.rota_servida — o front chamaria e levaria 22023 em toda navegacao';
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

  -- Entrada de ACL com grantee vazio (`=X/owner`) é o EXECUTE de PUBLIC. Se o
  -- proacl for NULL, o default do Postgres é EXECUTE para PUBLIC — pior ainda.
  IF (SELECT proacl IS NULL OR array_to_string(proacl, ',') LIKE '%=X/%'
        FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: PUBLIC com EXECUTE (ou ACL default) — o REVOKE nao pegou';
  END IF;
END
$post$;

COMMIT;
