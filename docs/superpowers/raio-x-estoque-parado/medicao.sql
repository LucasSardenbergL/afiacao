-- Medição do Raio-X: saldo atual, vendas e compras desde o retrato. READ-ONLY.
with s as (select omie_codigo_produto::bigint sku, saldo from inventory_position where account = 'oben'),
v as (select sku_codigo_omie sku, sum(quantidade) qtd, sum(valor_total) receita
      from v_venda_items_history_efetivo where empresa = 'OBEN' and data_emissao > :'desde'::date group by 1),
c as (select pci.sku_codigo_omie::bigint sku,
             jsonb_agg(to_char(pci.criado_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') order by pci.criado_em) compras
      from pedido_compra_item pci join pedido_compra_sugerido pcs on pcs.id = pci.pedido_id
      -- só compra real da Oben (mesmos status que as migrations tratam como compra efetiva)
      where pcs.empresa = 'OBEN' and pcs.status in ('aprovado_aguardando_disparo', 'disparado', 'concluido_recebido')
        and pci.criado_em > :'desde'::date
      group by 1)
select 'json', jsonb_object_agg(s.sku, jsonb_build_object(
  'saldo', s.saldo, 'qtd_vendida', coalesce(v.qtd, 0), 'receita', coalesce(v.receita, 0), 'compras', coalesce(c.compras, '[]')))
from s left join v using (sku) left join c using (sku);
select 'fim', 'ok';
