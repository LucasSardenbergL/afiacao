-- ============================================================
-- Claim do envio CONFERIDO pelos itens (residual Codex r4 do #4215)
--
-- A corrida: um orçamento aberto em DUAS abas. Na A o vendedor edita e salva localmente
-- (useSalesOrderEdit, UPDATE condicionado por updated_at). Na B, aberta ANTES, ele converte
-- (SalesQuotes → edge criar_pedido) com os itens que a tela B leu. A edge monta o PV com os
-- itens do BODY e nunca os comparava com sales_orders.items: o PV saía com os itens/total
-- VELHOS, a linha ficava `enviado` com os NOVOS, e (oben) a reserva ATP — que lê a LINHA —
-- divergia do PV. Dois totais para a mesma venda, sem aviso.
--
-- O conserto vive no ponto atômico que já existia: o claim do envio (lock de linha de
-- sales_orders, migration 20261120230001). sales_order_reivindicar_envio_conferido só carimba
-- se, ALÉM de deleted_at IS NULL, a projeção money-path dos itens da LINHA (código Omie,
-- quantidade, valor unitário, na ordem) for IGUAL à dos itens que vão ao Omie. As duas ordens
-- da corrida fecham:
--   • A salva ANTES do claim de B → a projeção difere → `itens_divergentes`, o PV não nasce.
--   • B reivindica ANTES de A salvar → o claim é um UPDATE, o trigger update_sales_orders_updated_at
--     move a versão, e o UPDATE local de A (que exige o updated_at da abertura) não casa.
-- Sob READ COMMITTED o UPDATE que espera o lock re-avalia o WHERE na versão nova (EvalPlanQual):
-- a projeção é recalculada sobre os itens que A acabou de gravar.
--
-- Não depende do front: nenhum bundle manda versão; a edge passa os itens que ela mesma envia.
-- Medido em prod (2026-11-26): 27/27 pedidos do app com PV têm a projeção da linha IGUAL à do
-- `det` enviado — os envios legítimos passam.
--
-- A função antiga (1 argumento) FICA: é a que a edge v1.51 chama até o deploy da v1.52.
-- RPC só da edge (service_role).
-- ============================================================
BEGIN;

-- Projeção money-path de uma lista de itens: [[codigo, quantidade, valor_unitario], …] na ordem.
-- numeric ⇒ 1.70 e 1.7 comparam iguais (jsonb compara número por valor). Campo ausente vira null
-- na tupla e a comparação falha (precisão > recall). Não-array ⇒ NULL.
CREATE OR REPLACE FUNCTION public.sales_order_itens_projecao_envio(p_itens jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_itens) = 'array' THEN COALESCE((
      SELECT jsonb_agg(
               jsonb_build_array(
                 (e->>'omie_codigo_produto')::numeric,
                 (e->>'quantidade')::numeric,
                 (e->>'valor_unitario')::numeric)
               ORDER BY o)
        FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS x(e, o)
    ), '[]'::jsonb)
  END;
$$;

COMMENT ON FUNCTION public.sales_order_itens_projecao_envio(jsonb) IS
  'Projeção [[omie_codigo_produto, quantidade, valor_unitario], …] (numeric, na ordem) usada pelo '
  'claim conferido do envio ao Omie. Migration 20261126190127.';

CREATE OR REPLACE FUNCTION public.sales_order_reivindicar_envio_conferido(
  p_sales_order_id uuid,
  p_itens jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_proj jsonb := public.sales_order_itens_projecao_envio(p_itens);
  v_excluido boolean;
BEGIN
  IF v_proj IS NULL OR v_proj = '[]'::jsonb
     OR jsonb_path_exists(v_proj, '$[*][*] ? (@ == null)') THEN
    RAISE EXCEPTION 'p_itens inválido: lista vazia ou item sem código/quantidade/valor'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.sales_orders
     SET envio_omie_reivindicado_em = now()
   WHERE id = p_sales_order_id
     AND deleted_at IS NULL
     AND public.sales_order_itens_projecao_envio(items) = v_proj;
  IF FOUND THEN
    RETURN 'reivindicado';
  END IF;

  -- Diagnóstico (sem lock): só escolhe a mensagem. Qualquer não-'reivindicado' RECUSA o envio.
  SELECT deleted_at IS NOT NULL INTO v_excluido
    FROM public.sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN
    RETURN 'ausente';
  END IF;
  IF v_excluido THEN
    RETURN 'excluido';
  END IF;
  RETURN 'itens_divergentes';
END;
$$;

COMMENT ON FUNCTION public.sales_order_reivindicar_envio_conferido(uuid, jsonb) IS
  'Claim atômico do envio ao Omie: carimba envio_omie_reivindicado_em só se o pedido não está '
  'excluído E os itens da linha batem com os enviados. Devolve reivindicado | itens_divergentes | '
  'excluido | ausente. Só service_role. Migration 20261126190127.';

REVOKE ALL ON FUNCTION public.sales_order_reivindicar_envio_conferido(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_order_reivindicar_envio_conferido(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sales_order_itens_projecao_envio(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_order_itens_projecao_envio(jsonb) TO service_role;

DO $post$
BEGIN
  IF to_regprocedure('public.sales_order_reivindicar_envio_conferido(uuid, jsonb)') IS NULL
     OR to_regprocedure('public.sales_order_itens_projecao_envio(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: claim conferido ausente — a edge v1.52 recusaria todo envio';
  END IF;
  IF to_regprocedure('public.sales_order_reivindicar_envio(uuid)') IS NULL THEN
    RAISE EXCEPTION 'A2 FALHOU: claim antigo sumiu — a edge v1.51 no ar recusaria todo envio';
  END IF;
  IF has_function_privilege('anon', 'public.sales_order_reivindicar_envio_conferido(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_order_reivindicar_envio_conferido(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: claim conferido executável por anon/authenticated — cliente carimbaria envio';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sales_order_reivindicar_envio_conferido(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — a edge não chamaria o claim conferido';
  END IF;
  -- Assert por EXECUÇÃO da projeção: número por valor, ordem importa, campo ausente não casa.
  IF public.sales_order_itens_projecao_envio('[{"omie_codigo_produto":1,"quantidade":2,"valor_unitario":1.70}]')
     IS DISTINCT FROM public.sales_order_itens_projecao_envio('[{"omie_codigo_produto":"1","quantidade":2.0,"valor_unitario":1.7,"descricao":"x"}]') THEN
    RAISE EXCEPTION 'A5 FALHOU: projeção não compara número por valor — envio legítimo seria recusado';
  END IF;
  IF public.sales_order_itens_projecao_envio('[{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":1},{"omie_codigo_produto":2,"quantidade":1,"valor_unitario":1}]')
     = public.sales_order_itens_projecao_envio('[{"omie_codigo_produto":2,"quantidade":1,"valor_unitario":1},{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":1}]') THEN
    RAISE EXCEPTION 'A6 FALHOU: projeção ignora a ordem — PV com itens trocados passaria';
  END IF;
  RAISE NOTICE 'claim conferido: 2 funções (só service_role) + claim antigo preservado + projeção por valor e ordem OK';
END
$post$;

COMMIT;
