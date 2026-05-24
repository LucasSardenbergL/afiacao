
-- =========================================================
-- PARTE 1: Habilitar RLS + policies staff-only em tabelas sem RLS
-- =========================================================

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'pedido_compra_sugerido',
    'pedido_compra_item',
    'sku_estoque_atual',
    'simulacao_estoque_resultados',
    'fornecedor_habilitado_reposicao',
    'fornecedor_cadeia_logistica',
    'fornecedor_calendario_operacao',
    'fornecedor_grupo_producao',
    'fornecedor_condicao_pagamento_padrao',
    'fornecedor_promocao',
    'sku_grupo_producao',
    'sku_status_omie',
    'sku_substituicao',
    'familia_nao_comprada',
    'omie_condicao_pagamento_catalogo',
    'empresa_configuracao_custos'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS staff_%s_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS staff_%s_insert ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS staff_%s_update ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS staff_%s_delete ON public.%I', t, t);

    EXECUTE format($p$
      CREATE POLICY staff_%s_select ON public.%I
        FOR SELECT TO authenticated
        USING (public.has_role(auth.uid(), 'admin'::app_role)
            OR public.has_role(auth.uid(), 'employee'::app_role))
    $p$, t, t);

    EXECUTE format($p$
      CREATE POLICY staff_%s_insert ON public.%I
        FOR INSERT TO authenticated
        WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role)
                 OR public.has_role(auth.uid(), 'employee'::app_role))
    $p$, t, t);

    EXECUTE format($p$
      CREATE POLICY staff_%s_update ON public.%I
        FOR UPDATE TO authenticated
        USING (public.has_role(auth.uid(), 'admin'::app_role)
            OR public.has_role(auth.uid(), 'employee'::app_role))
        WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role)
                 OR public.has_role(auth.uid(), 'employee'::app_role))
    $p$, t, t);

    EXECUTE format($p$
      CREATE POLICY staff_%s_delete ON public.%I
        FOR DELETE TO authenticated
        USING (public.has_role(auth.uid(), 'admin'::app_role)
            OR public.has_role(auth.uid(), 'employee'::app_role))
    $p$, t, t);
  END LOOP;
END $$;

-- =========================================================
-- PARTE 2: Substituir policies USING(true) por staff-only
-- =========================================================

-- A) omie_webhook_events
DROP POLICY IF EXISTS authenticated_all_omie_webhook_events ON public.omie_webhook_events;

DROP POLICY IF EXISTS staff_omie_webhook_events_select ON public.omie_webhook_events;
DROP POLICY IF EXISTS staff_omie_webhook_events_insert ON public.omie_webhook_events;
DROP POLICY IF EXISTS staff_omie_webhook_events_update ON public.omie_webhook_events;
DROP POLICY IF EXISTS staff_omie_webhook_events_delete ON public.omie_webhook_events;

CREATE POLICY staff_omie_webhook_events_select ON public.omie_webhook_events
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY staff_omie_webhook_events_insert ON public.omie_webhook_events
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role)
           OR public.has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY staff_omie_webhook_events_update ON public.omie_webhook_events
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role)
           OR public.has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY staff_omie_webhook_events_delete ON public.omie_webhook_events
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role));

-- B) venda_items_history
DROP POLICY IF EXISTS "authenticated read venda_items_history" ON public.venda_items_history;

DROP POLICY IF EXISTS staff_venda_items_history_select ON public.venda_items_history;

CREATE POLICY staff_venda_items_history_select ON public.venda_items_history
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role));

-- Verificação manual: rodar linter e conferir findings 1..16
