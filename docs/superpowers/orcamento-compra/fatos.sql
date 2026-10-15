-- docs/superpowers/orcamento-compra/fatos.sql — READ-ONLY. Uso:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f docs/superpowers/orcamento-compra/fatos.sql
\set QUIET on
with
ciclos as (
  select p.id, p.status, p.data_ciclo, p.horario_geracao, p.horario_disparo_real, p.valor_total, p.omie_pedido_compra_id
  from pedido_compra_sugerido p
  where p.empresa = 'OBEN' and p.fornecedor_nome ilike '%sayerlack%'
    and p.split_parent_id is null and p.data_ciclo >= current_date - 90
),
linhas as (
  select coalesce(ps.split_parent_id, ps.id) as raiz, i.pedido_id, i.sku_codigo_omie, coalesce(i.qtde_final, i.qtde_sugerida) as qtde,
         i.fator_embalagem_portal, i.preco_unitario, i.estoque_atual, i.estoque_fisico, i.ponto_pedido,
         i.modo_promocao, i.preco_sem_desconto
  from pedido_compra_item i join pedido_compra_sugerido ps on ps.id = i.pedido_id
  where coalesce(ps.split_parent_id, ps.id) in (select id from ciclos)
),
skus as (select distinct sku_codigo_omie from linhas),
demanda as (
  select d.sku_codigo_omie::text as sku, d.data_emissao as data, sum(d.quantidade) as qtde
  from v_sku_demanda_efetiva d
  where upper(d.empresa) = 'OBEN' and d.sku_codigo_omie::text in (select sku_codigo_omie from skus)
    and d.data_emissao >= current_date - 270
  group by 1, 2
),
-- Recebimentos reais = tracking t4_data_recebimento × quantidades do pedido Omie (spec §7).
-- (nfe_recebimento_itens só existe desde 2026-07 e quantidade_convertida veio 100% nula — não serve.)
-- Pedido recebido sem t4/sem produtos some daqui; o erro de fechamento por SKU pega o buraco.
receb as (
  select pr->>'nCodProd' as sku, (t.t4_data_recebimento at time zone 'America/Sao_Paulo')::date as data,
         sum((pr->>'nQtde')::numeric) as qtde
  from purchase_orders_tracking t
  cross join lateral jsonb_array_elements(t.raw_data->'produtos_consulta') pr
  where upper(t.empresa::text) = 'OBEN' and t.t4_data_recebimento >= current_date - 270
    and jsonb_typeof(t.raw_data->'produtos_consulta') = 'array'
    and pr->>'nCodProd' in (select sku_codigo_omie from skus)
  group by 1, 2
),
estoque as (
  select sku_codigo_omie as sku, estoque_fisico from sku_estoque_atual
  where upper(empresa) = 'OBEN' and sku_codigo_omie in (select sku_codigo_omie from skus)
),
params as (
  select sku_codigo_omie::text as sku, preco_venda_medio, demanda_media_diaria, demanda_sigma_diario
  from v_sku_parametros_sugeridos
  where upper(empresa) = 'OBEN' and sku_codigo_omie::text in (select sku_codigo_omie from skus)
),
snaps as (
  select distinct on ((snapshot_at at time zone 'America/Sao_Paulo')::date)
    (snapshot_at at time zone 'America/Sao_Paulo')::date as dia, snapshot_at, saldo_tesouraria, dados
  from fin_projecao_snapshots
  where company = 'oben' and cenario = 'pessimista' and snapshot_at >= current_date - 95
  order by (snapshot_at at time zone 'America/Sao_Paulo')::date, snapshot_at desc
),
disparados as (
  select p.id, p.valor_total, coalesce(p.horario_disparo_real, p.horario_geracao) as momento,
         array_remove(array_agg(distinct t.nfe_numero::text), null) as nfs
  from pedido_compra_sugerido p
  left join purchase_orders_tracking t on t.omie_codigo_pedido::text = p.omie_pedido_compra_id
  where p.empresa = 'OBEN' and p.status = 'disparado' and p.data_ciclo >= current_date - 120
  group by 1, 2, 3
),
titulos_say as (
  select id::text as id, numero_documento_fiscal as nf, valor_documento as valor, created_at
  from fin_contas_pagar
  where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266
    and status_titulo <> 'CANCELADO' and data_emissao >= current_date - 150
),
pagos_nao_say as (
  select b.data_baixa_final as data, sum(b.valor_baixado) as valor
  from v_titulo_baixas b join fin_contas_pagar p on p.company = b.company and p.omie_codigo_lancamento = b.omie_codigo_lancamento
  where b.company = 'oben' and b.tipo = 'CP' and p.omie_codigo_cliente_fornecedor is distinct from 8689681266
    and b.data_baixa_final >= current_date - 300
  group by 1
),
lags as (
  select
    (select percentile_disc(0.1) within group (order by t2_data_faturamento::date - t1_data_pedido::date)
       from purchase_orders_tracking where fornecedor_codigo_omie = 8689681266 and t1_data_pedido >= current_date - 180 and t2_data_faturamento is not null) as faturamento_p10,
    (select percentile_disc(0.1) within group (order by data_vencimento - data_emissao)
       from fin_contas_pagar where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266 and data_emissao >= current_date - 180) as vencimento_p10,
    (select percentile_disc(0.5) within group (order by t4_data_recebimento::date - t1_data_pedido::date)
       from purchase_orders_tracking where fornecedor_codigo_omie = 8689681266 and t1_data_pedido >= current_date - 180 and t4_data_recebimento is not null) as chegada_p50
),
custo as (
  select (selic_anual + spread_oportunidade + armazenagem_fisica) / 100.0 as cm_anual
  from empresa_configuracao_custos where upper(empresa) = 'OBEN'
)
select 'json|' || jsonb_build_object(
  'meta', json_build_object('gerado_em', now(), 'hoje', (now() at time zone 'America/Sao_Paulo')::date),
  'ciclos', (select coalesce(json_agg(c order by c.id), '[]') from ciclos c),
  'linhas', (select coalesce(json_agg(l order by l.raiz, l.pedido_id, l.sku_codigo_omie), '[]') from linhas l),
  'demanda', (select coalesce(json_agg(d order by d.sku, d.data), '[]') from demanda d),
  'recebimentos', (select coalesce(json_agg(r order by r.sku, r.data), '[]') from receb r),
  'estoque', (select coalesce(json_agg(e order by e.sku), '[]') from estoque e),
  'params', (select coalesce(json_agg(p order by p.sku), '[]') from params p),
  'snapshots', (select coalesce(json_agg(s order by s.dia), '[]') from snaps s),
  'disparados', (select coalesce(json_agg(x order by x.id), '[]') from disparados x),
  'titulos_sayerlack', (select coalesce(json_agg(t order by t.id), '[]') from titulos_say t),
  'pagos_nao_sayerlack', (select coalesce(json_agg(g order by g.data), '[]') from pagos_nao_say g),
  'lags', (select row_to_json(l) from lags l),
  'cm_anual', (select cm_anual from custo)
)::text;
select 'fim', 'ok';
