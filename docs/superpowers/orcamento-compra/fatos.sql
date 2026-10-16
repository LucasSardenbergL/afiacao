-- docs/superpowers/orcamento-compra/fatos.sql — READ-ONLY. Uso:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f docs/superpowers/orcamento-compra/fatos.sql
\set QUIET on
with
ciclos as (
  select p.id, p.status, p.data_ciclo, p.horario_geracao, p.horario_disparo_real, p.valor_total, p.omie_pedido_compra_id,
         -- R45: filhos de split com status (pai split_em_filhos com filho disparado = disparado)
         (select coalesce(json_agg(json_build_object('id', f.id, 'status', f.status) order by f.id), '[]')
            from pedido_compra_sugerido f where f.split_parent_id = p.id) as filhos
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
-- R33: recebimento real (t4, dia local SP) de cada pedido do ciclo (pai, filho ou não splitado); null = sem t4
chegadas as (
  select ps.id as pedido_id, (t.t4_data_recebimento at time zone 'America/Sao_Paulo')::date as t4
  from pedido_compra_sugerido ps
  left join purchase_orders_tracking t on t.omie_codigo_pedido::text = ps.omie_pedido_compra_id
  where coalesce(ps.split_parent_id, ps.id) in (select id from ciclos)
),
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
         array_remove(array_agg(distinct t.nfe_numero::text), null) as nfs,
         p.omie_pedido_compra_id as omie_pedido, p.portal_protocolo as protocolo
  from pedido_compra_sugerido p
  left join purchase_orders_tracking t on t.omie_codigo_pedido::text = p.omie_pedido_compra_id
  -- R38: 270 dias = 180 de janela de compromisso antes do ciclo mais antigo (hoje − 90)
  where p.empresa = 'OBEN' and p.fornecedor_nome ilike '%sayerlack%' and p.status = 'disparado' and p.data_ciclo >= current_date - 270
  group by 1, 2, 3, p.omie_pedido_compra_id, p.portal_protocolo
),
-- R57/R58: pedidos Omie Sayerlack (linha do tracking, código > 0) com contrato (= nº do pedido na Sayerlack),
-- origem no motor (existe em pedido_compra_sugerido, qualquer status) e itens; qtde ausente fica null (ausente ≠ zero)
pedidos_omie_say as (
  select t.omie_codigo_pedido::text as codigo, (t.t1_data_pedido at time zone 'America/Sao_Paulo')::date as t1,
         nullif(trim(t.raw_data->'cabecalho_consulta'->>'cContrato'), '') as contrato,
         exists (select 1 from pedido_compra_sugerido s where s.omie_pedido_compra_id = t.omie_codigo_pedido::text) as do_motor,
         (select coalesce(json_agg(json_build_object('prod', x->>'nCodProd', 'qtde', (x->>'nQtde')::numeric) order by x->>'nCodProd', x->>'nQtde'), '[]')
            from jsonb_array_elements(t.raw_data->'produtos_consulta') x) as itens
  from purchase_orders_tracking t
  where upper(t.empresa::text) = 'OBEN' and t.fornecedor_codigo_omie = 8689681266 and t.omie_codigo_pedido > 0
    and t.t1_data_pedido >= current_date - 300 and jsonb_typeof(t.raw_data->'produtos_consulta') = 'array'
),
-- R57: par (nNumPedCompra do ITEM, NF da linha) de itensRecebimento — inclui NF órfã (código < 0); data = faturamento
nfs_do_contrato as (
  select distinct trim(i->'itensInfoAdic'->>'nNumPedCompra') as contrato, t.nfe_numero as nf,
         (t.t2_data_faturamento at time zone 'America/Sao_Paulo')::date as data
  from purchase_orders_tracking t
  cross join lateral jsonb_array_elements(t.raw_data->'itensRecebimento') i
  where upper(t.empresa::text) = 'OBEN' and t.fornecedor_codigo_omie = 8689681266
    and jsonb_typeof(t.raw_data->'itensRecebimento') = 'array' and t.nfe_numero is not null
    and coalesce(trim(i->'itensInfoAdic'->>'nNumPedCompra'), '') <> '' and t.t2_data_faturamento >= current_date - 300
),
-- R35: data/valor da baixa (v_titulo_baixas, 1 linha por lançamento) — título só desconta compromisso se
-- representado no snapshot ou liquidado antes do dia do snapshot
titulos_say as (
  select p.id::text as id, p.numero_documento_fiscal as nf, p.valor_documento as valor, p.data_emissao, p.created_at,
         b.data_baixa_final as data_baixa, b.valor_baixado
  from fin_contas_pagar p
  left join v_titulo_baixas b on b.company = p.company and b.tipo = 'CP' and b.omie_codigo_lancamento = p.omie_codigo_lancamento
  where p.company = 'oben' and p.omie_codigo_cliente_fornecedor = 8689681266
    and p.status_titulo <> 'CANCELADO' and p.data_emissao >= current_date - 270
),
-- R34: todos os ids de título Sayerlack, sem janela de data (o snapshot pode carregar título antigo)
ids_say as (
  select id::text as id from fin_contas_pagar where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266
),
pagos_nao_say as (
  select b.data_baixa_final as data, sum(b.valor_baixado) as valor
  from v_titulo_baixas b join fin_contas_pagar p on p.company = b.company and p.omie_codigo_lancamento = b.omie_codigo_lancamento
  where b.company = 'oben' and b.tipo = 'CP' and p.omie_codigo_cliente_fornecedor is distinct from 8689681266
    and b.data_baixa_final >= current_date - 300
  group by 1
),
-- R39: linhas de lag (não percentis de hoje) — o simulador calcula p10/p50 as-of por ciclo.
-- t1 = pedido/emissão; fim = dia em que a observação ficou conhecida (faturamento, criação do título, chegada).
-- 300 dias = 180 de janela antes do ciclo mais antigo (hoje − 90) + folga.
lag_trk as (
  select (t1_data_pedido at time zone 'America/Sao_Paulo')::date as t1,
         (t2_data_faturamento at time zone 'America/Sao_Paulo')::date as fat,
         (t4_data_recebimento at time zone 'America/Sao_Paulo')::date as cheg
  from purchase_orders_tracking
  where fornecedor_codigo_omie = 8689681266 and t1_data_pedido >= current_date - 300
),
lag_fat as (select t1, fat as fim, fat - t1 as dias from lag_trk where fat is not null),
lag_cheg as (select t1, cheg as fim, cheg - t1 as dias from lag_trk where cheg is not null),
lag_venc as (
  select data_emissao as t1, (created_at at time zone 'America/Sao_Paulo')::date as fim, data_vencimento - data_emissao as dias
  from fin_contas_pagar
  where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266 and data_emissao >= current_date - 300
    and data_vencimento is not null
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
  'pedidos_omie_sayerlack', (select coalesce(json_agg(x order by x.codigo), '[]') from pedidos_omie_say x),
  'nfs_do_contrato', (select coalesce(json_agg(x order by x.contrato, x.nf), '[]') from nfs_do_contrato x),
  'titulos_sayerlack', (select coalesce(json_agg(t order by t.id), '[]') from titulos_say t),
  'ids_sayerlack', (select coalesce(json_agg(i.id order by i.id), '[]') from ids_say i),
  'chegadas', (select coalesce(json_agg(c order by c.pedido_id), '[]') from chegadas c),
  'pagos_nao_sayerlack', (select coalesce(json_agg(g order by g.data), '[]') from pagos_nao_say g),
  'lag_obs', json_build_object(
    'faturamento', (select coalesce(json_agg(x order by x.t1, x.fim, x.dias), '[]') from lag_fat x),
    'vencimento', (select coalesce(json_agg(x order by x.t1, x.fim, x.dias), '[]') from lag_venc x),
    'chegada', (select coalesce(json_agg(x order by x.t1, x.fim, x.dias), '[]') from lag_cheg x)
  ),
  'cm_anual', (select cm_anual from custo)
)::text;
select 'fim', 'ok';
