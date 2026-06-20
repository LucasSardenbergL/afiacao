# Recência: cap linear configurável (fix da normalização) — design

> Frente money-path. Follow-up da **recência-viva** (`claude/scores-recencia-viva`, commit `fce9e4c5`), construído **em cima** dela. Gate do founder: cap linear **T=180**; escopo delegado a Claude+Codex → **só o cap** (score_confidence vira follow-up).

## Problema (medido em prod via psql-ro, 2026-06-19/20)

O edge `calculate-scores` (cron `daily-calculate-scores` 06:00 — confirmado fonte da verdade; `n/index.ts` é artefato órfão do bot Lovable, **não** o caminho prod) normaliza a recência por min-max global:

```
maxDaysSince = Math.max(...days, 1)          // = 2235 em prod (venda real de ~6 anos, NÃO o sentinela)
recencyScore = max(0, 100 - days/maxDaysSince*100)
```

Com `maxDaysSince=2235`: 90d→96, 365d→84, **sentinela 999→55** (cliente sem venda parece meio-saudável). `recencyScore` vira `rf_score` persistido e entra no `health_score` (peso 25%) → `churn_risk=100-health` → `priority_score` (churn 30%) → agenda + `useTacticalPlan`.

**Dois bugs distintos:**
- **DADO** (corrigido pela recência-viva): 2922 clientes (45,7%) sem venda com `days=0` → recência **100 fabricada**. A recência-viva re-deriva days frescos todo run (overlay antes dos maxes).
- **FÓRMULA** (esta frente): a normalização ÷max comprime e dá 55 ao sem-venda.

**Premissas revertidas pela medição:** (c) "excluir 999 do max" está morta (max real=2235 é venda real); decay hl-30 é descalibrado (30d = ciclo de recompra normal); distribuição bimodal extrema (só 4 clientes com venda real ≤180d) → a *forma* afeta ~4 clientes hoje, é estrutural.

## Decisão (founder + /codex consult high)

**Cap linear configurável, T=180** (`max(0, 100 - min(days,T)/T*100)`):
- Curva: 30d=83, 60d=67, 90d=50, 180d+=0. Governável/interpretável; robusto a outlier; ajustável sem redeploy.
- **Guardrail**: clamp `30 ≤ T ≤ 999` (T>999 ressuscitaria o sentinela 999 em recência >0).
- Sentinela honesto: sem-venda → recência **0** (não 55, não null que quebraria ordenação).

**Não calibra, remove fabricação.** Medição: sob T=180+recência-viva a base vai a **0 'atenção' / 6400 'crítico'** (95% inativa de verdade + outros 5 sinais esparsos → recência domina). Isso é degradação honesta, não bug. Calibrar o health inteiro (sinais vivos + confiança) é outra frente.

**Escopo = só o cap.** `score_confidence`/`sales_history_status` (o "mínimo honesto" do codex para a UI distinguir "esfriou" de "nunca comprou") → follow-up dedicado (migration + UI + prove-sql próprios; minimiza colisão com a recência-viva).

**3ª via (D/I relativo do hook irmão `useFarmerScoring`): rejeitada agora** — 95% sem `avg_repurchase_interval` → "D/30 fantasiado de personalização". Caminho incremental: cap agora; híbrido D/I quando houver `I` confiável.

## Implementação

1. **`src/lib/scoring/recency.ts`** (helper puro):
   - `clampRecencyCapDays(raw): number` — `Number.isFinite`? clamp [30,999] (round); senão 180.
   - `computeRecencyScore(days, capDays): number` — `cap=clamp(capDays)`; `d = isFinite(days) ? max(0,days) : cap` (ausente/NaN→recência 0, money-path); `max(0, 100 - min(d,cap)/cap*100)`.
2. **`src/lib/scoring/__tests__/recency.test.ts`** (vitest): tabela 0/30/90/180/999/2235; ausente(NaN)→0; negativo→100; clamp 1200→999, 10→30, lixo→180; **falsificação** (sabotar Math.min→max e o clamp → vermelho exato).
3. **Espelho verbatim no edge** `calculate-scores/index.ts`: ler `const recencyCapDays = clampRecencyCapDays(config['hs_recency_cap_days'] ?? 180)` junto dos outros pesos; trocar a linha 453 por `computeRecencyScore(Number(client.days_since_last_purchase || 0), recencyCapDays)`; remover `maxDaysSince` se órfão; comentário anti-regressão (rf_score empata; days_since é "quão morto").
4. **Handoff**: bloco `INSERT ... ON CONFLICT` de `hs_recency_cap_days=180` em `farmer_algorithm_config` (edge funciona sem, via `?? 180`; a linha torna ajustável). Deploy manual do edge pelo chat do Lovable (verbatim).

## Prova (money-path)

vitest verde + **falsificação**; paridade helper↔edge (espelho verbatim); typecheck strict; `deno check` do edge; medição do shift via psql-ro (já simulada: T=180 → base honestamente em 'crítico'). /codex consult já incorporado (este design). Sem SQL novo de lógica → prove-sql não se aplica (é TS); o rigor vem do helper testado+falsificado.

## Follow-ups sinalizados (fora de escopo)
- `score_confidence`/`sales_history_status` (degradação honesta na UI/planos).
- `n/index.ts` órfão (artefato do bot Lovable; não chamado por cron — investigar/remover com cuidado).
- Inconsistência limite-90 em `selectObjective` (`daysSince>90`): 90d→'recuperacao', 91d→'reativacao'.
- Health mal-condicionado (outros 5 sinais esparsos) — calibração é frente maior que a recência.
