-- extrair.sql — extração SOMENTE-LEITURA dos dados do replay TSB (estoque de segurança Sayerlack).
-- Rodado por extrair.sh via ~/.config/afiacao/psql-ro (sessão READ ONLY, statement_timeout 30s POR comando),
-- com -v ON_ERROR_STOP=1 -v dir=<pasta de saída>. Um `copy ... to stdout \g arquivo` por CSV (o \copy do psql não
-- aceita query em várias linhas). Separador `|`, cabeçalho. O marcador `fim|ok` é checado por extrair.sh.
--
-- ESCOPO (coorte): SKUs de sku_parametros OBEN cujo fornecedor é Sayerlack (391 no medido). A chave `sku` é SEMPRE
-- sku_codigo_omie (texto) — a mesma do motor (db/embalagem-motor-rpc.sql) e de v_venda_items_history_efetivo.
-- Ausente vira vazio (NULL), nunca 0. Nenhuma saída vai ao repositório: os arquivos ficam em $REPLAY_DADOS.

\set ON_ERROR_STOP on

-- ── vendas.csv: TODO o universo OBEN (o Pareto ABC precisa dele); no_escopo=1 marca a coorte Sayerlack ──────────
-- Fonte: v_venda_items_history_efetivo (consolida SKU substituído, como o motor). cmc_linha = CMC do último
-- cmc_snapshot (account 'vendas' = OBEN) com data_posicao <= data da venda; NULL antes do 1º snapshot
-- (2026-01-15) — não existe CMC histórico anterior e fabricar seria money-path (ausente != zero).
copy (
  select v.id as linha_id,
         v.sku_codigo_omie::text as sku,
         v.data_emissao as data,
         v.quantidade,
         v.valor_total as valor,
         (select c.cmc from cmc_snapshot c
           where c.account = 'vendas' and c.omie_codigo_produto = v.sku_codigo_omie
             and c.data_posicao <= v.data_emissao
           order by c.data_posicao desc limit 1) as cmc_linha,
         (v.sku_codigo_omie::text in (select sp.sku_codigo_omie::text from sku_parametros sp
                                       where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%'))::int as no_escopo
  from v_venda_items_history_efetivo v
  where v.empresa = 'OBEN'
  order by v.data_emissao, v.id
) to stdout with (format csv, delimiter '|', header true) \g :dir/vendas.csv

-- ── recebimentos.csv: sku_leadtime_history deduplicado por (tracking_id, empresa, sku, t4, qtde_recebida) ──────
-- Recebimento parcial (mesma tracking, quantidade_recebida diferente) é PRESERVADO. Pedido sem t4 sai com t4 vazio.
-- t1/t4 em data de São Paulo. Empate na chave: fica a linha atualizada mais recentemente.
copy (
  select d.tracking_id, d.sku, d.t1, d.t4, d.quantidade_pedida, d.quantidade_recebida
  from (
    select distinct on (h.tracking_id, h.empresa, h.sku_codigo_omie, h.t4_data_recebimento, h.quantidade_recebida)
           h.tracking_id,
           h.sku_codigo_omie::text as sku,
           (h.t1_data_pedido at time zone 'America/Sao_Paulo')::date as t1,
           (h.t4_data_recebimento at time zone 'America/Sao_Paulo')::date as t4,
           h.quantidade_pedida,
           h.quantidade_recebida
    from sku_leadtime_history h
    where h.empresa = 'OBEN'
      and h.sku_codigo_omie::text in (select sp.sku_codigo_omie::text from sku_parametros sp
                                       where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%')
    order by h.tracking_id, h.empresa, h.sku_codigo_omie, h.t4_data_recebimento, h.quantidade_recebida,
             h.updated_at desc nulls last, h.id desc
  ) d
  order by d.t1, d.tracking_id, d.sku, d.t4
) to stdout with (format csv, delimiter '|', header true) \g :dir/recebimentos.csv

-- ── skus.csv: 1 linha por SKU da coorte, estado "hoje" do motor ────────────────────────────────────────────────
-- classe_abc_hoje = classe EFETIVA do motor (classe_forcada -> classe_abc, 1ª letra). classe_forcada/minimo_forcado
-- = sku_parametros.classe_forcada / minimo_forcado_manual. minimo_operacional = o da v_sku_parametros_sugeridos
-- (A=2, B=1, C=0 pela classe PROPOSTA; vazio nos SKUs que a view não devolve). multiplo_embalagem = 1/fator_portal
-- (sku_fornecedor_externo ativo, mesmo fornecedor; só fator finito, >0 e <> 1 — a regra do motor, ~L488; vazio = sem
-- arredondamento). fator_conversao = o fator do portal cru. unidade_nf = unidade MAIS FREQUENTE nas linhas de venda
-- da NF. unidade_estoque = omie_products.unidade. cmc/saldo_hoje = inventory_position (contas vendas/oben, a mais
-- recente) e, no saldo, GREATEST com sku_estoque_atual.estoque_fisico (a regra do motor). habilitado = automática
-- habilitada; ativo = sku_parametros.ativo E catálogo Omie ativo E ativo_no_omie (ausente conta como ativo, como o
-- motor). custo_pedido_aplicado / custo_capital_perc = de empresa_configuracao_custos (mesma conta da view).
-- es_hoje/pp_hoje/max_hoje = estoque_seguranca / ponto_pedido / estoque_maximo gravados em sku_parametros.
-- grupo_embalagem_id (extra, no fim) = grupo de sku_embalagem_equivalencia (vazio = fora de grupo).
copy (
  with escopo as (
    select sp.* from sku_parametros sp
    where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%'
  ),
  inv as (
    select distinct on (ip.omie_codigo_produto) ip.omie_codigo_produto::text as sku, ip.saldo, ip.cmc
    from inventory_position ip
    where ip.account in ('vendas', 'oben')
    order by ip.omie_codigo_produto, ip.synced_at desc nulls last
  ),
  und as (
    select x.sku_codigo_omie::text as sku,
           (array_agg(x.sku_unidade order by x.q desc, x.sku_unidade))[1] as unidade_nf
    from (select sku_codigo_omie, sku_unidade, count(*) as q
          from v_venda_items_history_efetivo where empresa = 'OBEN' group by 1, 2) x
    group by 1
  ),
  cfg as (
    select (selic_anual + spread_oportunidade + armazenagem_fisica) as custo_capital_perc,
           case when modo_pedido = 'api' then custo_pedido_api else custo_pedido_manual end as custo_pedido
    from empresa_configuracao_custos where empresa = 'OBEN'
  )
  select e.sku_codigo_omie::text as sku,
         e.sku_descricao as descricao,
         sg.grupo_codigo,
         substring(coalesce(nullif(btrim(e.classe_forcada), ''), e.classe_abc::text) from 1 for 1) as classe_abc_hoje,
         nullif(btrim(e.classe_forcada), '') as classe_forcada,
         e.minimo_forcado_manual as minimo_forcado,
         vs.minimo_operacional,
         case when sfe.fator_conversao > 0 and sfe.fator_conversao < 1e9 and sfe.fator_conversao <> 1
              then round(1 / sfe.fator_conversao, 6) end as multiplo_embalagem,
         u.unidade_nf,
         op.unidade as unidade_estoque,
         sfe.fator_conversao,
         case when inv.cmc > 0 then inv.cmc end as cmc,
         case when inv.saldo is null and sea.estoque_fisico is null then null   -- ausente != 0
              else greatest(coalesce(inv.saldo, 0), coalesce(sea.estoque_fisico, 0)) end as saldo_hoje,
         (e.habilitado_reposicao_automatica is true and coalesce(e.tipo_reposicao, 'automatica') = 'automatica') as habilitado,
         (coalesce(e.ativo, true) and coalesce(op.ativo, true) and coalesce(sso.ativo_no_omie, true)) as ativo,
         cfg.custo_pedido as custo_pedido_aplicado,
         cfg.custo_capital_perc,
         e.estoque_seguranca as es_hoje,
         e.ponto_pedido as pp_hoje,
         e.estoque_maximo as max_hoje,
         eq.grupo_id as grupo_embalagem_id
  from escopo e
  cross join cfg
  left join sku_grupo_producao sg on sg.empresa = e.empresa and sg.sku_codigo_omie = e.sku_codigo_omie::text
  left join omie_products op on op.omie_codigo_produto::text = e.sku_codigo_omie::text and op.account = 'oben'
  left join sku_status_omie sso on sso.empresa = e.empresa and sso.sku_codigo_omie = e.sku_codigo_omie::text
  left join sku_estoque_atual sea on sea.empresa = e.empresa and sea.sku_codigo_omie = e.sku_codigo_omie::text
  left join inv on inv.sku = e.sku_codigo_omie::text
  left join und u on u.sku = e.sku_codigo_omie::text
  left join sku_fornecedor_externo sfe on sfe.empresa = e.empresa and sfe.fornecedor_nome = e.fornecedor_nome
        and sfe.sku_omie::text = e.sku_codigo_omie::text and sfe.ativo = true
  left join v_sku_parametros_sugeridos vs on vs.empresa = e.empresa and vs.sku_codigo_omie = e.sku_codigo_omie
  left join (select distinct on (sku_codigo_omie) sku_codigo_omie, grupo_id from sku_embalagem_equivalencia
              where empresa = 'oben' and ativo = true order by sku_codigo_omie, id) eq
         on eq.sku_codigo_omie = e.sku_codigo_omie::text
  order by e.sku_codigo_omie
) to stdout with (format csv, delimiter '|', header true) \g :dir/skus.csv

-- ── config_custos.csv: empresa_configuracao_custos (OBEN), só colunas numéricas/modo (sem e-mail nem observações) ─
copy (
  select z_classe_a, z_classe_b, z_classe_c, selic_anual, spread_oportunidade, armazenagem_fisica,
         custo_pedido_manual, custo_pedido_api, modo_pedido, haircut_fallback_preco
  from empresa_configuracao_custos where empresa = 'OBEN'
) to stdout with (format csv, delimiter '|', header true) \g :dir/config_custos.csv

-- ── classificacao_hist.csv: estado da histerese de atualizar_classificacao_skus + parâmetros da regra ─────────
-- tipo=sku: 1 linha por SKU da coorte (classe atual, pendente, meses consecutivos, última mudança).
-- tipo=regra: parâmetros LIDOS do corpo da função/view de produção (pg_get_functiondef de
-- atualizar_classificacao_skus: subir exige 2 meses consecutivos, descer 3, ordem AX..CZ; v_sku_classificacao_abc_xyz:
-- acumulado de valor_total_90d <= 0,80 A, <= 0,95 B, resto C; X: cv<0,4, Y: cv<0,8, Z: o resto ou num_ordens<2).
-- Se a função mudar, revise estes valores.
copy (
  select 'sku'::text as tipo, sp.sku_codigo_omie::text as chave, sp.classe_consolidada as classe_atual,
         sp.classe_abc as classe_abc, sp.classe_xyz as classe_xyz,
         sp.classe_proposta_pendente as classe_pendente,
         sp.meses_consecutivos_nova_classe as meses_consecutivos,
         sp.data_ultima_mudanca_classe as data_ultima_mudanca, null::text as valor
  from sku_parametros sp
  where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%'
  union all
  select 'regra', k, null, null, null, null, null, null, v
  from (values ('meses_subir', '2'), ('meses_descer', '3'),
               ('ordem_prioridade', 'AX AY AZ BX BY BZ CX CY CZ'),
               ('abc_corte_a_acumulado', '0.80'), ('abc_corte_b_acumulado', '0.95'),
               ('abc_base_valor', 'valor_total_90d'),
               ('xyz_corte_x_cv', '0.4'), ('xyz_corte_y_cv', '0.8'), ('xyz_min_ordens', '2')) r(k, v)
  order by 1 desc, 2
) to stdout with (format csv, delimiter '|', header true) \g :dir/classificacao_hist.csv

-- ── teto.csv: company_config reposicao_teto_cobertura_oben_* ────────────────────────────────────────────────
copy (
  select key, value from company_config where key like 'reposicao\_teto\_cobertura\_oben\_%' order by key
) to stdout with (format csv, delimiter '|', header true) \g :dir/teto.csv

-- ── equivalencias.csv: pares de SKUs em grupo de embalagem (sku_embalagem_equivalencia, OBEN, ativo) ───────────
-- fator = fator_para_base(sku) / fator_para_base(sku_equivalente) (1 unidade de `sku` = `fator` unidades do
-- equivalente, na unidade-base do grupo). Colunas extras no fim reproduzem o cadastro cru para a conversão do motor.
copy (
  select a.sku_codigo_omie as sku, b.sku_codigo_omie as sku_equivalente,
         a.fator_para_base / b.fator_para_base as fator,
         a.grupo_id, a.fator_para_base as fator_para_base_sku, b.fator_para_base as fator_para_base_equivalente,
         a.unidades_omie_por_embalagem as unidades_omie_sku, b.unidades_omie_por_embalagem as unidades_omie_equivalente
  from sku_embalagem_equivalencia a
  join sku_embalagem_equivalencia b on b.grupo_id = a.grupo_id and b.sku_codigo_omie <> a.sku_codigo_omie
        and b.empresa = a.empresa and b.ativo = true and b.fator_para_base > 0
  where a.empresa = 'oben' and a.ativo = true and a.fator_para_base > 0
  order by a.grupo_id, a.sku_codigo_omie, b.sku_codigo_omie
) to stdout with (format csv, delimiter '|', header true) \g :dir/equivalencias.csv

-- ── sugestao_hoje.csv: última execução do gerar_pedidos_sugeridos_ciclo (OBEN, Sayerlack) ─────────────────────
-- Persistida em pedido_compra_sugerido/pedido_compra_item. "Última execução" = pedidos da MESMA hora de geração
-- do último horario_geracao, sem os cancelados. posicao = estoque_atual (= físico + a caminho − comprometido,
-- conferido nos dados), qtde_final = a quantidade final da linha. O sku pode ser o galão escolhido (troca de embalagem).
copy (
  select i.sku_codigo_omie as sku, i.estoque_atual as posicao, i.qtde_final
  from pedido_compra_sugerido p
  join pedido_compra_item i on i.pedido_id = p.id
  where p.empresa = 'OBEN' and p.fornecedor_nome ilike '%sayerlack%'
    and p.status not in ('cancelado', 'cancelado_humano', 'expirado_sem_aprovacao')
    and date_trunc('hour', p.horario_geracao) = (
          select date_trunc('hour', max(p2.horario_geracao)) from pedido_compra_sugerido p2
           where p2.empresa = 'OBEN' and p2.fornecedor_nome ilike '%sayerlack%'
             and p2.status not in ('cancelado', 'cancelado_humano', 'expirado_sem_aprovacao'))
  order by i.sku_codigo_omie
) to stdout with (format csv, delimiter '|', header true) \g :dir/sugestao_hoje.csv

-- ── outras_empresas.txt: gate §5.1.1 — participação dos MESMOS SKUs Sayerlack fora da OBEN ────────────────────
-- Os mesmos produtos têm o MESMO omie_products.codigo nas contas oben e colacor. Vendas fora da OBEN = pedidos
-- (sales_orders/order_items, conta colacor; a Colacor SC não tem vendas de produto registradas) na janela
-- 2025-10-21..2026-10-20, status fora de cancelado/rascunho/orcamento. Duas bases de OBEN para o denominador:
-- (A) a mesma fonte (order_items) e (B) a fonte do replay (v_venda_items_history_efetivo). Gate = o MAIOR % entre as
-- bases. Transferências entre empresas: não há tabela/fonte read-only no schema (registrado como lacuna).
-- Valores ABSOLUTOS ficam aqui (local); nada deste arquivo vai ao repositório.
with say as (
  select sp.sku_codigo_omie::text as sku, op.codigo
  from sku_parametros sp
  join omie_products op on op.omie_codigo_produto::text = sp.sku_codigo_omie::text and op.account = 'oben'
  where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%'
),
oi as (
  select so.account, s.sku,
         oi.quantity * oi.unit_price - coalesce(oi.desconto_valor, 0) as valor
  from order_items oi
  join sales_orders so on so.id = oi.sales_order_id
  join omie_products p on p.omie_codigo_produto = oi.omie_codigo_produto and p.account = so.account
  join say s on s.codigo = p.codigo
  where so.deleted_at is null and so.status not in ('cancelado', 'rascunho', 'orcamento')
    and so.created_at >= '2025-10-21' and so.created_at < '2026-10-21'
),
a as (select account, count(*) as linhas, coalesce(sum(valor), 0) as valor, count(distinct sku) as skus from oi group by 1),
b as (select count(*) as linhas, coalesce(sum(valor_total), 0) as valor, count(distinct sku_codigo_omie) as skus
        from v_venda_items_history_efetivo
       where empresa = 'OBEN' and sku_codigo_omie::text in (select sku from say)),
oa as (select coalesce(sum(linhas) filter (where account = 'oben'), 0) as l, coalesce(sum(valor) filter (where account = 'oben'), 0) as v from a),
co as (select coalesce(sum(linhas) filter (where account = 'colacor'), 0) as l, coalesce(sum(valor) filter (where account = 'colacor'), 0) as v,
              coalesce(max(skus) filter (where account = 'colacor'), 0) as s from a)
select k, val from (
  select 1 as o, 'colacor_linhas' as k, co.l::text as val from co
  union all select 2, 'colacor_valor', round(co.v, 2)::text from co
  union all select 3, 'colacor_skus_distintos', co.s::text from co
  union all select 4, 'oben_linhas_fonte_pedidos', oa.l::text from oa
  union all select 5, 'oben_valor_fonte_pedidos', round(oa.v, 2)::text from oa
  union all select 6, 'oben_linhas_fonte_nf_replay', b.linhas::text from b
  union all select 7, 'oben_valor_fonte_nf_replay', round(b.valor, 2)::text from b
  union all select 8, 'colacor_sc', 'sem_vendas_de_produto_registradas' 
  union all select 9, 'transferencias', 'sem_fonte_no_schema'
  union all select 10, 'pct_linhas_base_pedidos', round(100.0 * co.l / nullif(co.l + oa.l, 0), 2)::text from co, oa
  union all select 11, 'pct_valor_base_pedidos', round(100.0 * co.v / nullif(co.v + oa.v, 0), 2)::text from co, oa
  union all select 12, 'pct_linhas_base_nf_replay', round(100.0 * co.l / nullif(co.l + b.linhas, 0), 2)::text from co, b
  union all select 13, 'pct_valor_base_nf_replay', round(100.0 * co.v / nullif(co.v + b.valor, 0), 2)::text from co, b
  union all select 14, 'gate_pct_linhas_max', round(greatest(100.0 * co.l / nullif(co.l + oa.l, 0), 100.0 * co.l / nullif(co.l + b.linhas, 0)), 2)::text from co, oa, b
  union all select 15, 'gate_pct_valor_max', round(greatest(100.0 * co.v / nullif(co.v + oa.v, 0), 100.0 * co.v / nullif(co.v + b.valor, 0)), 2)::text from co, oa, b
) t order by o
\g :dir/outras_empresas.txt

-- ── grupos_embalagem.txt: SKUs da coorte em grupo de embalagem e o valor deles ────────────────────────────────
-- Valor = estoque (saldo x cmc, mesma regra do skus.csv) e venda na janela, como % do total Sayerlack.
-- Absolutos aqui (local); só os % podem sair daqui.
with escopo as (
  select sp.sku_codigo_omie::text as sku from sku_parametros sp
  where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%'
),
inv as (
  select distinct on (ip.omie_codigo_produto) ip.omie_codigo_produto::text as sku, ip.saldo, ip.cmc
  from inventory_position ip where ip.account in ('vendas', 'oben')
  order by ip.omie_codigo_produto, ip.synced_at desc nulls last
),
est as (
  select e.sku,
         greatest(coalesce(inv.saldo, 0), coalesce(sea.estoque_fisico, 0)) * case when inv.cmc > 0 then inv.cmc end as valor_estoque   -- sem cmc: fica de fora da soma (NULL), não vira 0
  from escopo e
  left join inv on inv.sku = e.sku
  left join sku_estoque_atual sea on sea.empresa = 'OBEN' and sea.sku_codigo_omie = e.sku
),
ven as (
  select v.sku_codigo_omie::text as sku, sum(v.valor_total) as valor_venda
  from v_venda_items_history_efetivo v where v.empresa = 'OBEN' group by 1
),
grp as (
  select distinct q.sku_codigo_omie as sku, q.grupo_id from sku_embalagem_equivalencia q
   where q.empresa = 'oben' and q.ativo = true
),
tot as (
  select sum(est.valor_estoque) as ve, sum(coalesce(ven.valor_venda, 0)) as vv
  from est left join ven on ven.sku = est.sku
),
em as (
  select count(*) as n, count(distinct g.grupo_id) as ngrupos,
         coalesce(sum(est.valor_estoque), 0) as ve, coalesce(sum(ven.valor_venda), 0) as vv
  from est join grp g on g.sku = est.sku left join ven on ven.sku = est.sku
)
select k, val from (
  select 1 as o, 'skus_coorte' as k, (select count(*) from escopo)::text as val
  union all select 2, 'skus_coorte_em_grupo_embalagem', em.n::text from em
  union all select 3, 'grupos_distintos', em.ngrupos::text from em
  union all select 4, 'pct_skus_em_grupo', round(100.0 * em.n / nullif((select count(*) from escopo), 0), 2)::text from em
  union all select 5, 'estoque_grupo_valor_abs', round(em.ve, 2)::text from em
  union all select 6, 'estoque_total_valor_abs', round(tot.ve, 2)::text from tot
  union all select 7, 'pct_valor_estoque_em_grupo', round(100.0 * em.ve / nullif(tot.ve, 0), 2)::text from em, tot
  union all select 8, 'venda_grupo_valor_abs', round(em.vv, 2)::text from em
  union all select 9, 'venda_total_valor_abs', round(tot.vv, 2)::text from tot
  union all select 10, 'pct_valor_venda_em_grupo', round(100.0 * em.vv / nullif(tot.vv, 0), 2)::text from em, tot
) t order by o
\g :dir/grupos_embalagem.txt

select 'fim', 'ok';
