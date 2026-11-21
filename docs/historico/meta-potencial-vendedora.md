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

Atualização 2026-11-21: a reatribuição veio antes do congelamento — a meta de nov congelou em **R$ 565.848** com só
Lucas e Regina como donos (sem "sem vendedora ativa"). O placar só mostrou a linha da meta depois do #4059 (o #4025
lia a coluna fechada `sales_orders.vendedor_user_id` → 403 em todos os tiles).

## Balizamento do valor de uma ligação (premissa a validar com a Nvoip)

Medido em prod em 2026-11-21 (pedidos válidos, `order_date_kpi`). Venda diária, 90 dias, por dia útil com venda:
Oben R$ 24,3k · 18,6 pedidos · ticket R$ 1.308; Colacor R$ 2,8k · 5,5 pedidos · ticket R$ 513; grupo ≈ R$ 27,1k/dia.

Carteira congelada de nov, 12 meses anteriores (receita no mês em que o cliente compra): B R$ 898 (1,3 pedido),
C R$ 1.304 (2,1 pedidos), D R$ 634 (1,3 pedido). Mediana do pedido ≈ metade da média (R$ 280–323) — clientes grandes
puxam a média.

| Conversa com | Conta | Valor esperado |
|---|---|---|
| C (esfriando) | +10 p.p. × R$ 1.304 | R$ 80–130 (a meta usa R$ 79) · ~1 pedido a cada 5 conversas |
| B (ocasional) | 10% × R$ 898 | R$ 75–90 |
| D (perdido) | +5 p.p. × R$ 634 | ~R$ 30 |

**Capacidade:** o incremento de nov (≈ R$ 38,6k sobre 575 B+C+D) pede ~29 conversas/dia útil ≈ 60–95 discagens
(benchmark: ~40% de atendimento em cliente ativo, 15–25 conversas/dia por farmer) ≈ 1,4–2 farmers só ligando.
Priorizar **C e B**; D por WhatsApp/campanha (vale ~1/3 por conversa e custa só ~R$ 5k do incremento).

**Benchmark, não medição:** os +10 p.p. por contato e os 40% de atendimento são faixas gerais de televendas B2B.
Viram dado nosso quando o histórico da Nvoip for persistido. Leitura de nov até o dia 20 (~70% dos dias úteis):
C 11,5% compraram (projeta ~16%, abaixo dos ~19% espontâneos), D 2,2% (vs ~7%), B 16% — sem sinal de ligação ativa.
