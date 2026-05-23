# Queries canônicas — Estoque

Read-only. Lembrete crítico: `sku_codigo_omie` tem tipo inconsistente entre tabelas → todo
JOIN de SKU usa `::text` dos dois lados. Empresa é minúscula nessas tabelas (`empresa`).

---

## #4 — Ruptura: SKUs com estoque disponível no/abaixo do ponto de pedido
Confiabilidade: **média** (depende do sync de estoque e dos parâmetros calculados).
Fontes: `sku_estoque_atual` × `sku_parametros`.
```sql
select
  e.empresa, e.sku_codigo_omie,
  e.estoque_disponivel, p.ponto_pedido, p.estoque_minimo,
  p.classe_consolidada as classe_abc_xyz,
  case when e.estoque_disponivel <= 0                                          then 'RUPTURA TOTAL'
       when e.estoque_disponivel <  coalesce(p.estoque_minimo, p.ponto_pedido) then 'ABAIXO DO MINIMO'
       else                                                                         'NO PONTO DE PEDIDO' end as severidade
from sku_estoque_atual e
join sku_parametros p
  on lower(p.empresa) = lower(e.empresa)
 and p.sku_codigo_omie::text = e.sku_codigo_omie::text
where coalesce(p.ativo, true)
  and e.estoque_disponivel <= coalesce(p.ponto_pedido, 0)
order by e.empresa,
         (case when e.estoque_disponivel <= 0 then 0 else 1 end),
         p.classe_consolidada nulls last
limit 100;
```
Leitura: priorize classe A (alto valor) em RUPTURA TOTAL — é venda perdida agora.

---

## #5 — Estoque parado: capital empatado em SKUs sem giro nos últimos 90 dias
Confiabilidade: **média** (giro) + **parcial** (custo, via `cost_confidence`).
Fontes: `sku_estoque_atual` × `v_sku_demanda_estatisticas` (+ `omie_products`/`product_costs`
para estimar R$). `capital_empatado_estimado` nulo = produto sem custo conhecido (não confie).
```sql
select
  e.empresa, e.sku_codigo_omie, e.estoque_disponivel,
  d.ultima_venda_data, d.demanda_total_90d,
  pc.cost_final, pc.cost_confidence,
  round(e.estoque_disponivel * pc.cost_final, 2) as capital_empatado_estimado
from sku_estoque_atual e
left join v_sku_demanda_estatisticas d
       on lower(d.empresa) = lower(e.empresa)
      and d.sku_codigo_omie::text = e.sku_codigo_omie::text
left join omie_products op
       on lower(op.account) = lower(e.empresa)
      and op.omie_codigo_produto::text = e.sku_codigo_omie::text
left join product_costs pc on pc.product_id = op.id
where e.estoque_disponivel > 0
  and coalesce(d.demanda_total_90d, 0) = 0     -- zero giro em 90d
order by capital_empatado_estimado desc nulls last
limit 50;
```
Leitura: o total de `capital_empatado_estimado` é dinheiro preso. Cruze com `ultima_venda_data`
para distinguir "nunca girou" de "parou de girar".

---

## #6 — Cobertura de estoque (dias): risco de ruptura (baixa) e excesso (alta)
Confiabilidade: **média**. Fontes: `sku_estoque_atual` × `sku_parametros`.
```sql
select
  e.empresa, e.sku_codigo_omie, e.estoque_disponivel,
  p.demanda_media_diaria, p.classe_consolidada as classe,
  case when coalesce(p.demanda_media_diaria,0) = 0 then null
       else round(e.estoque_disponivel / p.demanda_media_diaria, 0) end as dias_cobertura,
  p.cobertura_alvo_dias
from sku_estoque_atual e
join sku_parametros p
  on lower(p.empresa) = lower(e.empresa)
 and p.sku_codigo_omie::text = e.sku_codigo_omie::text
where coalesce(p.ativo, true)
  and p.demanda_media_diaria > 0
order by dias_cobertura asc nulls last   -- troque para desc p/ ver EXCESSO (capital ocioso)
limit 50;
```
Leitura: `dias_cobertura` muito abaixo de `cobertura_alvo_dias` = risco de ruptura;
muito acima = excesso / capital ocioso. Roda nos dois sentidos (asc e desc).
