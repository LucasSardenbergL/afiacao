# Queries canônicas — Financeiro & Margem

Read-only. Financeiro usa coluna `company`. Vocabulário de status é Omie:
`'A VENCER'`/`'ATRASADO'`/`'VENCE HOJE'`/`'RECEBIDO'`/`'PAGO'`/`'CANCELADO'` (ver schema-conventions §6).
⚠️ **As views `fin_aging_receber`/`fin_aging_pagar`/`fin_fluxo_caixa_diario` estão QUEBRADAS em prod**
(filtram o vocabulário morto `ABERTO`/`VENCIDO`/`PARCIAL` → voltam vazias/zeradas — confirmado jun/2026).
Por isso #10a/#11a computam o aging direto do cru. **`data_recebimento`/`data_pagamento` são NULL até
em títulos RECEBIDO/PAGO** → "em aberto" só se infere por `status_titulo`, nunca por `data_*-null`.

---

## #10a — Inadimplência: aging de recebíveis por empresa
Confiabilidade: **alta**. Fonte: `fin_contas_receber` cru (a view `fin_aging_receber` está quebrada
— ver topo). Aging por **data de vencimento**, em aberto por **status** (`saldo = valor_documento −
valor_recebido`, pois a coluna `saldo` é nullable).
```sql
select
  company as empresa,
  round(coalesce(sum(valor_documento - coalesce(valor_recebido,0)) filter (where data_vencimento::date >= current_date), 0), 2)                       as a_vencer,
  round(coalesce(sum(valor_documento - coalesce(valor_recebido,0)) filter (where current_date - data_vencimento::date between 1 and 30), 0), 2)        as venc_1_30,
  round(coalesce(sum(valor_documento - coalesce(valor_recebido,0)) filter (where current_date - data_vencimento::date between 31 and 60), 0), 2)       as venc_31_60,
  round(coalesce(sum(valor_documento - coalesce(valor_recebido,0)) filter (where current_date - data_vencimento::date between 61 and 90), 0), 2)       as venc_61_90,
  round(coalesce(sum(valor_documento - coalesce(valor_recebido,0)) filter (where current_date - data_vencimento::date > 90), 0), 2)                    as venc_90_mais
from fin_contas_receber
where status_titulo not in ('RECEBIDO','CANCELADO')   -- "aberto" por status; data_recebimento é NULL até em recebidos
group by company
order by venc_90_mais desc nulls last;
```

## #10b — Top títulos vencidos (detalhe para cobrança)
Confiabilidade: **alta**. Fonte: `fin_contas_receber`. Nome do cliente via LEFT JOIN (opcional).
Vencidos = `status_titulo in ('ATRASADO','VENCE HOJE')` — NÃO use `data_recebimento is null` (é NULL
até em títulos recebidos → puxaria milhares de pagos).
```sql
select
  cr.company as empresa, cr.omie_codigo_cliente, cr.cnpj_cpf,
  coalesce(p.razao_social, p.name, cr.cnpj_cpf) as nome_cliente,
  cr.numero_pedido, cr.data_vencimento,
  round(cr.valor_documento, 2)                                  as valor_documento,
  round(cr.valor_documento - coalesce(cr.valor_recebido,0), 2)  as saldo_aberto,
  (current_date - cr.data_vencimento::date)                     as dias_atraso
from fin_contas_receber cr
left join omie_clientes oc on oc.omie_codigo_cliente = cr.omie_codigo_cliente
left join profiles p       on p.user_id = oc.user_id
where cr.status_titulo in ('ATRASADO','VENCE HOJE')
order by saldo_aberto desc nulls last
limit 30;
```

---

## #11a — Aging de contas a pagar por empresa
Confiabilidade: **alta**. Fonte: `fin_contas_pagar` cru (a view `fin_aging_pagar` está quebrada — ver
topo). `saldo = valor_documento − valor_pago`.
```sql
select
  company as empresa,
  round(coalesce(sum(valor_documento - coalesce(valor_pago,0)) filter (where data_vencimento::date >= current_date), 0), 2)                    as a_vencer,
  round(coalesce(sum(valor_documento - coalesce(valor_pago,0)) filter (where current_date - data_vencimento::date between 1 and 30), 0), 2)     as venc_1_30,
  round(coalesce(sum(valor_documento - coalesce(valor_pago,0)) filter (where current_date - data_vencimento::date between 31 and 60), 0), 2)    as venc_31_60,
  round(coalesce(sum(valor_documento - coalesce(valor_pago,0)) filter (where current_date - data_vencimento::date between 61 and 90), 0), 2)    as venc_61_90,
  round(coalesce(sum(valor_documento - coalesce(valor_pago,0)) filter (where current_date - data_vencimento::date > 90), 0), 2)                 as venc_90_mais
from fin_contas_pagar
where status_titulo not in ('PAGO','CANCELADO')
group by company
order by company;
```

## #11b — Contas a pagar vencendo nos próximos 7 dias
Confiabilidade: **alta**. Fonte: `fin_contas_pagar`. Em aberto por **status** (`data_pagamento` é NULL
até em títulos PAGO — não usar como filtro).
```sql
select
  company as empresa, nome_fornecedor, data_vencimento,
  round(valor_documento, 2)                                 as valor_documento,
  round(valor_documento - coalesce(valor_pago,0), 2)        as saldo_a_pagar
from fin_contas_pagar
where status_titulo not in ('PAGO','CANCELADO')
  and data_vencimento::date between current_date and current_date + interval '7 days'
order by data_vencimento asc, saldo_a_pagar desc
limit 50;
```

---

## #12 — Fluxo de caixa: próximos 30 dias (previsto vs realizado)
Confiabilidade: **⚠️ QUEBRADA hoje**. Fonte: view `fin_fluxo_caixa_diario` — que filtra o vocabulário
de status morto (`ABERTO`/`PARCIAL`/`VENCIDO` + `RECEBIDO`/`LIQUIDADO`/`PAGO`) → retorna a grade
data×empresa mas com **tudo 0,00**. Até a view ser corrigida em prod, o fluxo NÃO é confiável; use
#10a (entradas a vencer) e #11a (saídas a vencer) como proxy. A query abaixo só vale após o fix.
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
Confiabilidade: **acompanha a cobertura (#13c)** — observado **98,3%** em jun/2026, ou seja **alta**
na prática (revisado: o custo NÃO é esparso como se temia). Ainda assim rode #13c junto p/ confirmar a
cobertura do período antes de precificar. Fontes: `order_items` × `sales_orders` (empresa) × `product_costs`.
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
