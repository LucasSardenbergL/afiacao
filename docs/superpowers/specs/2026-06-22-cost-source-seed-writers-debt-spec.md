# Spec — dívida de governança: os seed writers de `product_costs` não aplicam a escada de custo

- **Data:** 2026-06-22
- **Status:** DECIDIDO — **ADIADO** (Codex + Claude convergentes, 2026-06-22). Dívida de **governança** money-path, **NÃO-urgente**: implementar só se priorizado. · money-path
- **Relacionado:** #977 (escada `cost_source` / cmc-first), #988 (`CMC_MARGEM_ATIPICA`), spec `2026-06-22-cost-source-unidade-suspeita-spec.md`; `docs/agent/money-path.md`, `docs/agent/reposicao.md` (§cmc-first, item escada)
- **Arquivos no alvo (SÓ se priorizado):** `supabase/functions/omie-analytics-sync/index.ts` (seed bulk `:847` + select de resolução `:777`), `supabase/functions/sync-reprocess/index.ts` (seed N+1 `:587`), helper compartilhado novo espelhado (`src/lib/custo/*` + `supabase/functions/_shared/*`, paridade), `recommendation_config`

## 1. Problema

Os **dois** writers que inserem produto **NOVO** em `product_costs` gravam a linha **crua** `{ cost_source: 'CMC', cost_confidence: 0.7, cost_price: cmc }` **sem** passar pela escada (`computeCostLadder`):

- **Seed bulk** — [`omie-analytics-sync/index.ts:847`](../../../supabase/functions/omie-analytics-sync/index.ts) (dentro de `syncInventory`, no `.map` de `aInserir`; o comentário em `:820-826` já assume "este writer NUNCA promove proveniência… a autoridade do `cost_source` é `computeCosts`").
- **Seed N+1** — [`sync-reprocess/index.ts:587`](../../../supabase/functions/sync-reprocess/index.ts) (`insert` dentro do loop de página).

Consequência: **no momento do seed** faltam (a) o **guard anti-lixo** `cmc/price ∈ [0.01, 5]` e (b) a **classificação** `CMC` vs `CMC_MARGEM_ATIPICA`. Isso só é reconciliado no próximo **`computeCosts`** — a **AUTORIDADE**, [`omie-analytics-sync/index.ts:959`](../../../supabase/functions/omie-analytics-sync/index.ts) → `montarUpsertsDeCusto` ([`_shared/cost-compute.ts:48`](../../../supabase/functions/_shared/cost-compute.ts)) — que aplica o ladder a **todo ativo COM preço** (`.eq("ativo", true)` no select `:982`; `montarUpsertsDeCusto` **pula** `valor_unitario <= 0`, [`cost-compute.ts:76`](../../../supabase/functions/_shared/cost-compute.ts)).

## 2. Por que NÃO é urgente — e por que ainda assim é dívida real

- **O número nunca é mascarado.** `cost_price = cmc` é o custo **REAL**. Invariante do #977: só fontes CMC-derivadas (`CMC`/`CMC_MARGEM_ATIPICA`) carregam `cost_price`, e **sempre `= cmc`** (0 violações em prod). Não há fabricação de número — o money-path mais grave (ausente≠zero / lavagem de proveniência) **não** está em jogo aqui.
- **O risco é estreito:** apenas **`cmc`-LIXO** (cmc/price fora de `[0.01, 5]` — quase-zero ou desproporcional, ~erro de dado, raro) entrando **cru** no cockpit/scoring na **janela** entre o seed e o próximo recompute, rotulado `CMC` conf 0.7 em vez de **rejeitado/rebaixado** a proxy. **Medido (§3.3): `fora_antilixo`=0 em estado estável** — não há passivo acumulado; o risco é a janela transitória, não um estoque de erro.
- **Mitigação da janela** = encurtar a exposição subindo a cadência do recompute. ✅ **Confirmado (§3.2): o cron `compute-costs` roda a cada 2h** (5 execuções `:45` consecutivas medidas às 12:19Z) — janela de exposição ≤2h.
- **Tocar o seed = caminho QUENTE** (roda em todo sync de inventário, alta frequência) → adiado: **risco de regressão > dano atual**. A mitigação certa de curto prazo é a cadência do recompute, não o seed.

## 3. Evidência

### 3.1 Código (repo — ancorado)

