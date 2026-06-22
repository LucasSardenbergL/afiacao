# Design — `CMC_MARGEM_ATIPICA`: desmascarar margem negativa/atípica real no motor de custo

> Money-path. Fecha a pendência **(b)** deixada pelo PR #977 (`docs/historico/bugs-resolvidos.md`, 2026-06-22):
> *"CMC fora do sanity (margem negativa real / venda no prejuízo) é rejeitado e degrada p/ proxy → ESCONDE a margem ruim real → tornar observável."*

## Problema

`computeCostLadder` (`src/lib/custo/costLadder.ts`, espelhado verbatim em `supabase/functions/_shared/cost-ladder.ts`) tem um guard `sane(c)` que só aceita o CMC como custo REAL se ele cair na **faixa de margem plausível** `(margemMin, margemMax)` = `(5%, 85%)`, i.e. custo ∈ `(price·0.15, price·0.95)`. Um CMC **real** que implica margem **negativa** (venda no prejuízo: `cmc ≥ price`) ou **baixa** (`0–5%`) ou **alta** (`>85%`) é **rejeitado** e a escada degrada para `FAMILY_MARGIN_PROXY`/`DEFAULT_PROXY` — um proxy de margem "bonita". O motor **esconde** o sinal ruim real, substituindo o custo real por um inventado. É o **inverso do #977** (lá o proxy era promovido a real; aqui um real ruim é rebaixado a proxy) e viola o espírito money-path: *degradar honestamente, nunca fabricar, ausente ≠ zero*.

## Medição (prod, read-only `psql-ro`, universo `price>0`, cfg `min=0.05/max=0.85`)

| Faixa | Ativos | Capital empatado | Nota |
|---|---|---|---|
| Margem NEGATIVA (`cmc≥price`) | 19 | R$ 19.558 | + 15 inativos; +30 hoje `CMC` por dessincronia → seriam mascarados na próxima recompute |
| Margem baixa 0–5% | 4 | R$ 1.034 | positiva mas < margemMin |
| Margem >85% (`cmc` baixo) | 115 | R$ 61.789 | **86 são margem 85–95% = real** (abrasivos); só 8 `<0.1%` cheiram a erro |
| Dentro do sanity | 858 | R$ 1,1M | saudável |

Ratio `cmc/price` nos negativos: `1.0–2.0×` = 30 SKUs (real/plausível), único absurdo `14.39×` (1 SKU inativo). **Gap empírico limpo: 4.97× → 14.39×.** Materialidade de venda baixa (R$1,2k/180d) → o valor é **governança/visibilidade de margem**, conjunto pequeno e auditável (dezenas).

Conclusão: o `sane()` **simétrico** mascara sinal real nos **dois** extremos (prejuízo E margem-alta). O lixo de dado é caracterizado por **desproporção absoluta** (custo quase-zero ou muitas vezes o preço), não por margem fora da banda comercial.

## Decisão (founder via AskUserQuestion + `/codex consult` reasoning high)

1. **Abordagem (a)** — `cost_source` dedicado (delegada a "claude + codex"; ambos convergiram). Não (b) [mantém a mentira no `cost_final` + migration] nem (c) [perde o sinal auditável].
2. **Propagar como real** — o source novo entra em `COST_SOURCES_REAIS`; `resolverCustoConfiavel` retorna o CMC. Margem negativa fica visível no cockpit e ranqueia o SKU mal (correto). Codex: "null seria teatro" — consumidores source-blind (`custoCanonico`, `fin-valor-cockpit`, hooks) já leem `cost_final` direto.
3. **Corrigir os dois lados** — a banda plausível passa a ser só **classificador** (`CMC` normal vs `CMC_MARGEM_ATIPICA`); a **rejeição** vira só o anti-lixo absoluto.

## Desenho

Novo `CostSource`: **`CMC_MARGEM_ATIPICA`**. Helper passa a:

