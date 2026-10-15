-- Fatos do Raio-X do estoque parado (spec 2026-10-14). READ-ONLY.
-- Saída: 1 linha 'json|<objeto>' + marcador 'fim|ok'. Regras NÃO vivem aqui (ver logica.mjs).
with e as (
  select ip.omie_codigo_produto::bigint sku, ip.saldo, ip.cmc
  from inventory_position ip where ip.account = 'oben' and ip.saldo > 0),
vh as (
  select * from v_venda_items_history_efetivo where empresa = 'OBEN'),
v as (
  select sku_codigo_omie sku, max(data_emissao) uv, sum(quantidade) q12,
         count(distinct cliente_codigo_omie) ncli,
         sum(valor_total) / nullif(sum(quantidade), 0) preco_medio_12m,
         array_agg(distinct sku_unidade) filter (where sku_unidade is not null) unidades
  from vh group by 1),
cli as (
  select sku, jsonb_agg(jsonb_build_object('nome', nome, 'ult', ult, 'qtd', qtd) order by qtd desc) clientes
  from (
    select sku_codigo_omie sku, cliente_razao_social nome, max(data_emissao)::date ult, sum(quantidade) qtd,
           row_number() over (partition by sku_codigo_omie order by sum(quantidade) desc) rn
    from vh group by 1, 2) x
  where rn <= 5 group by sku),
rec as (
  select distinct on (ri.produto_omie_id::text) ri.produto_omie_id::text pid,
         r.razao_social_emitente forn_rec, r.data_emissao::date ult_entrada
  from nfe_recebimento_itens ri join nfe_recebimentos r on r.id = ri.nfe_recebimento_id
  where ri.produto_omie_id is not null
  order by ri.produto_omie_id::text, r.data_emissao desc),
base as (
  select e.sku, p.codigo, p.descricao, p.familia, p.ativo, p.created_at::date cadastro_em,
         p.unidade unidade_estoque, coalesce(v.unidades, '{}') unidades_venda,
         coalesce(sp.fornecedor_nome, rec.forn_rec, 'marca: ' || nullif(p.metadata->>'marca', '')) fornecedor,
         rec.ult_entrada, e.saldo, e.cmc, sp.sku_codigo_omie is not null motor, sp.classe_abc,
         v.uv::date ult_venda, coalesce(v.q12, 0) q12, coalesce(v.ncli, 0) ncli,
         round(v.preco_medio_12m::numeric, 4) preco_medio_12m, coalesce(cli.clientes, '[]') clientes,
         case when coalesce(v.q12, 0) > 0 then e.saldo / (v.q12 / 365.0) end cob
  from e
  left join sku_parametros sp on sp.empresa = 'OBEN' and sp.sku_codigo_omie = e.sku
  left join lateral (select * from omie_products op
                     where op.omie_codigo_produto = e.sku and op.account = 'oben' limit 1) p on true
  left join v on v.sku = e.sku
  left join cli on cli.sku = e.sku
  left join rec on rec.pid = e.sku::text),
universo as (
  select * from base where not motor or q12 = 0 or cob > 180)
select 'json', jsonb_build_object(
  'meta', jsonb_build_object(
    'gerado_em', now(),
    'synced_at_max', (select max(synced_at) from inventory_position where account = 'oben'),
    'historico_desde', (select min(data_emissao) from vh),
    'sem_custo', (select jsonb_build_object('n', count(*), 'skus', coalesce(jsonb_agg(sku), '[]'))
                  from universo where cmc is null or cmc <= 0)),
  'itens', (select coalesce(jsonb_agg(to_jsonb(u) - 'cob'), '[]') from universo u where cmc > 0));
select 'fim', 'ok';