| Fato | Âncora |
|---|---|
| Seed bulk grava CMC/0.7/cost_price=cmc cru | `omie-analytics-sync/index.ts:847` |
| Seed N+1 idem | `sync-reprocess/index.ts:587` |
| `computeCosts` é a autoridade (carrega `recommendation_config` `:961`, catálogo ativo `:982`) | `omie-analytics-sync/index.ts:959` |
| Authority **pula** `price<=0` → nunca reclassifica sem-preço | `_shared/cost-compute.ts:76` (`if (!price \|\| price <= 0) continue;`) |
| Ladder devolve `UNKNOWN`/`cost_price=null` p/ `price<=0` | `_shared/cost-ladder.ts:60` |
| Anti-lixo + classificação CMC/CMC_MARGEM_ATIPICA vivem no ladder | `_shared/cost-ladder.ts:67-80` |
| Helper espelhado já existe (reuso) | `src/lib/custo/costLadder.ts` + `_shared/cost-ladder.ts` + `costLadder.parity.test.ts` |

### 3.2 Cron `compute-costs` (medido em prod via psql-ro, 2026-06-23 01:25Z)

- **Repo:** `compute-costs-daily` = `'0 7 * * *'` (1×/dia) em [`cron_baseline.sql:41`](../../../supabase/migrations/20260527230000_cron_baseline.sql) e [`crons_timeout_fix.sql:41`](../../../supabase/migrations/20260527170000_crons_timeout_fix.sql). A migration [`20260622163000_compute_costs_recompute_2h.sql`](../../../supabase/migrations/20260622163000_compute_costs_recompute_2h.sql) (`cron.alter_job` → `45 */2`, mantém o jobname p/ não divergir do baseline/DR) versiona a mitigação — mergeada na `main` por outra sessão. _(Na 1ª redação desta spec, às 01:25Z, ela ainda não existia no repo; entrou via merge da `main`.)_
- **Registro do cron (`cron.job`):** schedule **`45 */2 * * *`** (a cada 2h, em `:45` — logo após o seed do `sync-reprocess` em `:15`), `active=t`. ✅ premissa do "2h" confirmada *no registro do scheduler*.
- **Execução real (`cron.job_run_details`) — CONFIRMADA efetiva (re-medido 2026-06-23 12:19Z):** na 1ª medição (01:25Z) a última run era 2026-06-22 07:00Z (~18h) e nenhuma `:45` havia ocorrido — falso alarme: o reschedule fora aplicado **na noite anterior, antes da 1ª janela** (pg_cron estava vivo — 4 jobs `*/2` rodando). Re-medido às 12:19Z: **5 execuções consecutivas a cada 2h** — `02:45 → 04:45 → 06:45 → 08:45 → 10:45Z`, todas `succeeded`. ✅ A mitigação 2h está **de pé e disparando** (benigna, não travada).
- **Dano = 0 nos dois sentidos:** `fora_antilixo=0` (§3.3, sem passivo acumulado) **e** a janela de exposição seed→recompute é comprovadamente **≤2h**.

### 3.3 Dimensionamento do passivo (medido em prod, 2026-06-23 01:25Z)

| `cost_source` (ativos) | linhas | `cmc/price` fora `[0.01,5]` | sem preço (`valor_unitario<=0`) |
|---|---|---|---|
| `CMC` | 1480 | **0** | **622** (dos quais **21 com venda** em `order_items`) |
| `CMC_MARGEM_ATIPICA` | 116 | **0** | 0 |

- **`fora_antilixo = 0`** → em estado estável o recompute não deixa `cmc`-lixo rotulado como CMC; o risco é só a **janela transitória** seed→recompute (e, agora, a janela está alargada pelo cron não-disparando — §3.2).
- **622 sem preço** é o universo que ficaria **`UNKNOWN` permanente** se o seed gravasse UNKNOWN (§4) — **não** 21. A estimativa de ~21 da decisão era o subconjunto **com venda** (maior impacto no cockpit), confirmado: **21**.

## 4. ⚠️ Invariante crítica — o furo da 2ª rodada do Codex

**Para produto SEM preço (`valor_unitario <= 0`): MANTER `cost_source='CMC'` + `cost_price=cmc` (status quo). NÃO gravar `UNKNOWN`/sem `cost_price`.**

Porque a mecânica é uma armadilha:
1. `computeCostLadder` retorna `UNKNOWN`/`costPriceToPersist=null` quando `price<=0` ([`cost-ladder.ts:60`](../../../supabase/functions/_shared/cost-ladder.ts)).
2. `montarUpsertsDeCusto` (o que o recompute roda) **pula** `price<=0` ([`cost-compute.ts:76`](../../../supabase/functions/_shared/cost-compute.ts)) → **nunca** reclassifica esse produto.
3. ⇒ Se o seed gravasse `UNKNOWN`, ele seria **PERMANENTE** → regressão de **622 ativos sem preço** (medido §3.3), dos quais **21 com venda** (`order_items.unit_price`) são os de maior impacto no cockpit — hoje **corretos** via `cost_price=cmc`.

