# Spec — `cost_source` "unidade suspeita": separar descasamento-de-unidade de margem-atípica real

- **Data:** 2026-06-22
- **Status:** DECIDIDO (Codex + Claude convergentes, 2026-06-22 · founder aprovou gravar) — pronto pra implementar · money-path
- **Relacionado:** PR #988 (`CMC_MARGEM_ATIPICA`); `docs/historico/bugs-resolvidos.md` (2026-06-22); `docs/agent/money-path.md`, `docs/agent/reposicao.md` (escada cmc-first)
- **Arquivos no alvo (decorator pós-escada — `costLadder.ts` fica INTACTO):** `src/lib/custo/costCompute.ts` (+ espelho `supabase/functions/_shared/cost-compute.ts`), `src/lib/custos/cost-source.ts` (nova fonte + `estimarCustoParaRanking`), edges `omie-analytics-sync` / `recommend` / `algorithm-a-audit` (adicionar `unidade`+`descricao` ao select)

## 1. Problema

`computeCostLadder` compara `cmc` e `price` **assumindo a mesma unidade**. O #988 criou `CMC_MARGEM_ATIPICA` para tornar observável o CMC real fora da banda de margem (prejuízo / margem-alta) em vez de mascará-lo com proxy.

A auditoria pós-#988 mostrou que **parte** dos `CMC_MARGEM_ATIPICA` **não é margem atípica real — é descasamento de unidade**: o `cmc` está numa unidade (m², m, kg, L) e o `price` (`valor_unitario`) em outra. Comparar os dois cospe uma "margem" sem sentido.

O sinal hoje mistura dois fenômenos com ações opostas:
- **Margem atípica real** → ação comercial (reprecificar / renegociar).
- **Descasamento de unidade** → ação de dado (reconciliar UoM / apropriar custo no Omie).

Tratá-los igual dilui o valor do sinal honesto que o #988 criou.

## 2. Evidência (psql-ro, 2026-06-22)

Família **Jumbo/Rolo de Lixa (Óxido de Alumínio), Colacor, unidade = M²** — 40 SKUs, margem média "87%":

| Sintoma | Dado |
|---|---|
| `saldo` fracionário batendo com área | `JUMBO KA169 1410X50000MM` → saldo **70.5** = 1,41m × 50m = **70,5 m²** (1 jumbo) |
| `cmc` é por m², não por peça | cmc ≈ R$31/m² → custo real do jumbo = 70,5 × 31 ≈ **R$2.189** |
| `price` desconectado da unidade | `valor_unitario` ≈ **R$198–262 constante** para áreas de **1,2 a 700 m²** |

Achados colaterais (já úteis ao founder, fora do escopo do motor):
- **PRD03254** `14000X50000MM` → área 700 m² (largura 14000mm provável **erro de digitação** de 1400mm).
- **PRD03977** cmc **R$218/m²** = 7× os pares (~R$31) → **CMC outlier** lançado errado.
- **PRD02660 / PRD02662** (`ROLO BTT`) unidade M² **sem dimensão na descrição** → exigem tratamento manual.

Distribuição dos 93 margem-alta por unidade × empresa: **40 M² colacor** (descasamento), **39 UN colacor** (custo de produção não apropriado — `cmc` médio R$5,69), **12 UN oben** (revenda desatualizada), **2 L**.

## 3. Objetivo

Distinguir, no `cost_source`, **"CMC implausível por descasamento de unidade"** de **"CMC real que implica margem atípica"**. Precisão > recall (money-path): só marcar unidade-suspeita com sinal forte; **nunca** rebaixar um CMC genuinamente comparável (ex.: líquido custeado E vendido por litro).

## 4. Proposta

### 4.1 Sinal
Novo `cost_source = 'CMC_UNIDADE_SUSPEITA'` (decidido: **não** flag — §5/D1). `cost_confidence` **herda do proxy** que vai pra `cost_final` (0.5 família / 0.25 default), **não** um 0.40 fixo (§5/D5). **Preserva o `cmc` cru** em `product_costs.cmc` (nunca fabrica número); `cost_price = null`.

### 4.2 Detecção (gatilho batido — §5/D2)
Sinais:
- **H1** `unidade` geométrica `∈ {M2, M, MT, CM, CM2}` (1ª versão — **KG/L/G/ML ficam de fora**, §5/D4).
- **H2** `saldo` fracionário (`saldo <> round(saldo)`) — fraco isolado p/ KG/L (fracionário é normal lá); só reforço.
- **H3** dimensão na descrição (`([0-9]+) *[Xx] *([0-9]+) *MM`) cuja área ≫ 1 → custo é por sub-unidade. **Sinal forte p/ M².**
- **H4** a escada já retornou `CMC_MARGEM_ATIPICA` (margem fora da banda).

**Gatilho:** `H4 (==CMC_MARGEM_ATIPICA) ∧ H1 ∧ H3`. `H1 ∧ H4` sozinho é **candidato**, não condenação (largo demais — Codex). `H2` entra só como reforço quando a família fizer sentido.

