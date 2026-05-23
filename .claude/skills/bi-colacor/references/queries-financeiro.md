# Queries canônicas — Financeiro & Margem

Read-only. Financeiro usa coluna `company`. As views de aging já vêm bucketizadas por empresa.
Vocabulário de inadimplência é Omie: `'ATRASADO'` = vencido (ver schema-conventions §6).

---

## #10a — Inadimplência: aging de recebíveis por empresa (resumo pronto)
Confiabilidade: **alta**. Fonte: view `fin_aging_receber` (já bucketizada).
```sql
select
  company as empresa,
  round(a_vencer_valor, 2)        as a_vencer,
  round(vencido_1_30_valor, 2)    as venc_1_30,
  round(vencido_31_60_valor, 2)   as venc_31_60,
  round(vencido_61_90_valor, 2)   as venc_61_90,
  round(vencido_90_plus_valor, 2) as venc_90_mais,
  round(vencido_1_30_valor + vencido_31_60_valor + vencido_61_90_valor + vencido_90_plus_valor, 2) as total_vencido
from fin_aging_receber
order by total_vencido desc nulls last;
```

## #10b — Top títulos vencidos (detalhe para cobrança)
Confiabilidade: **alta**. Fonte: `fin_contas_receber`. Nome do cliente via LEFT JOIN (opcional).
```sql
select
  cr.company as empresa, cr.omie_codigo_cliente, cr.cnpj_cpf, p.razao_social,
  cr.numero_pedido, cr.data_vencimento,
  round(cr.valor_documento, 2)                                  as valor_documento,
  round(cr.valor_documento - coalesce(cr.valor_recebido,0), 2)  as saldo_aberto,
  (current_date - cr.data_vencimento::date)                     as dias_atraso
from fin_contas_receber cr
left join omie_clientes oc on oc.omie_codigo_cliente = cr.omie_codigo_cliente
left join profiles p       on p.user_id = oc.user_id
where cr.status_titulo = 'ATRASADO'
   or (cr.data_recebimento is null and cr.data_vencimento::date < current_date)
order by saldo_aberto desc nulls last
limit 30;
```

---

## #11a — Aging de contas a pagar por empresa
Confiabilidade: **alta**. Fonte: view `fin_aging_pagar`.
```sql
select
  company as empresa,
  round(a_vencer_valor, 2)        as a_vencer,
  round(vencido_1_30_valor, 2)    as venc_1_30,
  round(vencido_31_60_valor, 2)   as venc_31_60,
  round(vencido_61_90_valor, 2)   as venc_61_90,
  round(vencido_90_plus_valor, 2) as venc_90_mais
from fin_aging_pagar
order by company;
```

## #11b — Contas a pagar vencendo nos próximos 7 dias
Confiabilidade: **alta**. Fonte: `fin_contas_pagar` (baixa = `data_pagamento`).
```sql
select
  company as empresa, nome_fornecedor, data_vencimento,
  round(valor_documento, 2)                                 as valor_documento,
  round(valor_documento - coalesce(valor_pago,0), 2)        as saldo_a_pagar
from fin_contas_pagar
where data_pagamento is null
  and data_vencimento::date between current_date and current_date + interval '7 days'
order by data_vencimento asc, saldo_a_pagar desc
limit 50;
```

---

## #12 — Fluxo de caixa: próximos 30 dias (previsto vs realizado)
Confiabilidade: **média**. Fonte: view `fin_fluxo_caixa_diario`.
```sql
select
  data,
  round(entradas_previstas, 2)  as entradas_previstas,
  round(entradas_realizadas, 2) as entradas_realizadas,
  round(saidas_previstas, 2)    as saidas_previstas,
  round(saidas_realizadas, 2)   as saidas_realizadas,
  round(entradas_previstas - saidas_previstas, 2) as saldo_previsto_dia
from fin_fluxo_caixa_diario
where data between current_date and current_date + interval '30 days'
order by data;
```
Nota: se a view tiver coluna `company`, adicione-a ao select e ao `order by` para separar por
empresa. Confira em `types.ts` se precisar.

---

## #13a — Margem top-down (DRE) por empresa, mês atual
Confiabilidade: **alta** (consolidado contábil). Fonte: `fin_dre_snapshots`.
```sql
select
  company as empresa, ano, mes,
  round(receita_liquida, 2) as receita_liquida,
  round(cmv, 2)             as cmv,
  round(lucro_bruto, 2)     as lucro_bruto,
  round(100.0 * lucro_bruto / nullif(receita_liquida,0), 1) as margem_bruta_pct,
  round(resultado_liquido, 2) as resultado_liquido, regime
from fin_dre_snapshots
where ano = extract(year  from current_date)::int
  and mes = extract(month from current_date)::int
order by company;
```
Se vier vazio, o mês ainda não foi snapshotado — troque para o mês anterior
(`mes = extract(month from current_date - interval '1 month')::int` e ajuste `ano`).

## #13b — Margem por produto (ESTIMADA), últimos 30 dias
Confiabilidade: **BAIXA/PARCIAL** ⚠️. Depende de `product_costs` preenchido. Rode SEMPRE junto
com #13c para saber qual % da receita tem custo. NÃO use para precificar sem checar cobertura.
Fontes: `order_items` × `sales_orders` (empresa) × `product_costs` (via `omie_products`).
```sql
with itens as (
  select
    so.account as empresa, oi.product_id, oi.omie_codigo_produto,
    sum(oi.quantity)                                            as qtd,
    sum(oi.quantity * oi.unit_price - coalesce(oi.discount,0))  as receita
  from order_items oi
  join sales_orders so on so.id = oi.sales_order_id
  where so.created_at >= current_date - interval '30 days'
    and so.status not in ('cancelado','rascunho')
    and so.deleted_at is null
  group by so.account, oi.product_id, oi.omie_codigo_produto
)
select
  i.empresa, i.omie_codigo_produto,
  round(i.receita, 2)                                                      as receita,
  pc.cost_final, pc.cost_confidence,
  round(i.receita - (i.qtd * pc.cost_final), 2)                            as margem_estimada,
  round(100.0 * (i.receita - (i.qtd * pc.cost_final)) / nullif(i.receita,0), 1) as margem_pct
from itens i
left join product_costs pc on pc.product_id = i.product_id
order by margem_estimada asc nulls last   -- piores margens E itens sem custo (null) no topo
limit 50;
```

## #13c — Cobertura de custo (gate de confiabilidade da #13b)
Diz qual fatia da receita tem custo conhecido. Sem isso, a margem por produto é ficção.
```sql
with itens as (
  select oi.product_id,
         oi.quantity * oi.unit_price - coalesce(oi.discount,0) as receita
  from order_items oi
  join sales_orders so on so.id = oi.sales_order_id
  where so.created_at >= current_date - interval '30 days'
    and so.status not in ('cancelado','rascunho')
    and so.deleted_at is null
)
select
  round(100.0 * sum(i.receita) filter (where pc.cost_final is not null) / nullif(sum(i.receita),0), 1) as pct_receita_com_custo,
  count(*) filter (where pc.cost_final is null) as linhas_sem_custo,
  count(*)                                       as linhas_total
from itens i
left join product_costs pc on pc.product_id = i.product_id;
```
Leitura: se `pct_receita_com_custo` < ~70%, trate a margem por produto (#13b) como meramente
indicativa e lidere a conversa de margem pela DRE (#13a).
