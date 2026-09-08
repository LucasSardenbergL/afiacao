-- ============================================================
-- analytics_ledger_registrar — allowlist ganha `navegacao.rota_servida`
--
-- ⚠️ SUPERSEDE `20260907223901_analytics_ledger_navegacao_rota_servida.sql`,
-- que **NÃO deve ser colada**: a postcondição dela tinha DOIS falso-negativos e
-- abortava a transação inteira, com a função em prod correta e intacta. Aquele
-- arquivo permanece no repo porque migration committada é imutável (é fonte de
-- DR), e é inofensivo: ele aborta antes de escrever qualquer coisa. Esta aqui é
-- autossuficiente — a anterior nunca chegou a aplicar nada.
--
-- Os dois defeitos, medidos na PROD em 2026-09-08 e corrigidos abaixo:
--   1. o lookup comparava `pg_get_function_identity_arguments(oid)` com
--      `'text, text, jsonb'`; o catálogo devolve
--      `'p_evento text, p_chave text, p_props jsonb'` — COM os nomes. Nunca
--      casava ⇒ "a função não existe" sobre uma função que existe.
--   2. o guard de PUBLIC usava `array_to_string(proacl,',') LIKE '%=X/%'`, que
--      casa `postgres=X/postgres` e QUALQUER outro grantee. O ACL de prod é
--      `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,
--      sandbox_exec_*=X/postgres}` — sem PUBLIC — e ainda assim dava TRUE.
-- A entrada de PUBLIC é a de grantee VAZIO (`=X/owner`); a asserção semântica
-- é `has_function_privilege('public', …)`, medida devolvendo `f` em prod.
--
-- ⇒ Lição embutida: **asserção de postcondição também se mede contra a PROD
-- antes de entregar.** Falso-negativo é o modo de falha perigoso — empurra para
-- re-aplicar (ou "consertar") algo que está são (`database.md`, FU4-E/#1462).
--
-- Por quê a mudança de allowlist: ver `docs/historico/proxy-posthog-reavaliado.md`.
-- O corpo da função é byte-a-byte igual ao que roda em prod (conferido por
-- `pg_get_functiondef`, md5 61a056d04526d3daa3b1d4ae08e3d9ec) — só a linha da
-- allowlist muda. Cardinalidade e privacidade ficam no cliente, em
-- `src/lib/analytics-rota-canonica.ts`.
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

  -- PUBLIC é o pseudo-role de grantee VAZIO no ACL. `has_function_privilege`
  -- aceita o nome 'public' para ele, e cobre também o caso `proacl IS NULL`,
  -- em que o Postgres aplica o default de fábrica (EXECUTE para PUBLIC).
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: PUBLIC com EXECUTE — o REVOKE nao pegou';
  END IF;
END
$post$;

COMMIT;
