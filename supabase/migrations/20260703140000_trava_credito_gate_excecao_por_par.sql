-- ============================================================
-- Trava de crédito Fase 2 — FIX P1 do review adversarial Codex (2026-07-03):
-- a exceção casava SÓ por sales_order_id; um invoke direto ao edge com o
-- codigo_cliente de OUTRO cliente bloqueado reusaria a exceção do pedido
-- (vazamento entre pares). O match agora exige o PAR (company,
-- omie_codigo_cliente) além do pedido — a tabela sempre gravou os dois.
-- Migration anterior (20260702233000) é imutável → CREATE OR REPLACE aqui.
-- Prova PG17: db/test-trava-credito-fase2.sh (asserts A11b + falsificação F6).
-- ============================================================

CREATE OR REPLACE FUNCTION public.venda_gate_credito(
  p_company text,
  p_codigo bigint,
  p_sales_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_corte date;
  v_vencido numeric;
  v_titulos integer;
  v_mais_antigo date;
  v_excecao_id uuid;
BEGIN
  -- Sem código não há evidência possível → não bloqueia (precisão > recall).
  IF p_codigo IS NULL OR p_codigo <= 0 OR p_company IS NULL THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_codigo');
  END IF;

  -- Corte em data civil de São Paulo (não UTC da sessão) — P2 Codex.
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  -- Vocabulário de status espelha OPEN_TITLE_STATUSES de
  -- src/lib/financeiro/titulo-status.ts (paridade garantida por teste vitest).
  SELECT COALESCE(sum(saldo), 0), count(*), min(data_vencimento)
    INTO v_vencido, v_titulos, v_mais_antigo
    FROM public.fin_contas_receber
   WHERE company = p_company
     AND omie_codigo_cliente = p_codigo
     AND status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')
     AND saldo > 0
     AND data_vencimento < v_corte;

  IF v_vencido <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Exceção aprovada PARA ESTE PEDIDO **E ESTE PAR** (company + código), dentro
  -- da validade — exceção de um pedido não libera outro cliente/conta.
  SELECT id INTO v_excecao_id
    FROM public.venda_excecao_credito
   WHERE sales_order_id = p_sales_order_id
     AND company = p_company
     AND omie_codigo_cliente = p_codigo
     AND valido_ate > now()
   ORDER BY created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'bloqueado', v_excecao_id IS NULL,
    'vencido', v_vencido,
    'titulos', v_titulos,
    'vencimento_mais_antigo', v_mais_antigo,
    'excecao_id', v_excecao_id,
    'motivo', CASE WHEN v_excecao_id IS NULL THEN 'vencido_60d_sem_excecao' ELSE 'excecao_valida' END
  );
END;
$$;

-- Grants idempotentes (CREATE OR REPLACE preserva, mas re-afirmar é barato e
-- protege contra apply fora de ordem).
REVOKE EXECUTE ON FUNCTION public.venda_gate_credito(text, bigint, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.venda_gate_credito(text, bigint, uuid) TO service_role;
