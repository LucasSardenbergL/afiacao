# `recommend` + `algorithm-a-audit` — contrato de custo: ausente ≠ R$0, respeitando `cost_source`

> Spec/design. Money-path (ranking de recomendação + auditoria de margem). Follow-up sancionado da spec do cockpit (`2026-06-18-valor-cockpit-cost-final-contract-design.md` §"Fora de escopo").
> 2ª opinião: `/codex challenge` no diff final (adversarial money-path) — pendente.

## Problema

Dois edges tratam custo ausente como **R$0**, o que vira "margem cheia" (anti-padrão money-path: ausente ≠ zero, `docs/agent/money-path.md` §2):

1. **`recommend/index.ts:154`** — `const costFinal = cost?.cost_final || 0;` → `margin = price − 0 = preço cheio`.
   - `eip = probability × margin` é o sinal de ranking (peso `w_eip = 0.35`). Produto sem custo → **EIP máximo → rankeia no topo** (fantasma de lucro).
   - `margin` e `_admin.cost_final` são **exibidos como número firme** no `RecommendationCard` (linhas 81/120) e logados em `recommendation_log` (treino/medição). Custo `UNKNOWN`/sem-row aparece como "alto potencial de margem".
2. **`algorithm-a-audit/index.ts:132`** — `costMap[pc.product_id] = Number(pc.cost_final || 0);` (idem; e ignora `cost_source`, então **proxy entra como custo real** na auditoria).

### Escada de `cost_source` (writer `omie-analytics-sync` `reprocessRecommendationCosts`, linhas ~1004-1076)

| source | conf | `cost_final` | natureza |
|---|---|---|---|
| `PRODUCT_COST` | 0.95 | custo real (passa sanity) | **real** |
| `CMC` | 0.80/0.85 | cmc | **real** |
| `CMC` (via `syncInventory`, linha 848) | 0.70 | **0** (grava só `cost_price=cmc`) | **real, mas em `cost_price`** |
| `FAMILY_MARGIN_PROXY` | 0.50 | `price×(1−margem_família)` | **inventado** |
| `DEFAULT_PROXY` | 0.25 | `price×(1−margem_default)` | **inventado** |
| `UNKNOWN` | 0 | 0 | sem sinal |

`cost_price = existing?.cost_price || costFinal` → **sticky** (congela no 1º valor). Proxy tem `cost_final` **não-zero** (é estimativa). O `|| 0` morde em: linha sem row, `UNKNOWN`, e os 14 CMC com `cost_final=0 & cost_price>0`.

## Evidência de produção (psql-ro, 2026-06-18; recorte oben TTM, da spec do cockpit)

- 475 SKU: CMC 43% · DEFAULT_PROXY 22% · PRODUCT_COST 21% · FAMILY_MARGIN_PROXY 14% → **36% proxy inventado**.
- `cost_price>0 & cost_final=0`: **14** (todos CMC 0.70 do `syncInventory`) → exige fallback p/ `cost_price`.
- Concentração de receita: real 78,3% · proxy 16,4% · sem-custo 5,4%.

### Achado não-óbvio — a auditoria já é parcialmente robusta

`margin_gap` e `top_gap_products` são **cost-invariantes**:

```
gap = potentialMargin − realMargin
    = (bestPrice − cost)·qty − (actualPrice − cost)·qty
    = (bestPrice − actualPrice)·qty            ← o custo CANCELA
```

Logo o *headline* da auditoria (vazamento de preço) está correto mesmo com custo 0. O `|| 0` só distorce: (a) `gap_pct` (denominador `margin_potential` infla → gap% **subestimado**) e (b) `margin_real`/`margin_potential` absolutos (receita cheia como margem). Colunas `margin_audit_log.{margin_real,margin_potential,margin_gap,gap_pct}` são **nullable** → degradar p/ null **sem migration**.

## Decisão

