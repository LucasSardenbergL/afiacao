-- Medição do Raio-X: saldo atual, vendas e compras desde o retrato. READ-ONLY.
with s as (select omie_codigo_produto::bigint sku, saldo from inventory_position where account = 'oben'),
v as (select sku_codigo_omie sku, sum(quantidade) qtd, sum(valor_total) receita
      from v_venda_items_history_efetivo where empresa = 'OBEN' and data_emissao > :'desde'::date group by 1),
c as (select sku_codigo_omie::bigint sku, jsonb_agg(criado_em order by criado_em) compras
      from pedido_compra_item where criado_em > :'desde'::date group by 1)
select 'json', jsonb_object_agg(s.sku, jsonb_build_object(
  'saldo', s.saldo, 'qtd_vendida', coalesce(v.qtd, 0), 'receita', coalesce(v.receita, 0), 'compras', coalesce(c.compras, '[]')))
from s left join v using (sku) left join c using (sku);
select 'fim', 'ok';
