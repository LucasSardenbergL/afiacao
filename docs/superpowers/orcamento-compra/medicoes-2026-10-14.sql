-- Medições da spec docs/superpowers/specs/2026-10-15-orcamento-compra-design.md (§2).
-- Uso: ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f <este arquivo>  (read-only; deve terminar em fim|ok)

-- ===== base
\echo == A status 90d (pedidos-pai, sem filhos de split)
select status, count(*), round(sum(valor_total)) from pedido_compra_sugerido
where data_ciclo >= current_date-90 and split_parent_id is null group by 1 order by 3 desc nulls last;
\echo == B disparados por mes/empresa
select to_char(date_trunc('month',data_ciclo),'YYYY-MM') m, empresa, count(*), round(sum(valor_total))
from pedido_compra_sugerido where status='disparado' and data_ciclo>=current_date-180 group by 1,2 order by 1,2;
\echo == C disparados 90d por fornecedor/condicao
select fornecedor_nome, coalesce(condicao_pagamento_descricao,'(null)') cond, count(*), round(sum(valor_total))
from pedido_compra_sugerido where status='disparado' and data_ciclo>=current_date-90 group by 1,2 order by 4 desc limit 12;
\echo == D estoque oben (saldo>0)
select count(*) skus, count(*) filter (where cmc is null or cmc<=0) sem_cmc, round(sum(saldo*cmc) filter (where cmc>0)) valor
from inventory_position where account='oben' and saldo>0;
\echo == E pendentes agora
select status, count(*), round(sum(valor_total)) from pedido_compra_sugerido where status in ('pendente_aprovacao','aprovado_aguardando_disparo') group by 1;
\echo == F tabelas fin_ e caixa
select table_name from information_schema.tables where table_schema='public' and (table_name like 'fin\_%' or table_name ilike '%caixa%' or table_name ilike '%saldo%' or table_name ilike '%fluxo%') order by 1;

-- ===== cx
select table_name, left(string_agg(column_name, ',' order by ordinal_position),600)
from information_schema.columns where table_schema='public'
and table_name in ('fin_fluxo_caixa_diario','fin_projecao_snapshots','fin_config_cashflow','fin_contas_correntes','fin_forecast','fin_estoque_valor') group by 1;
\echo == fluxo diario: cobertura
select company, min(data), max(data), count(*) from fin_fluxo_caixa_diario group by 1;
\echo == projecao snapshots recentes
select company, cenario, horizon_weeks, max(snapshot_at), count(*) from fin_projecao_snapshots group by 1,2,3 order by 4 desc limit 8;
\echo == CP/CR abertos oben por semana (13 sem)
with s as (select generate_series(0,12) w)
select w,
 (select round(sum(saldo)) from fin_contas_pagar where company='oben' and saldo>0 and data_vencimento >= current_date+7*w and data_vencimento < current_date+7*(w+1)) cp,
 (select round(sum(saldo)) from fin_contas_receber where company='oben' and saldo>0 and data_vencimento >= current_date+7*w and data_vencimento < current_date+7*(w+1)) cr
from s order by w;
\echo == vencidos em aberto
select 'cp', round(sum(saldo)) from fin_contas_pagar where company='oben' and saldo>0 and data_vencimento<current_date
union all select 'cr', round(sum(saldo)) from fin_contas_receber where company='oben' and saldo>0 and data_vencimento<current_date;
\echo == saldo contas oben
select round(sum(saldo_atual)), max(saldo_data), count(*) from fin_contas_correntes where company='oben' and ativo;

-- ===== orig
with s as (select dados from fin_projecao_snapshots where company='oben' and cenario='pessimista' order by snapshot_at desc limit 1),
w as (select e from s, jsonb_array_elements(dados) e)
select k, count(*) from w, jsonb_object_keys(e) k group by 1 order by 1;
with s as (select dados from fin_projecao_snapshots where company='oben' and cenario='pessimista' order by snapshot_at desc limit 1),
w as (select e from s, jsonb_array_elements(dados) e)
select 'saidas', x->>'origem', count(*), round(sum((x->>'valor')::numeric)) from w, jsonb_array_elements(e->'saidas') x group by 2
union all
select 'entradas', x->>'origem', count(*), round(sum((x->>'valor')::numeric)) from w, jsonb_array_elements(e->'entradas') x group by 2 order by 1,4 desc;
with s as (select dados from fin_projecao_snapshots where company='oben' and cenario='pessimista' order by snapshot_at desc limit 1)
select e->>'inicio', left(regexp_replace((e - 'saidas' - 'entradas')::text,'\s',''),300) from s, jsonb_array_elements(dados) e;

-- ===== out
\echo == CP liquidado oben por mes (v_titulo_baixas), total e sayerlack
select to_char(date_trunc('month',b.data_baixa_final),'YYYY-MM') m, round(sum(b.valor_baixado)) total,
 round(sum(b.valor_baixado) filter (where p.nome_fornecedor ilike '%sayerlack%')) sayer
