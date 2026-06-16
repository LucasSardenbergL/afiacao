# Queries canônicas — Vendas & Clientes

Todas read-only. Período com defaults sensatos; o comentário diz onde ajustar. Cole no
🟣 Lovable → SQL Editor → Run e cole o resultado de volta.

---

## #1 — Faturamento por empresa (NF-e): mês-até-hoje (MTD) vs mesmo período do mês anterior
Confiabilidade: **alta** (dado fiscal). Fonte: `venda_items_history`.
> **Comparação JUSTA por design:** confronta `[1º do mês → hoje]` com `[1º do mês passado → mesmo
> dia]` (ex.: 01–15/jun vs 01–15/mai). Comparar mês-até-hoje com mês ANTERIOR INTEIRO infla uma
> "queda" que é só o mês corrente ainda não ter acabado — esse era o viés da versão antiga. Para
> fechar um mês cheio, troque `current_date` pelo último dia do mês desejado.
```sql
with p as (
  select date_trunc('month', current_date)                          as ini_atual,
         (current_date + interval '1 day')                          as fim_atual,  -- inclui hoje
         date_trunc('month', current_date - interval '1 month')     as ini_ant,
         ((current_date - interval '1 month')::date + interval '1 day') as fim_ant  -- mesmo dia, mês passado
)
select
  v.empresa,
  round(sum(v.valor_total) filter (where v.data_emissao >= p.ini_atual and v.data_emissao < p.fim_atual), 2) as fat_mtd_atual,
  round(sum(v.valor_total) filter (where v.data_emissao >= p.ini_ant   and v.data_emissao < p.fim_ant),   2) as fat_mtd_mes_ant,
  round(100.0 * (
      sum(v.valor_total) filter (where v.data_emissao >= p.ini_atual and v.data_emissao < p.fim_atual)
    - sum(v.valor_total) filter (where v.data_emissao >= p.ini_ant   and v.data_emissao < p.fim_ant)
  ) / nullif(sum(v.valor_total) filter (where v.data_emissao >= p.ini_ant and v.data_emissao < p.fim_ant), 0), 1) as variacao_pct
from venda_items_history v, p
where v.data_emissao >= p.ini_ant
group by v.empresa
order by fat_mtd_atual desc nulls last;
```

## #1b — Pedidos comerciais por empresa (momentum): 7 dias vs 7 anteriores
Confiabilidade: **alta**. Fonte: `sales_orders` (filtra rascunho/cancelado + soft-delete).
```sql
select
  account as empresa,
  count(*)     filter (where created_at >= current_date - interval '7 days')                                            as pedidos_7d,
  round(sum(total) filter (where created_at >= current_date - interval '7 days'), 2)                                    as valor_7d,
  count(*)     filter (where created_at >= current_date - interval '14 days' and created_at < current_date - interval '7 days') as pedidos_7d_ant,
  round(sum(total) filter (where created_at >= current_date - interval '14 days' and created_at < current_date - interval '7 days'), 2) as valor_7d_ant
from sales_orders
where created_at >= current_date - interval '14 days'
  and status not in ('cancelado','rascunho')
  and deleted_at is null
group by account
order by valor_7d desc nulls last;
```

---

## #2 — Concentração de carteira (Pareto top 20), últimos 90 dias
Confiabilidade: **alta**. Fonte: `venda_items_history`. Mostra quanto do faturamento vem dos
maiores clientes (risco de dependência). Nome enriquecido por LEFT JOIN (opcional — remova as
duas linhas de join e o `razao_social` se quiser só o código).
```sql
with vendas_cliente as (
  select v.empresa, v.cliente_codigo_omie,
         max(v.cliente_cnpj_cpf) as cnpj_cpf,
         sum(v.valor_total)      as faturamento_90d
  from venda_items_history v
  where v.data_emissao >= current_date - interval '90 days'
    and v.cliente_codigo_omie is not null
  group by v.empresa, v.cliente_codigo_omie
),
ranked as (
  select vc.*,
    sum(faturamento_90d) over (partition by empresa)                                                              as total_empresa,
    row_number()         over (partition by empresa order by faturamento_90d desc)                                as rank_cliente,
    sum(faturamento_90d) over (partition by empresa order by faturamento_90d desc
                               rows between unbounded preceding and current row)                                  as acumulado
  from vendas_cliente vc
)
select
  r.empresa, r.rank_cliente, r.cliente_codigo_omie, r.cnpj_cpf, p.razao_social,
  round(r.faturamento_90d, 2)                                  as faturamento_90d,
  round(100.0 * r.faturamento_90d / nullif(r.total_empresa,0), 1) as pct_do_total,
  round(100.0 * r.acumulado      / nullif(r.total_empresa,0), 1) as pct_acumulado
from ranked r
left join omie_clientes oc on oc.omie_codigo_cliente = r.cliente_codigo_omie
left join profiles p       on p.user_id = oc.user_id
where r.rank_cliente <= 20
order by r.empresa, r.rank_cliente;
```
Leitura: se `pct_acumulado` do top 10 já passa de ~60–70%, há concentração relevante.

