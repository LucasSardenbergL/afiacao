-- FU4-F (A de 2) — A margem persistida por cliente passa a sair por uma RPC com gate de PROJEÇÃO.
--
-- Achado (review adversário de jul/2026, medido por psql-ro em 2026-10-14):
--   has_column_privilege('authenticated','public.farmer_client_scores','gross_margin_pct','SELECT') = true,
--   502 linhas com valor, policy fcs_select_carteira = cap_carteira_ler OR carteira_visivel_para, sem
--   GRANT por coluna. A vendedora lê a margem bruta de cada cliente da carteira DIRETO da tabela,
--   contornando o gate de projeção de get_carteira_margem_faixa() (#1543). Cliente que compra 1 SKU:
--   a margem inverte o custo unitário.
--
-- Esta migration é ADITIVA (só cria a RPC). A B (20261014120100) é a que fecha a coluna.
-- ORDEM DE APPLY: (1) esta → (2) Publish do front que lê a margem por aqui → (3) a B.
-- Aplicar a B antes do Publish derruba as telas que ainda leem a coluna (o staff É authenticated).
--
-- Contrato:
--   · escopo de LINHA idêntico a fcs_select_carteira (cap_carteira_ler OR carteira_visivel_para);
--   · o NÚMERO só sai sob private.cap_custo_ler — os demais recebem NULL com margem_visivel=false,
--     que o front distingue de "margem não apurada" (NULL com margem_visivel=true). Sem o flag, o
--     NULL do gate viraria a legenda "sem compra na janela" — fato fabricado;
--   · nenhum parâmetro entra numa comparação com a margem (lição do #1520: o caller não escolhe
--     limiar) e a saída é ordenada por customer_user_id, nunca pela margem;
--   · o valor é o PERSISTIDO pela edge calculate-scores — a mesma grandeza que as telas liam da
--     tabela. Trocar pelo cálculo ao vivo de margem_cliente_agregada() mudaria o número em silêncio.
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>` (o executor fornece
-- a transação); no SQL Editor, envolver em BEGIN; … COMMIT;.

DO $pre$
BEGIN
  IF to_regclass('public.farmer_client_scores') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.farmer_client_scores ausente';
  END IF;
  IF to_regprocedure('private.cap_custo_ler(uuid)') IS NULL
     OR to_regprocedure('private.cap_carteira_ler(uuid)') IS NULL
     OR to_regprocedure('private.carteira_visivel_para(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: helpers de capability (cap_custo_ler/cap_carteira_ler/carteira_visivel_para) ausentes';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.get_scores_margem(
  p_customer_ids uuid[] DEFAULT NULL,
  p_farmer_id    uuid   DEFAULT NULL
)
RETURNS TABLE(customer_user_id uuid, gross_margin_pct numeric, margem_visivel boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid      uuid;
  v_pode_num boolean;
  v_cap_todo boolean;
BEGIN
  -- Atribuição no CORPO (erro em DECLARE não é capturável pelo bloco).
  v_uid := (SELECT auth.uid());

  -- Fail-closed: sem identidade, zero linhas.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  v_pode_num := COALESCE(private.cap_custo_ler(v_uid), false);
  v_cap_todo := COALESCE(private.cap_carteira_ler(v_uid), false);

  RETURN QUERY
  SELECT s.customer_user_id,
         -- Gate de PROJEÇÃO: esconde na SAÍDA.
         CASE WHEN v_pode_num THEN s.gross_margin_pct END,
         v_pode_num
    FROM public.farmer_client_scores s
   WHERE (p_customer_ids IS NULL OR s.customer_user_id = ANY (p_customer_ids))
     AND (p_farmer_id IS NULL OR s.farmer_id = p_farmer_id)
     -- Escopo espelhando fcs_select_carteira.
     AND (v_cap_todo OR COALESCE(private.carteira_visivel_para(s.customer_user_id, v_uid), false))
   ORDER BY s.customer_user_id;
END;
$function$;

COMMENT ON FUNCTION public.get_scores_margem(uuid[], uuid) IS
  'Margem bruta PERSISTIDA (farmer_client_scores.gross_margin_pct) por cliente, no escopo de fcs_select_carteira. '
  'O número só sai sob private.cap_custo_ler; os demais recebem NULL com margem_visivel=false. '
  'Substitui a leitura direta da coluna, que a 20261014120100 fecha para authenticated (FU4-F).';

-- ACL: o Supabase concede EXECUTE por NOME a anon (default privileges) — REVOKE das DUAS pontas.
REVOKE ALL ON FUNCTION public.get_scores_margem(uuid[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_scores_margem(uuid[], uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_scores_margem(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_scores_margem(uuid[], uuid) TO service_role;

DO $pos$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.get_scores_margem(uuid[],uuid)') IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: public.get_scores_margem(uuid[],uuid) nao existe';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_scores_margem(uuid[],uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'POS2 FALHOU: get_scores_margem nao e SECURITY DEFINER - a vendedora leria pela RLS sem o gate';
  END IF;
  IF has_function_privilege('anon', 'public.get_scores_margem(uuid[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS3 FALHOU: anon executa get_scores_margem';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_scores_margem(uuid[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS4 FALHOU: authenticated nao executa get_scores_margem - as telas ficariam sem margem';
  END IF;
  v_def := pg_get_functiondef('public.get_scores_margem(uuid[],uuid)'::regprocedure);
  IF position('cap_custo_ler' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POS5 FALHOU: o corpo de get_scores_margem perdeu o gate de projecao';
  END IF;
END
$pos$;
