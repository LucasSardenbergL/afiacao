-- Bridge de Picking da Oben: nascimento manual idempotente + fechamento atômico da task-pai.
-- Nenhuma RPC toca os syncs do Omie. Todas SECURITY DEFINER + gate staff (employee/master) —
-- lê sales_orders como owner (a RLS de sales_orders é master|employee, ≠ picking que ainda
-- referencia manager|master no arquivo de policy; DEFINER evita o mismatch cross-tabela) e seta
-- account/status/user_id server-side (anti-spoof). Oben-only na v1.
-- ⚠️ APLICAR MANUAL no SQL Editor do Lovable.
--   BLOCO 0 (rodar ANTES, diagnóstico de dupes; esperado 0 linhas):
--     SELECT sales_order_id, count(*) FROM public.picking_tasks
--      WHERE sales_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   Se acusar linhas, resolver os duplicados antes de criar o índice único.

-- Índice único parcial = backstop de idempotência do nascimento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_picking_tasks_sales_order
  ON public.picking_tasks (sales_order_id) WHERE sales_order_id IS NOT NULL;

-- Índice de candidatos da lista "Pedidos a separar".
CREATE INDEX IF NOT EXISTS idx_sales_orders_account_kpi
  ON public.sales_orders (account, order_date_kpi) WHERE deleted_at IS NULL;

