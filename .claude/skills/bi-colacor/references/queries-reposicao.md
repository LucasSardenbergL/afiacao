# Queries canônicas — Reposição (compras)

Read-only. **Atenção:** o domínio de reposição usa empresa em **MAIÚSCULO** (`OBEN`/`COLACOR`,
sem Colacor SC) em algumas views, e `empresa_lower` na view de aumento. As 3 queries abaixo já
usam o nome certo de cada uma. Estas views fazem o trabalho pesado — prefira-as a recalcular.

---

## #7 — Pedidos de compra em aberto / atrasados
Confiabilidade: **alta**. Fonte: `v_pedidos_em_aberto` (empresa MAIÚSCULA; status enum).
```sql
select
  empresa, omie_codigo_pedido, status, estagio,
  t1_data_pedido, dias_desde_pedido
from v_pedidos_em_aberto
order by dias_desde_pedido desc nulls last
limit 50;
```
Leitura: `status` segue o enum `CRIADO|FATURADO|EM_TRANSPORTE|RECEBIDO|CANCELADO|DIVERGENCIA`.
`DIVERGENCIA` e pedidos com `dias_desde_pedido` alto são os que precisam de ação. Se quiser só
os realmente parados, filtre `where status not in ('RECEBIDO','CANCELADO')`.

---

## #8 — Aumentos de fornecedor vigentes / iminentes (próximos 30 dias)
Confiabilidade: **alta**. Fonte: `v_sku_aumento_vigente` (coluna de empresa = `empresa_lower`).
```sql
select
  empresa_lower as empresa, fornecedor_nome, familia,
  sku_codigo_omie, aumento_perc, data_vigencia_efetiva
from v_sku_aumento_vigente
where data_vigencia_efetiva <= current_date + interval '30 days'
order by data_vigencia_efetiva asc, aumento_perc desc
limit 50;
```
Leitura: aumentos com vigência próxima + `aumento_perc` alto = janela para antecipar compra
antes do reajuste. Cruze com #9 (oportunidade) e com cobertura de estoque (#6).

---

## #9 — Oportunidade econômica de compra hoje (promoções com janela)
Confiabilidade: **média**. Fonte: `v_oportunidade_economica_hoje`.
```sql
select
  empresa, fornecedor_nome, sku_codigo_omie,
  round(economia_bruta_estimada, 2) as economia_bruta_estimada,
  desconto_total_perc, qtde_oportunidade,
  data_limite_acao, dias_ate_limite
from v_oportunidade_economica_hoje
order by economia_bruta_estimada desc nulls last
limit 50;
```
Leitura: `dias_ate_limite` baixo + `economia_bruta_estimada` alta = decisão urgente de compra.
A economia é **estimada** (média), então confirme estoque/cobertura antes de comprar volume.
