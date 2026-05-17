-- Dashboard V3: habilita Realtime nas tabelas que cada zona escuta via
-- `useCockpitChannel`. Sem isso a Subscribe callback nunca recebe SUBSCRIBED
-- e o LiveBadge nunca aparece.
--
-- Já estavam habilitadas: orders, nfe_recebimentos, pedido_compra_sugerido,
-- sku_parametros, farmer_calls (em migrations anteriores).
--
-- Adicionando as 4 restantes que as zonas do Dashboard V3 escutam:
-- - sales_orders   → VendasZone
-- - picking_tasks  → EstoqueZone (complementa nfe_recebimentos)
-- - eventos_outlier → ReposicaoZone (alertas)
-- - tint_importacoes → TintometricoZone
--
-- Não habilitamos `profiles` (SistemaZone) por enquanto: tabela tem volume
-- alto de mudanças (logins atualizam last_seen etc.) e o canal é filtrado
-- por `is_approved=eq.false` que o Realtime filter respeita só no client —
-- backend ainda envia tudo. Trade-off documentado: SistemaZone fica sem
-- LiveBadge, atualiza via `refetchInterval 60s`. Revisar quando houver
-- dashboard_visits stream.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    -- sales_orders
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'sales_orders'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_orders;
    END IF;

    -- picking_tasks
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'picking_tasks'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.picking_tasks;
    END IF;

    -- eventos_outlier
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'eventos_outlier'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.eventos_outlier;
    END IF;

    -- tint_importacoes
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'tint_importacoes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tint_importacoes;
    END IF;
  END IF;
END $$;
