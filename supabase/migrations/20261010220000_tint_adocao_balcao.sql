-- ============================================================================================
-- 20261010220000 · tint_adocao_balcao — o painel mostra se o balcão vende cor PELO APP
-- Prova: db/test-tint-adocao-balcao.sh (PG17: função real, RLS real sob authenticated)
--
-- O QUE: dos pedidos com cor nos últimos N dias, quantos saíram do seletor do app (item com
-- `tint_formula_id`) — o resto é cor digitada / vinda do Omie. É o sensor decisório de adoção
-- (docs/agent/tintometrico.md § Adoção do balcão): o PostHog é censurado (parque em build antigo),
-- o PEDIDO não é. Medido em prod (2026-10-10), universo de venda: 30d → 37 pedidos com cor, 0 pelo app.
--
-- CONTAGEM POR VALOR, não por texto: `items::text LIKE '%tint_formula_id%'` contaria um
-- `"tint_formula_id": null` como pedido pelo app. Aqui só conta chave com valor não vazio.
--
-- SEGURANÇA: SECURITY INVOKER — a RLS de quem chama vale (staff lê todos os pedidos; um customer só
-- conta os próprios). Nada aqui escreve. p_dias fora de 1..365 (ou NULL) cai em 30.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação
-- (não há BEGIN/COMMIT aqui). Idempotente. A postcondição no fim aborta tudo se o estado final não for
-- o desenhado. ORDEM DO DEPLOY: esta migration ANTES do Publish (sem a RPC o KPI mostra "—", a zona
-- do painel continua de pé).
-- ============================================================================================
CREATE OR REPLACE FUNCTION public.tint_adocao_balcao(p_dias integer DEFAULT 30)
 RETURNS TABLE (pedidos_com_cor bigint, pelo_app bigint)
 LANGUAGE sql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
  WITH pedidos AS (
    SELECT
      EXISTS (SELECT 1 FROM jsonb_array_elements(so.items) e
               WHERE nullif(e->>'tint_nome_cor', '') IS NOT NULL) AS com_cor,
      EXISTS (SELECT 1 FROM jsonb_array_elements(so.items) e
               WHERE nullif(e->>'tint_formula_id', '') IS NOT NULL) AS pelo_app
    FROM public.sales_orders so
    WHERE so.created_at > now() - make_interval(days => CASE WHEN p_dias BETWEEN 1 AND 365 THEN p_dias ELSE 30 END)
      AND jsonb_typeof(so.items) = 'array'
      -- universo de VENDA canônico (src/lib/farmer/universo-pedidos.ts): cancelado/rascunho/
      -- pendente/orçamento e pedido apagado não são venda — nem pelo app, nem fora dele.
      AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL
  )
  SELECT count(*) FILTER (WHERE com_cor OR pelo_app),
         count(*) FILTER (WHERE pelo_app)
  FROM pedidos;
$function$;

COMMENT ON FUNCTION public.tint_adocao_balcao(integer) IS
  'Adoção do balcão: pedidos com cor nos últimos N dias e quantos saíram do seletor do app (tint_formula_id). SECURITY INVOKER.';

-- Função nova nasce com EXECUTE para PUBLIC e, no Supabase, com grant explícito para anon:
-- revogar PUBLIC não tira o anon (CLAUDE.md, armadilha de RLS) — revoga-se pelo nome.
REVOKE ALL ON FUNCTION public.tint_adocao_balcao(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tint_adocao_balcao(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.tint_adocao_balcao(integer) TO authenticated, service_role;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.tint_adocao_balcao(integer)');
  v_n   integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: tint_adocao_balcao(integer) não existe — o KPI de adoção ficaria "—" para sempre';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P2 FALHOU: a função saiu SECURITY DEFINER — contaria pedidos por cima da RLS de quem chama';
  END IF;
  IF NOT coalesce((SELECT 'search_path=""' = ANY (proconfig) FROM pg_proc WHERE oid = v_oid), false) THEN
    RAISE EXCEPTION 'P3 FALHOU: search_path da função não é vazio';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: authenticated não executa — o painel recebe erro';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: anon executa a função — o grant default não foi revogado pelo nome';
  END IF;
  -- execução de verdade: devolve exatamente 1 linha (contagem nunca some), sem erro de runtime
  SELECT count(*) INTO v_n FROM public.tint_adocao_balcao(30);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P6 FALHOU: tint_adocao_balcao(30) devolveu % linha(s) — esperado 1', v_n;
  END IF;
  RAISE NOTICE 'tint_adocao_balcao: invoker, search_path vazio, authenticated sim, anon não, executa';
END
$post$;