Regra de implementação: **só chamar o ladder quando `valor_unitario > 0`**; senão, preservar a linha CMC crua de hoje.

## 5. Tarefa — SÓ se priorizada

Extrair **um helper compartilhado** (DRY entre os 2 writers, puro, espelhado `src/lib/custo` ↔ `_shared`, paridade byte-a-byte) que decide a linha de seed:

```
seedLinhaCusto({ cmc, valorUnitario, cfg }):
  se valorUnitario > 0  → computeCostLadder({ price: valorUnitario, cmc, familyTargetMargin: null, cfg })
                          → mapeia p/ { cost_source, cost_price: costPriceToPersist, cost_confidence }  (CMC vs CMC_MARGEM_ATIPICA; lixo → proxy/null)
  senão                 → { cost_source: 'CMC', cost_price: cmc, cost_confidence: 0.7 }  // STATUS QUO — §4
  (em ambos: cmc cru preservado na coluna `cmc`)
```

Carga de dados que cada writer precisa adicionar:
- **`omie-analytics-sync` (bulk):** `valor_unitario` **não** está no escopo do seed (o `posicoes` Map só tem `saldo/cmc/precoMedio`). Adicionar `valor_unitario` ao select de resolução `idByCod` (`:777`, hoje `"id, omie_codigo_produto"`) + carregar `recommendation_config` 1× (como `computeCosts` em `:961`).
- **`sync-reprocess` (N+1):** `prod.valor_unitario` **já** está à mão (`:446/:458`). Carregar `recommendation_config` **1× fora do loop** (não N+1).
- `familyTargetMargin = null` no seed (não há amostra de família à mão; o recompute refina depois). ⇒ p/ `cmc`-lixo o ladder cai em `DEFAULT_PROXY`/`cost_price=null` — comportamento **desejado** (não semear lixo como CMC).

## 6. Decisões batidas (Codex + Claude convergentes, 2026-06-22)

- **D1 — Adiar o toque no seed** (caminho quente, alta freq; regressão > dano). Mitigar a janela pela **cadência do recompute**, não pelo seed.
- **D2 — Helper puro compartilhado e espelhado**, reusando `computeCostLadder` (não reimplementar o anti-lixo/banda) — paridade byte-a-byte testada, como `costLadder`/`costCompute`.
- **D3 — Sem-preço preserva o status quo** (`CMC` + `cost_price=cmc`); o ladder só entra com `valor_unitario>0` (§4 — furo do Codex, 2ª rodada).
- **D4 — O número nunca foi o problema** (`cost_price=cmc` é real, invariante #977 intacta); a dívida é só de **classificação/anti-lixo na janela** — daí "governança", não correção urgente.

## 7. Verificação — na implementação (ritual money-path)

- Ler `docs/agent/money-path.md` + `docs/agent/reposicao.md` (cmc-first) antes de tocar.
- **Paridade byte-a-byte** do helper novo (`src/lib/custo` ↔ `_shared`), test de paridade no CI.
- **Vitest com FALSIFICAÇÃO** (sabotar → exigir vermelho): casos-chave — `cmc` normal → `CMC`; `cmc` margem-atípica real → `CMC_MARGEM_ATIPICA`; `cmc`-lixo (fora `[0.01,5]`) → proxy/`cost_price=null`; **`valor_unitario<=0` → preserva `CMC`+`cost_price=cmc`** (não-regressão dos ~21).
- **Medir antes** via psql-ro (cron real + passivo, §3.2/§3.3).
- **2ª opinião /codex (money-path)** na metodologia + adversarial no diff.
- **Deploy MANUAL pós-merge** dos **2 edges** (`omie-analytics-sync` + `sync-reprocess`) pelo chat do Lovable (verbatim do repo) + re-invocar `compute_costs` (merge ≠ produção). `typecheck` strict + `deno check` dos edges.

## 8. Riscos / Não-objetivos

- **Risco principal:** regressão no **caminho quente** (todo sync) — daí o adiamento; exige a falsificação do sem-preço (§4) e revisão Codex no diff.
- **Não corrige a FONTE** do `cmc`-lixo (lançamento errado no Omie) — é guard/classificação, não correção de dado.
- **Não-objetivo:** mudar a escada (`cost-ladder.ts` fica intacto) nem a autoridade (`computeCosts`); o seed só passa a **delegar** a ela.
- **Curto prazo (independente desta dívida):** garantir a cadência do recompute (§3.2) — mitigação barata e segura (reschedule de cron via `lovable-db-operator`), **não** toca o caminho quente.
