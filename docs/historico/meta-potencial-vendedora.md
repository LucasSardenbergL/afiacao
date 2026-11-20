# Meta por potencial da vendedora (Meu dia do CEO, leva 2 — 2026-11-20)

Spec: `docs/superpowers/specs/2026-11-20-meta-potencial-vendedora-design.md` · migration `20261120230000_meta_potencial`
(aplicada via `db:aplicar`, tentativa #1246) · prova `db/test-meta-potencial.sh` (36 asserts, falsificada).

## Lição: alavanca que já acontece sozinha não é alavanca

A 1ª proposta (recuperar 20% dos esfriando, reativar 10% dos perdidos) parecia razoável. O backtest em 12 cortes
mensais por conta mostrou que **~19% dos clientes C e ~7% dos D voltam no mês sem ação registrada** — as "taxas
de alavanca" eram o retorno espontâneo, e somá-las à base cobrava a mesma venda duas vezes (Codex, achado 1).
Regra: **toda premissa de "potencial" passa por backtest contra o espontâneo antes de virar meta**; a meta separa
previsão calibrada (o que vem sozinho) de incremento (o que depende de ação).

Outros números do backtest (nov/2025–out/2026): base A+B (run-rate 6m dos ativos ≤60d) erra ~±10% na Oben fora de
dez/jan; a Colacor sozinha oscila ±40% (por isso o índice sazonal é do grupo); estreias de família já acontecem
~65/mês na Oben (R$ 25k) — cross-sell incremental é pequeno; dezembro = 0,68 do ritmo no grupo.

## Ligações: ausente

`call_log` = 20 linhas de teste (mai–jun/2026), `farmer_calls` = 0. A produtividade em ligações/dia só existe na
API da Nvoip (`nvoip-calls` `/calls/history`, não persistido). Ficou fora da v1; é fase própria, com sensor.

## Sensor (está sendo usada?)

```sql
SELECT dia, count(*) AS usuarios, sum(n) AS aberturas FROM public.meta_potencial_visualizacao GROUP BY 1 ORDER BY 1 DESC;
-- efeito (mês seguinte): quantos C/D congelados voltaram
SELECT c.segmento, count(*) AS clientes, count(*) FILTER (WHERE EXISTS (
  SELECT 1 FROM public.sales_orders o WHERE o.customer_user_id = c.customer_user_id AND o.account = c.account
    AND o.deleted_at IS NULL AND o.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND o.order_date_kpi >= c.mes AND o.order_date_kpi < c.mes + interval '1 month')) AS voltaram
FROM public.meta_potencial_carteira c WHERE c.mes = date_trunc('month', now())::date GROUP BY 1;
```

Fase N+1 (ligações Nvoip, ajuste de premissas) só com sinal positivo dessas duas queries.

## Nota de atribuição

Dono = `carteira_assignments` elegível **congelado no 1º acesso a partir do dia 3**. Em nov/2026 a carteira da
Tatyana (inativa) ainda carregava ~R$ 151k de meta — aparece como "sem vendedora ativa" até a reatribuição.