Régua única de custo confiável (idêntica a `resolverCustoCockpit` do #959), separando **custo de margem** (exibido/logado, ausente→null) de **custo de ranking** (estimativa rotulada, sugestão do Codex `estimated_cost_for_ranking`). Auditoria: gap/gap% cost-free (robusto); margens absolutas só sob alta cobertura de custo.

### 1. Helper puro novo `src/lib/custos/cost-source.ts` (vitest), espelhado **verbatim** nos 2 edges

> **Não** edito `src/lib/financeiro/valor-cockpit-helpers.ts` (QUENTE — PR #959 DRAFT). Módulo novo, desacoplado. Régua de custo idêntica → 2 cópias TS temporárias; **resíduo:** pós-merge do #959, convergir `resolverCustoCockpit` → este módulo (fonte única). Edges Deno não importam de `src/` → espelho verbatim.

```ts
export type CostRow = { cost_price: number | null; cost_final: number | null; cost_source: string | null; cost_confidence: number | null };
const COST_SOURCES_REAIS = new Set(['PRODUCT_COST', 'CMC']);
const COST_SOURCES_PROXY = new Set(['FAMILY_MARGIN_PROXY', 'DEFAULT_PROXY']);
function finitePositive(x): x is number  // > 0, finito; rejeita ≤0/NaN/Infinity

// Custo de MARGEM (exibido/logado). Ausente ≠ fabricar margem.
//   1. source∈REAIS e finitePositive(cost_final)  → cost_final   (vivo, preferido)
//   2. source=CMC e finitePositive(cost_price)     → cost_price   (fallback dos 14 do syncInventory)
//   3. resto (PROXY/UNKNOWN/null/fonte nova)       → null
resolverCustoConfiavel(row: CostRow | null | undefined): number | null

// Custo de RANKING (só EIP/score; NUNCA exibido/logado como margem firme).
//   real (resolverCustoConfiavel) ?? proxy cost_final válido (source∈PROXY, finitePositive) ?? null
estimarCustoParaRanking(row: CostRow | null | undefined, price: number): number | null

// Split por candidato (recommend). Mantém o helper HONESTO (null); o motor aplica o neutro.
//   custoConfiavel/margemExibida → display/log; custoRanking/margemRanking → eip/eiltv.
//   margemExibida = custoConfiavel!=null ? price−custoConfiavel : null
//   margemRanking = custoRanking!=null   ? price−custoRanking   : null
derivarMargensCandidato(row, price): { custoConfiavel: number|null; custoRanking: number|null; margemExibida: number|null; margemRanking: number|null }
```

`source` normalizado (`trim().toUpperCase()`) p/ tolerar backfill. Fallback (passo 2) é **só CMC** — `PRODUCT_COST` com `cost_final` inválido NÃO cai p/ `cost_price` (o reprocess pode tê-lo rejeitado por sanity).

### 2. `recommend/index.ts` — split ranking vs exibição

- Substitui `cost?.cost_final || 0` por `derivarMargensCandidato(cost, price)`.
- **EIP/EILTV** usam `margemRanking ?? 0` → sem estimativa alguma o EIP é **neutro (0), não máximo** → o produto rankeia só por assoc/sim/ctx (nunca por margem-fantasma). `eiltv` idem (usa a mesma `margemRanking`).
- **Exibido/logado**: `Candidate.margin → number|null = margemExibida`; `_admin.cost_final = custoConfiavel` (number|null); novo `_admin.estimated_cost_for_ranking = custoRanking` (number|null, transparência). `cost_source` mantido (mostra PROXY/UNKNOWN).
- `recommendation_log`: `unit_cost = custoConfiavel`, `margin = margemExibida` (ambos nullable ✅). `eip` segue número.
- Branch de explicação de margem (linha ~195) gateado: `else if (margemExibida != null && margemExibida > 50)` — não afirma "alto potencial de margem" sobre null.
- `Candidate.cost_final`/`margin` → `number | null` na interface.

### 3. `algorithm-a-audit/index.ts` — gap cost-free + margens cobertura-gated

Núcleo extraído p/ helper puro **`src/lib/custos/auditoria-margem.ts`** (vitest; cost-invariância falsificável), espelhado verbatim no edge:

```ts
calcularAuditoriaMargemCliente(input: { orders: {product_id; unit_price; discount; quantity}[]; custoPorProduto: (id)=>number|null; bestPrice: (id)=>number|null })
  → { margin_real: number|null; margin_potential: number|null; margin_gap: number; gap_pct: number|null; top_gap_products: {product_id; gap}[]; cobertura_custo: number }
```

Por linha: `actualPrice = unit_price×(1−discount/100)`, `bestPrice = best ?? actualPrice`.
- **Sempre (cost-free):** `leak = (bestPrice − actualPrice)×qty` → `margin_gap += leak`; `bestRevenue += bestPrice×qty`; `receita += actualPrice×qty`; se `leak>0` push em `top_gap_products`.
- **Só com custo real** (`custo = resolverCustoConfiavel`): `marginRealKnown += (actualPrice−custo)×qty`; `marginPotentialKnown += (bestPrice−custo)×qty`; `receitaComCusto += actualPrice×qty`.

Agregado:
- `margin_gap` = Σ leak (cost-free, **sempre**). `top_gap_products` cost-free (inalterado).
- `gap_pct` = `bestRevenue>0 ? margin_gap/bestRevenue×100 : null` — **vazamento de receita %** (cost-free, undistorted).
- `cobertura_custo` = `receita>0 ? receitaComCusto/receita : 0`.
- `margin_real`/`margin_potential` = `cobertura_custo ≥ 0.85 ? round(known) : null` (espelha o gate do cockpit; ausente ≠ fabricar).

⚠️ **Mudança de semântica:** `gap_pct` deixa de ser "margem-gap %" e vira "vazamento de receita %". Coerente e mais honesto (o gap% atual é subestimado pelo custo fabricado). Linha com custo majoritariamente proxy mostra `— / — / R$X gap / Y% vazamento` (honesto: "não sei a margem absoluta, mas você está vazando R$X no preço").

### 4. Frontend honesto (`fmt` null-safe + "—")

- `src/components/RecommendationCard.tsx`: `fmt = (v: number|null|undefined) => v==null ? '—' : v.toLocaleString(...)` (hoje estoura em null). Linhas 81 (`margin`), 120 (`_admin.cost_final`), 85 (`eip`, segue número) cobertas.
- `src/hooks/useRecommendationEngine.ts`: `margin: number → number|null`; `_admin.cost_final: number → number|null`; novo `estimated_cost_for_ranking?: number|null`.
- `src/components/intelligence/IntelligenceStrategicTab.tsx` (184-187) e `src/pages/GovernanceAudit.tsx` (430-435): render "—" p/ `margin_real/potential/gap_pct` null (helper local `fmtBRL(v)`/`fmtPct(v)`). Somas (linhas 65-66) já usam `|| 0` → null é pulado (total parcial; aceitável p/ KPI). **Opcional:** renomear header "Gap %" → "Vazamento %" (alinha à nova semântica). Os 3 são leitura staff-only.

## Riscos residuais aceitos (registrados)

- **2 cópias TS da régua** (este módulo + `resolverCustoCockpit` do #959) até a convergência pós-merge. Lógica byte-idêntica; risco de divergência mitigado por vitest nos dois lados. Resíduo rastreado.
- **`gap_pct` muda de semântica** no painel de governança (margem%→vazamento%) — decidido pelo founder (2026-06-19). Sem migration; sem coluna nova.
- **EIP neutro (0) p/ custo desconhecido** pode sub-rankear um produto legítimo sem custo cadastrado. Aceito (precisão>recall: melhor não promover por margem-fantasma; o produto ainda surge por assoc/sim/ctx). O fix de fundo é cadastrar custo.
- **EIP/EILTV exibidos/logados degradam p/ null quando `margemExibida` é null** (Codex challenge #1 — resolvido) — eram R$ (lucro esperado) derivado de custo proxy. Só `score_eip` (score de ranking) e o `c.eip` interno (alimenta o min-max do `score_final`) seguem numéricos → **ranking inalterado**.
- **Somas `margin_real`/`potential` no Strategic são covered-only** (parcial sob baixa cobertura) — os cards disclosam "N/M clientes c/ custo" (Codex #8). O headline "Gap de Margem" = Σ`margin_gap` (cost-free; NÃO deriva de potential−real, senão sumiria em baixa cobertura — Codex #5). Tabela por-linha mostra "—".

## Fora de escopo

- Convergência `resolverCustoCockpit` → `cost-source.ts` (follow-up pós-merge #959).
- Coluna `cobertura_custo` persistida em `margin_audit_log` (YAGNI; o gate roda no edge, null comunica).
- Re-treino/recompute histórico do `recommendation_log` já gravado com margem fabricada (telemetria velha; novos eventos saem corretos).

## Prova & entrega

- **vitest** `src/lib/custos/__tests__/cost-source.test.ts` + `auditoria-margem.test.ts`:
  - `resolverCustoConfiavel`: todos os branches + **falsificação** (neg/NaN/Infinity/0; PROXY→null; CMC fallback; PRODUCT_COST inválido NÃO cai p/ cost_price; source com espaço/caixa).
  - `estimarCustoParaRanking`: real→real; sem-real+proxy→proxy cost_final; sem-real+sem-proxy→null; proxy inválido→null.
  - `derivarMargensCandidato`: margemExibida null + margemRanking via estimativa (caso UNKNOWN/proxy); ambos null sem sinal.
  - `calcularAuditoriaMargemCliente`: **cost-invariância** (mudar custo NÃO muda `margin_gap`/`top_gap`); `gap_pct` cost-free; gate de cobertura (proxy→null em margin_real/potential; real≥0.85→número); proxy não conta como real.
- **Paridade edge×src**: o bloco espelhado nos edges é byte-idêntico ao helper (revisão manual no diff; sem harness diferencial dedicado — YAGNI, é cópia verbatim de função pura).
- **`/codex challenge`** no diff final (adversarial money-path).
- `bun run typecheck` + `bun run lint` + `bun run test`.
- **Deploy MANUAL das 2 edges no chat do Lovable após merge** (merge ≠ produção; `recommend` + `algorithm-a-audit`). Frontend via Publish. Sem migration.

## Codex challenge — veredito (2 passes adversários, gpt-5.5 reasoning high, 8 achados, todos resolvidos)

**Pass 1** (diff inicial, 834k tok) → 5 achados, **todos REAIS** (testes não pegavam edge-cases de dado):
- **#1** `eip`/`eiltv` exibidos/logados eram R$ derivado de custo proxy → gateados p/ `null` qd `margin` null (`score_eip` + `c.eip` interno seguem numéricos; ranking intacto).
- **#2** `bestPrice ≤ 0` poisonava o gap (perdi o guard `|| actualPrice` ao trocar p/ `?? null`) → guard `bp>0` (fallback `actualPrice`).
- **#3** gate de cobertura instável com receita **sinalizada** (devolução/`discount>100` faziam cobertura passar de 1) → só linha de venda válida entra.
- **#4** `log_accept/reject` omitiam `unit_cost/margin` → DEFAULT 0 do schema fabricava R$0 → `null` explícito.
- **#5** KPI Strategic derivava gap de `potential−real` (sumia em baixa cobertura) → `Σ margin_gap` (cost-free).

**Pass 2** (confirmação, 232k tok) → os 5 **VERIFICADOS** + 3 refinamentos:
- **#6** ordem do `...extras` no `logEvent` (clobber teórico do null) → spread **antes** dos nulls (autoritativo).
- **#7** item **GRÁTIS** (`actualPrice 0`, qty>0) era dropado pelo `actualPrice>0` — é o **MAIOR** leakage (deu o best price inteiro) → guard exclui só preço **negativo** (`< 0`).
- **#8** cards Margem Real/Potencial/Global sem disclosure do parcial → subtitle "N/M clientes c/ custo".

**Falsificação:** cada fix de helper (#2/#3/#7) entrou por teste **vermelho→verde** (vitest 27/27). Sem Caminho B — Codex respondeu nos 2 passes (cota OK).
