-- Migration: v_sku_ultima_venda — última venda ALL-TIME por SKU (P3 do programa de ciclo financeiro).
-- ⚠️ NÃO auto-aplica (nome custom) — colar no SQL Editor do Lovable.
--
-- Por quê: v_sku_demanda_estatisticas é JANELADA em 90d — SKU sem venda há mais de 90 dias NEM APARECE
-- nela, então o "dias sem vender" do painel de baixo giro mostrava "—/nunca" para quem vendeu há 4 meses,
-- e o critério "giro morto" (sem venda há ≥270d) não tinha fonte. Esta view é o MAX all-time sobre a
-- v_venda_items_history_efetivo (a view de indireção da consolidação de demanda N→1: venda do SKU
-- consolidado conta no DESTINO; a origem fica sem vendas — e origem consolidada É candidata a
-- descontinuar, comportamento desejado).
--
-- Nota de honestidade: o histórico OBEN começa em 2025-10-21 (~9 meses) — "sem venda há 1 ano" é
-- inafirmável; o limiar operacional do painel é 270d (LIMIAR_GIRO_MORTO_DIAS no frontend).
--
-- security_invoker=on EXPLÍCITO (view nova): a leitura herda a RLS da tabela-base
-- (venda_items_history: SELECT staff-only). Sem grant a anon.

CREATE VIEW public.v_sku_ultima_venda
WITH (security_invoker = on) AS
SELECT
  empresa,
  sku_codigo_omie,
  max(data_emissao)  AS ultima_venda_data,
  count(*)           AS vendas_registradas
FROM public.v_venda_items_history_efetivo
GROUP BY empresa, sku_codigo_omie;

COMMENT ON VIEW public.v_sku_ultima_venda IS
  'Última venda ALL-TIME por SKU (fonte: v_venda_items_history_efetivo — demanda consolidada N→1). '
  'Diferente da v_sku_demanda_estatisticas (janela 90d). Consumida pelo painel de baixo giro (giro morto).';

GRANT SELECT ON public.v_sku_ultima_venda TO authenticated;
GRANT SELECT ON public.v_sku_ultima_venda TO service_role;