### 4.3 Arquitetura: DECORATOR pós-escada (§5 — escada intacta)
`computeCostLadder` fica **intacto** (`{ price, cmc, familyTargetMargin, cfg }`) — a suspeita de unidade é **contexto de produto**, não proveniência de número, então **não** entra na função pura da escada. A detecção vira um passo em `montarUpsertsDeCusto` (`costCompute.ts`), **logo depois** de a escada retornar `CMC_MARGEM_ATIPICA`:
- `ProdutoCusto` (`costCompute.ts:21`) hoje **não** tem `unidade`/`saldo`/`descricao` → **adicionar** (e o select dos 3 edges + espelho Deno `cost-compute.ts`).
- `costLadder.ts` / `_shared/cost-ladder.ts`: **não muda** → a paridade da escada não é tocada (só a do `cost-compute`).
- `cost-source.ts`: rótulo/cor da nova fonte **+** alterar conscientemente `estimarCustoParaRanking` (`cost-source.ts:42`, hoje retorna `null` p/ fonte desconhecida) e os conjuntos `COST_SOURCES_*`.

### 4.4 Comportamento downstream (decidido — §5/D3)
Diferente do `CMC_MARGEM_ATIPICA` (que **propaga** o cmc como custo real — prejuízo é real), o `CMC_UNIDADE_SUSPEITA` **não propaga** o cmc (a unidade não bate). Persiste:
- `cost_source = 'CMC_UNIDADE_SUSPEITA'` · `cmc` = **cru preservado** · `cost_price` = **null** (≠ #988, que grava `cost_price=cmc`) · `cost_final` = **proxy de família** · `cost_confidence` = a do proxy.
- A fonte **fica fora de `COST_SOURCES_REAIS`** e entra no conjunto "proxy para ranking" (o `cost_final` É proxy). `cost_final` segue `number` (não `null`) — não alarga a superfície de tipos.

## 5. Decisões batidas (Codex + Claude convergentes, 2026-06-22)

> 2ª/3ª opinião: `/codex consult` (gstack) + análise do Claude. Convergiram em 4 das 5; em D1 o Claude cedeu ao Codex.

- **D1 — `cost_source` novo, NÃO flag.** O downstream decide "real vs proxy vs null" **por `cost_source`** (`cost-source.ts:16`, `COST_SOURCES_REAIS`). Um flag paralelo é frágil: um consumidor esquece de checá-lo → trata o CMC incomparável como real (exatamente o erro money-path). O `cost_source` é **fail-safe**. Flag só como metadado futuro.
- **D2 — gatilho estreito** `H4 (==CMC_MARGEM_ATIPICA) ∧ H1 (geométrica) ∧ H3 (dimensão)`. `H1∧H4` é largo demais (candidato, não condenação). `H2` é fraco p/ KG/L.
- **D3 — degradar a proxy, preservar cmc cru, `cost_price = null`** (§4.4). `cost_final = null` está **fora** (alargaria o tipo `UpsertCusto.cost_final: number`).
- **D4 — começar estreito:** só `M2/M/MT/CM/CM2` exigindo H3. **Cortar `KG/L/G/ML`** da 1ª versão (falso-positivo do líquido custeado+vendido por litro = mascarar prejuízo real).
- **D5 — confiança herda do proxy** (0.5 família / 0.25 default), não 0.40 fixo. Um único `cost_confidence` = confiança do **número** em `cost_final`, não do rótulo.

**Dois detalhes que o Codex pegou (entram na implementação):**
1. `cost_price = null` no atípico de unidade (≠ #988) — o cmc cru não é comparável ao price.
2. `estimarCustoParaRanking` (`cost-source.ts:42`) hoje retorna `null` p/ fonte desconhecida → **alterar conscientemente** ao registrar a fonte nova.

## 6. Verificação (na implementação)

- **TDD + falsificação** (vitest, como `costLadder.test.ts`; `prove-sql-money-path` **não** aplica — é TS puro).
- **Paridade byte-a-byte** `costCompute.ts ↔ _shared/cost-compute.ts` (a escada `costLadder.ts` **não** muda — sua paridade não é tocada).
- Casos-chave: jumbo M² com dimensão na descrição → `CMC_UNIDADE_SUSPEITA`; produto UN com prejuízo real → **continua** `CMC_MARGEM_ATIPICA` (não confundir); líquido (L) custeado+vendido por litro com margem alta → **não** marcar (falso-positivo a evitar — KG/L fora da 1ª versão); M² em prejuízo real por m² → **não** marcar como suspeita (não re-mascarar).
- `typecheck` strict 0 · `deno check` edges 0 · suíte completa.
- **Deploy manual** pós-merge (3 edges + Publish) + **recompute** `compute_costs` — idêntico ao #988 (`docs/agent/deploy.md`).

## 7. Riscos

- **Falso-positivo** (money-path): marcar unidade-suspeita um CMC comparável → some o sinal de prejuízo real. Mitiga: exigir `H4` (margem atípica) + validar amostra.
- **Superfície**: decorator em `costCompute.ts` (+espelho) + `cost-source.ts` + select dos 3 edges — **menor** que o #988 (a escada `costLadder.ts` fica intacta), mas ainda toca os 3 edges (deploy manual) + `ProdutoCusto` ganha `unidade`/`descricao`.
- **Não corrige a causa** (custo errado / UoM no Omie) — é sinalização honesta, não correção. A correção é no Omie (apropriar custo de produção / reconciliar unidade).

## 8. Não-objetivos

- Corrigir o custo no Omie (é processo do founder).
- Custeio de produção dentro do Afiação (o ERP é a fonte de verdade de custo).
- Parsear dimensão da descrição para *calcular* custo automaticamente (frágil; serve só como sinal H3).
