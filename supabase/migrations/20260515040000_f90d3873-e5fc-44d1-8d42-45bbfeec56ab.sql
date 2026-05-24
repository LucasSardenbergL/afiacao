-- PR4 — Repassar a data de entrega do portal Sayerlack para o pedido de compra Omie
-- Adiciona coluna para guardar a data_entrega devolvida pelo portal Sayerlack
-- (campo "data_entrega" no JSON top-level do POST /order-creation/form/add).
-- A função disparar-pedidos-aprovados consulta essa coluna e usa
-- (portal_data_entrega + 2 dias corridos) como dDtPrevisao no Omie para
-- pedidos OBEN/Sayerlack que já têm protocolo confirmado.
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS portal_data_entrega date;

COMMENT ON COLUMN public.pedido_compra_sugerido.portal_data_entrega IS
  'Data de entrega confirmada pelo portal Sayerlack no momento do submit (campo "data_entrega" do response do POST /order-creation/form/add). Usada por disparar-pedidos-aprovados para calcular o dDtPrevisao do pedido de compra no Omie (= portal_data_entrega + 2 dias corridos).';