```
price inválido → UNKNOWN (inalterado)
cmcReal(c): c>0 ∧ finito ∧ price·kMin ≤ c ≤ price·kMax     // guard anti-lixo ABSOLUTO (largo)
  ├─ dentro da banda (margemMin,margemMax) estrito → CMC               conf 0.85  cost_price=cmc
  └─ fora da banda mas dentro do anti-lixo        → CMC_MARGEM_ATIPICA conf 0.60  cost_price=cmc
sem cmc real (ausente/zero/lixo absoluto) → proxy família/default (cost_price=null) | nada muda
```

**Parâmetros** (configuráveis via `recommendation_config`, defaults no código → sem migration):
- `cmcRatioMin = 0.01` (rejeita custo < 1% do preço = quase-zero/brinde/erro)
- `cmcRatioMax = 5` (rejeita custo > 5× preço; gap empírico real 4.97×→14.39×)
- Confiança atípica: `0.60`.
- Keys: `margem_cmc_ratio_min` / `margem_cmc_ratio_max` (founder pode ajustar via SQL Editor sem deploy; mudar o **default** exige deploy do edge).

**Invariante atualizada:** antes *"só `CMC` carrega `cost_price`, sempre `=cmc`"* → agora *"só sources REAIS derivados de CMC (`CMC`, `CMC_MARGEM_ATIPICA`) carregam `cost_price=cmc`; proxies sempre `null`"*. A média de família continua treinada **só na banda normal** (caller já filtra `margin>min ∧ margin<max`) — atípico **não** entra na média.

## Blast radius

- `src/lib/custo/costLadder.ts` + `supabase/functions/_shared/cost-ladder.ts` — **byte-a-byte** (parity test).
- Caller `supabase/functions/omie-analytics-sync/index.ts` `computeCosts` — carregar `cmcRatioMin/Max` do config, passar no `cfg`.
- Classificadores (COST CONTRACT, 3 cópias): `src/lib/custos/cost-source.ts` + espelhos `recommend/index.ts`, `algorithm-a-audit/index.ts` — `CMC_MARGEM_ATIPICA` ∈ `COST_SOURCES_REAIS`.
- Display: `src/components/analyticsSync/EngineCards.tsx` (mostra o source novo, 60%).
- Testes: `costLadder.test.ts` (reescrever casos out-of-band), `cost-source.test.ts` (source novo é real).
- **Não roteado** (escopo, documentado): writers diretos de CMC `omie-analytics-sync:853` / `sync-reprocess:591` rotulam `CMC` em seed de produto novo; `computeCosts` reconcilia para `ATIPICA` no ciclo seguinte. Não mascaram (gravam o cmc real).

## Verificação (TDD + falsificação)

- vitest custo: casos `CMC`/`CMC_MARGEM_ATIPICA`/proxy + bordas + anti-lixo (kMin/kMax) + `cost_price` invariante; **falsificar** (sabotar o helper → vermelho).
- paridade src×edge; `cost-source` (source novo real) + `auditoria-margem`.
- typecheck strict 0 · `deno check` edge 0 · suíte completa.

## Deploy (manual, pós-merge — `docs/agent/deploy.md`)

1. Edge `omie-analytics-sync` (+ `recommend`, `algorithm-a-audit`) deploy via chat do Lovable, verbatim do repo.
2. **Recompute** (`computeCosts`) para reclassificar os ~158 SKUs out-of-band para `CMC_MARGEM_ATIPICA` (e os +30 dessincronizados antes que a recompute os mascarasse).
3. Sentinela: `cost_price≠cmc` deve permanecer 0 (agora `cost_source ∈ {CMC, CMC_MARGEM_ATIPICA}`); listar `CMC_MARGEM_ATIPICA` para auditoria do founder.

## Riscos

- **Ranking money-path muda:** margem negativa passa a propagar (EIP/score). Intencional (founder: "propagar como real"); conjunto pequeno (dezenas).
- **kMax=5 deixa passar erro de dado raro** como atípico (conf 0.60, sinalizado) — preferível a mascarar prejuízo real; auditável; configurável.