from v_titulo_baixas b join fin_contas_pagar p on p.company=b.company and p.omie_codigo_lancamento=b.omie_codigo_lancamento
where b.company='oben' and b.tipo='CP' and b.data_baixa_final>=date_trunc('month',current_date)-interval '6 months' and b.data_baixa_final<date_trunc('month',current_date)
group by 1 order by 1;
\echo == CR liquidado oben por mes
select to_char(date_trunc('month',data_baixa_final),'YYYY-MM'), round(sum(valor_baixado)) from v_titulo_baixas
where company='oben' and tipo='CR' and data_baixa_final>=date_trunc('month',current_date)-interval '6 months' and data_baixa_final<date_trunc('month',current_date) group by 1 order by 1;

-- ===== forn
select coalesce(p.nome_fornecedor,'(null)'), left(coalesce(p.categoria_descricao,'(null)'),30), round(sum(b.valor_baixado)/6) mensal
from v_titulo_baixas b join fin_contas_pagar p on p.company=b.company and p.omie_codigo_lancamento=b.omie_codigo_lancamento
where b.company='oben' and b.tipo='CP' and b.data_baixa_final>=date_trunc('month',current_date)-interval '6 months' and b.data_baixa_final<date_trunc('month',current_date)
group by 1,2 order by 3 desc limit 12;

-- ===== link
\echo == top fornecedores CP liquidado 6m por codigo
select p.omie_codigo_cliente_fornecedor, count(*), round(sum(b.valor_baixado)/6) mensal, max(p.numero_documento_fiscal) ex_nf, max(p.id_origem) ex_origem, max(p.tipo_documento) td
from v_titulo_baixas b join fin_contas_pagar p on p.company=b.company and p.omie_codigo_lancamento=b.omie_codigo_lancamento
where b.company='oben' and b.tipo='CP' and b.data_baixa_final>=current_date-180 group by 1 order by 3 desc limit 8;
\echo == onde aparece o codigo omie da sayerlack
select table_name, column_name from information_schema.columns where table_schema='public' and (column_name ilike '%fornecedor%codigo%' or column_name ilike '%codigo%fornecedor%' or column_name ilike 'ncodfor%') limit 15;
\echo == pedido disparado: tem nf/omie id?
select count(*), count(omie_pedido_compra_id), count(omie_pedido_compra_numero), count(portal_data_entrega) from pedido_compra_sugerido where status='disparado' and data_ciclo>=current_date-90;

-- ===== link2
select 'nome', left(to_jsonb(f)::text,250) from fornecedor_omie_cache f where omie_codigo_cliente_fornecedor=8689681266 limit 1;
\echo == prazo emissao->vencimento e emissao->baixa (sayerlack, 180d)
select percentile_disc(array[0.1,0.5,0.9]) within group (order by p.data_vencimento-p.data_emissao) venc,
       percentile_disc(array[0.1,0.5,0.9]) within group (order by b.data_baixa_final-p.data_emissao) baixa, count(*)
from fin_contas_pagar p join v_titulo_baixas b on b.company=p.company and b.omie_codigo_lancamento=p.omie_codigo_lancamento and b.tipo='CP'
where p.company='oben' and p.omie_codigo_cliente_fornecedor=8689681266 and b.data_baixa_final>=current_date-180;
\echo == purchase_orders_tracking colunas
select left(string_agg(column_name, ',' order by ordinal_position),700) from information_schema.columns where table_schema='public' and table_name='purchase_orders_tracking';

-- ===== link3
\echo == pedido->faturamento (dias corridos) sayerlack 180d
select percentile_disc(array[0.1,0.5,0.9]) within group (order by t2_data_faturamento::date - t1_data_pedido::date), count(*), count(t2_data_faturamento), count(nfe_numero)
from purchase_orders_tracking where fornecedor_codigo_omie=8689681266 and t1_data_pedido>=current_date-180;
\echo == cobertura do vinculo motor->tracking->CP (disparados 90d)
with p as (select id, omie_pedido_compra_id, valor_total from pedido_compra_sugerido where status='disparado' and data_ciclo>=current_date-90),
t as (select p.*, t.nfe_numero, t.t2_data_faturamento from p left join purchase_orders_tracking t on t.omie_codigo_pedido::text=p.omie_pedido_compra_id)
select count(*), count(nfe_numero) com_nf,
 count(*) filter (where exists (select 1 from fin_contas_pagar c where c.company='oben' and c.omie_codigo_cliente_fornecedor=8689681266 and ltrim(c.numero_documento_fiscal,'0')=ltrim(t.nfe_numero::text,'0'))) com_cp,
 count(distinct nfe_numero) nfs_distintas
from t;

-- ===== fill
with i as (
 select i.*, coalesce(i.qtde_final,i.qtde_sugerida) q from pedido_compra_item i join pedido_compra_sugerido p on p.id=i.pedido_id
 where p.status='disparado' and p.data_ciclo>=current_date-90 and i.preco_unitario>0)
select count(*) linhas, round(sum(q*preco_unitario)) valor,
 round(sum(least(q, greatest(ponto_pedido-estoque_atual,0))*preco_unitario)) ate_pp,
 round(100*sum(least(q, greatest(ponto_pedido-estoque_atual,0))*preco_unitario)/nullif(sum(q*preco_unitario),0),1) pct_ate_pp,
 count(*) filter (where estoque_atual<0) linhas_efetivo_neg
from i;

select 'fim','ok';