---

## #3 — Clientes em queda (faturamento 90d vs 90d anterior)
Confiabilidade: **alta**. Fonte: `customer_metrics_mv` (pré-agregado — barato e confiável).
```sql
select
  m.customer_user_id, p.razao_social, m.document,
  round(m.faturamento_prev_90d, 2)  as faturamento_90d_anterior,
  round(m.faturamento_90d, 2)       as faturamento_90d,
  round(100.0 * (m.faturamento_90d - m.faturamento_prev_90d) / nullif(m.faturamento_prev_90d, 0), 1) as variacao_pct,
  m.dias_desde_ultima_compra, m.ultima_compra_data,
  round(m.ticket_medio_90d, 2)      as ticket_medio_90d, m.pedidos_90d
from customer_metrics_mv m
left join profiles p on p.user_id = m.customer_user_id
where m.faturamento_prev_90d > 0                          -- tinha histórico
  and m.faturamento_90d < m.faturamento_prev_90d * 0.7    -- caiu mais de 30% (ajuste o fator)
  and not coalesce(m.is_cold_start, false)
order by (m.faturamento_prev_90d - m.faturamento_90d) desc -- maior PERDA ABSOLUTA primeiro
limit 30;
```
Leitura: priorize por perda absoluta (R$), não só por %. Cliente grande caindo 31% pesa mais
que pequeno caindo 90%.

---

## #14 — Pedidos de venda travados (em aberto há > 3 dias)
Confiabilidade: **alta**. Fonte: `sales_orders`. O vocabulário de status pode variar — se a
query vier vazia ou estranha, rode antes o diagnóstico de status (ver schema-conventions §5).
```sql
select
  account as empresa, id, status, round(total,2) as total, created_at,
  (current_date - created_at::date) as dias_em_aberto, ready_by_date
from sales_orders
where status in ('pendente','confirmado')   -- estados ativos não-finalizados; ajuste ao vocabulário real
  and deleted_at is null
  and created_at::date <= current_date - interval '3 days'
order by created_at asc
limit 50;
```

---

## #15 — Vendas tintométrico por empresa: mês-até-hoje (MTD) vs mesmo período do mês anterior
Confiabilidade: **média** (`preco_praticado` é nullable — a coluna `itens_sem_preco` mede o
buraco). Fontes: `tint_vendas` (header: empresa+data) × `tint_vendas_itens` (valor).
> Mesma janela simétrica da #1 (MTD vs mesmo período do mês passado) — não compara meio mês com
> mês cheio. Para fechar mês cheio, troque `current_date` pelo último dia do mês.
```sql
with p as (
  select date_trunc('month', current_date)                          as ini_atual,
         (current_date + interval '1 day')                          as fim_atual,
         date_trunc('month', current_date - interval '1 month')     as ini_ant,
         ((current_date - interval '1 month')::date + interval '1 day') as fim_ant
)
select
  tv.account as empresa,
  round(sum(ti.preco_praticado) filter (where tv.data_venda >= p.ini_atual and tv.data_venda < p.fim_atual), 2) as fat_mtd_atual,
  round(sum(ti.preco_praticado) filter (where tv.data_venda >= p.ini_ant   and tv.data_venda < p.fim_ant),   2) as fat_mtd_mes_ant,
  count(distinct tv.id) filter (where tv.data_venda >= p.ini_atual and tv.data_venda < p.fim_atual)            as vendas_mtd_atual,
  count(*)              filter (where ti.preco_praticado is null)                                               as itens_sem_preco
from tint_vendas tv
join tint_vendas_itens ti on ti.venda_id = tv.id
cross join p
where tv.data_venda >= p.ini_ant
group by tv.account
order by fat_mtd_atual desc nulls last;
```
