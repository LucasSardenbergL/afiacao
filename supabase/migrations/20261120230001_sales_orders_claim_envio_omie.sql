-- ============================================================
-- Disputa atômica envio × exclusão de pedido (Codex 2026-11-20, P1 do #4037)
--
-- A corrida: o `criar_pedido` lia `deleted_at` UMA vez e seguia; a Colacor não passa pelo gate ATP
-- (sem rastro em atp_decisoes). Se a exclusão consultava `PV_<id>` no Omie antes de o IncluirPedido
-- gravar, recebia "ausente" legitimamente e fazia o DELETE físico — e o PV nascia órfão no Omie.
--
-- O ponto atômico é o LOCK DE LINHA de sales_orders:
--   • sales_order_reivindicar_envio: carimba `envio_omie_reivindicado_em = now()` SÓ se
--     `deleted_at IS NULL`. 0 linhas ⇒ o envio RECUSA (pedido em exclusão ou já apagado).
--   • sales_order_excluir_sem_envio: DELETE SÓ se não há reivindicação nos últimos 10 min (a vida de
--     uma invocação de envio). Sob READ COMMITTED, o DELETE que espera o lock re-avalia o WHERE na
--     versão nova (EvalPlanQual): o carimbo concorrente é VISTO e a linha fica.
--   • o DELETE direto de orçamento/rascunho pelo front (SalesQuotes, via policy
--     sales_orders_delete_staff) ACABA: REVOKE DELETE de authenticated/anon + DROP da policy. Ele
--     furava a disputa (Codex 2026-11-20, BLOQUEANTE ×3: durante a conversão; depois da janela; e
--     em orçamento enviado ANTES desta migration, que tem carimbo NULL com PV possivelmente vivo).
--     Toda exclusão vai pela edge excluir_pedido, que consulta PV_<id> e exige ausência afirmada.
--     Build antigo do front passa a receber ERRO 42501 no DELETE (nunca apaga em silêncio).
-- RPCs: só a edge (service_role). A coluna nova NÃO entra na allowlist de UPDATE por coluna de
-- `authenticated` (migration 20260724120000): o cliente não consegue zerar o carimbo.
-- ============================================================
BEGIN;

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS envio_omie_reivindicado_em timestamptz;

COMMENT ON COLUMN public.sales_orders.envio_omie_reivindicado_em IS
  'Último início de envio ao Omie (criar_pedido), gravado por sales_order_reivindicar_envio. '
  'A exclusão (sales_order_excluir_sem_envio) recusa enquanto ele tem menos de 10 min. 1 escritor: a edge omie-vendas-sync.';

CREATE OR REPLACE FUNCTION public.sales_order_reivindicar_envio(p_sales_order_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH r AS (
    UPDATE public.sales_orders
       SET envio_omie_reivindicado_em = now()
     WHERE id = p_sales_order_id
       AND deleted_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM r);
$$;

-- p_somente_orcamento: a exclusão pedida pela tela de orçamentos só apaga se a linha AINDA é
-- orçamento/rascunho (tela desatualizada não apaga um pedido convertido — Codex P2).
DROP FUNCTION IF EXISTS public.sales_order_excluir_sem_envio(uuid);  -- forma de 1 argumento (nunca aplicada; limpeza)
CREATE OR REPLACE FUNCTION public.sales_order_excluir_sem_envio(p_sales_order_id uuid, p_somente_orcamento boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_n integer;
  v_status text;
BEGIN
  DELETE FROM public.sales_orders
   WHERE id = p_sales_order_id
     AND (envio_omie_reivindicado_em IS NULL
          OR envio_omie_reivindicado_em < now() - interval '10 minutes')
     AND (NOT p_somente_orcamento OR status IN ('orcamento', 'rascunho'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RETURN 'excluido';
  END IF;
  SELECT status INTO v_status FROM public.sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN
    RETURN 'ausente';
  END IF;
  IF p_somente_orcamento AND v_status NOT IN ('orcamento', 'rascunho') THEN
    RETURN 'nao_e_orcamento';
  END IF;
  RETURN 'envio_em_curso';
END;
$$;

-- DELETE direto do cliente: fim. A policy só existia para o SalesQuotes (único DELETE físico do
-- front); sem o privilégio de tabela, o build antigo recebe 42501 em vez de apagar.
REVOKE DELETE ON public.sales_orders FROM authenticated, anon;
DROP POLICY IF EXISTS sales_orders_delete_staff ON public.sales_orders;

REVOKE ALL ON FUNCTION public.sales_order_reivindicar_envio(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_order_excluir_sem_envio(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_order_reivindicar_envio(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_order_excluir_sem_envio(uuid, boolean) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sales_orders'
       AND column_name = 'envio_omie_reivindicado_em' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: coluna sales_orders.envio_omie_reivindicado_em ausente — a edge recusaria todo envio';
  END IF;
  IF to_regprocedure('public.sales_order_reivindicar_envio(uuid)') IS NULL
     OR to_regprocedure('public.sales_order_excluir_sem_envio(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'A2 FALHOU: RPC de claim/exclusão ausente — a edge recusaria envio e exclusão';
  END IF;
  IF has_function_privilege('anon', 'public.sales_order_excluir_sem_envio(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_order_excluir_sem_envio(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sales_order_reivindicar_envio(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_order_reivindicar_envio(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: RPC executável por anon/authenticated — DELETE de pedido exposto ao cliente';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sales_order_excluir_sem_envio(uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sales_order_reivindicar_envio(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — a edge não conseguiria chamar as RPCs';
  END IF;
  IF has_table_privilege('authenticated', 'public.sales_orders', 'DELETE')
     OR has_table_privilege('anon', 'public.sales_orders', 'DELETE')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sales_orders'
                 AND policyname = 'sales_orders_delete_staff') THEN
    RAISE EXCEPTION 'A5 FALHOU: o cliente ainda apaga sales_orders direto — orçamento com PV vivo apagável sem consultar o Omie';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sales_orders', 'DELETE') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role sem DELETE em sales_orders — a RPC de exclusão não apagaria';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'envio_omie_reivindicado_em', 'UPDATE')
     OR has_column_privilege('anon', 'public.sales_orders', 'envio_omie_reivindicado_em', 'UPDATE') THEN
    RAISE EXCEPTION 'A6 FALHOU: cliente pode reescrever envio_omie_reivindicado_em — zeraria o claim';
  END IF;
  RAISE NOTICE 'claim envio × exclusão: coluna + 2 RPCs (só service_role) + sem DELETE direto do cliente OK';
END
$post$;

COMMIT;