-- Nasce a task (manual, Oben-only, idempotente, nunca vazia).
CREATE OR REPLACE FUNCTION public.ensure_picking_task_for_sales_order(p_sales_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_so record; v_task uuid; v_items jsonb; elem jsonb;
  v_qraw text; v_qnum numeric; v_qtd integer; v_cod bigint;
  v_count integer := 0; v_bad integer := 0; v_notes text := '';
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_ensure:'||p_sales_order_id::text, 0));
  SELECT id, account, status, deleted_at, items INTO v_so FROM sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido inexistente'; END IF;
  IF v_so.deleted_at IS NOT NULL OR v_so.status IN ('cancelado','rascunho','orcamento') THEN
    RAISE EXCEPTION 'pedido inelegível (cancelado/rascunho/orçamento/excluído)';
  END IF;
  IF lower(coalesce(v_so.account,'')) <> 'oben' THEN
    RAISE EXCEPTION 'picking v1 somente Oben';
  END IF;
  SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
  IF v_task IS NOT NULL THEN
    RETURN jsonb_build_object('task_id', v_task, 'created', false);
  END IF;
  INSERT INTO picking_tasks (sales_order_id, account, status)
  VALUES (p_sales_order_id, lower(v_so.account), 'pendente')
  ON CONFLICT (sales_order_id) WHERE sales_order_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_task;
  IF v_task IS NULL THEN
    SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
    RETURN jsonb_build_object('task_id', v_task, 'created', false);
  END IF;
  v_items := CASE WHEN jsonb_typeof(v_so.items) = 'array' THEN v_so.items ELSE '[]'::jsonb END;
  FOR elem IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qraw := elem->>'quantidade';
    IF v_qraw IS NULL OR v_qraw !~ '^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$' THEN
      v_bad := v_bad + 1; CONTINUE;
    END IF;
    v_qnum := v_qraw::numeric;
    v_qtd := ceil(v_qnum)::integer;
    IF v_qtd <= 0 THEN CONTINUE; END IF;
    v_cod := CASE WHEN (elem->>'omie_codigo_produto') ~ '^\d+$'
                   AND (elem->>'omie_codigo_produto')::bigint > 0
                  THEN (elem->>'omie_codigo_produto')::bigint ELSE NULL END;
    INSERT INTO picking_task_items (picking_task_id, omie_codigo_produto, product_descricao, quantidade, status)
    VALUES (v_task, v_cod, coalesce(elem->>'descricao',''), v_qtd, 'pendente');
    v_count := v_count + 1;
    IF v_qnum <> v_qtd THEN
      v_notes := v_notes || format('SKU %s: %s → %s; ', coalesce(elem->>'omie_codigo_produto','—'), v_qnum, v_qtd);
    END IF;
  END LOOP;
  IF v_count = 0 THEN RAISE EXCEPTION 'pedido sem itens válidos para separação'; END IF;
  IF v_notes <> '' THEN
    UPDATE picking_tasks SET notes = 'Qtd fracionária arredondada: '||v_notes WHERE id = v_task;
  END IF;
  RETURN jsonb_build_object('task_id', v_task, 'created', true, 'item_count', v_count, 'bad_count', v_bad);
END $$;

-- Recalcula o status da task-pai por QUANTIDADE. Lock por task serializa concorrência (confirms simultâneos).
CREATE OR REPLACE FUNCTION public.recalcular_picking_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_total numeric; v_done numeric; v_status text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_task:'||p_task_id::text, 0));
  SELECT COALESCE(sum(quantidade),0), COALESCE(sum(quantidade_separada),0)
    INTO v_total, v_done FROM picking_task_items WHERE picking_task_id = p_task_id;
  IF v_done <= 0 THEN v_status := 'pendente';
  ELSIF v_total > 0 AND v_done >= v_total THEN v_status := 'concluido';
  ELSE v_status := 'em_andamento'; END IF;
  UPDATE picking_tasks SET
    status = v_status,
    started_at = COALESCE(started_at, CASE WHEN v_status <> 'pendente' THEN now() END),
    completed_at = CASE WHEN v_status = 'concluido' THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = p_task_id;
  RETURN jsonb_build_object('status', v_status);
END $$;

-- Confirma item: evento + update item (absoluto) + recalc pai (via PERFORM, sem duplicar lógica), ATÔMICO.
-- Idempotente p/ replay offline (evento por PK, update absoluto, recalc puro). 1 separador por item (last-write).
CREATE OR REPLACE FUNCTION public.confirmar_item_picking(
  p_event_id uuid, p_task_id uuid, p_item_id uuid, p_quantidade_separada integer,
  p_lote_informado text, p_justificativa text, p_confirmed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_item record; v_div boolean; v_etype text; v_item_status text; v_parent text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  IF p_quantidade_separada IS NULL OR p_quantidade_separada < 0 THEN
    RAISE EXCEPTION 'quantidade separada inválida';
  END IF;
  SELECT quantidade, lote_fefo INTO v_item FROM picking_task_items WHERE id = p_item_id AND picking_task_id = p_task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'item inexistente'; END IF;
  v_div := (p_lote_informado IS NOT NULL AND v_item.lote_fefo IS NOT NULL AND p_lote_informado <> v_item.lote_fefo);
  v_etype := CASE WHEN v_div THEN 'lote_divergente' ELSE 'item_confirmado' END;
  INSERT INTO picking_events (id, picking_task_id, picking_task_item_id, event_type, lote_esperado, lote_informado, justificativa, user_id)
  VALUES (p_event_id, p_task_id, p_item_id, v_etype, v_item.lote_fefo, p_lote_informado, p_justificativa, v_uid)
  ON CONFLICT (id) DO NOTHING;
  v_item_status := CASE WHEN p_quantidade_separada >= v_item.quantidade THEN 'concluido' ELSE 'em_andamento' END;
  UPDATE picking_task_items SET
    quantidade_separada = p_quantidade_separada, status = v_item_status,
    lote_separado = p_lote_informado, justificativa_substituicao = p_justificativa, separado_at = p_confirmed_at
  WHERE id = p_item_id;
  v_parent := (public.recalcular_picking_task(p_task_id))->>'status';  -- mesma tx, lock interno serializa o pai
  RETURN jsonb_build_object('ok', true, 'parent_status', v_parent);
END $$;

-- Lista candidatos "a separar" (anti-join + COALESCE de data, server-side). Gate staff (DEFINER → não vaza p/ customer).
CREATE OR REPLACE FUNCTION public.listar_pedidos_a_separar(p_account text)
RETURNS TABLE (id uuid, customer_user_id uuid, total numeric, status text, data date, items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  RETURN QUERY
    SELECT so.id, so.customer_user_id, so.total, so.status,
           COALESCE(so.order_date_kpi, so.created_at::date) AS data, so.items
    FROM sales_orders so
    WHERE lower(so.account) = lower(p_account)
      AND so.deleted_at IS NULL
      AND so.status NOT IN ('cancelado','rascunho','orcamento')
      AND COALESCE(so.order_date_kpi, so.created_at::date) >= current_date - 60
      AND NOT EXISTS (SELECT 1 FROM picking_tasks pt WHERE pt.sales_order_id = so.id)
    ORDER BY COALESCE(so.order_date_kpi, so.created_at::date) DESC
    LIMIT 100;
END $$;

REVOKE ALL ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recalcular_picking_task(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.listar_pedidos_a_separar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalcular_picking_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_pedidos_a_separar(text) TO authenticated;
