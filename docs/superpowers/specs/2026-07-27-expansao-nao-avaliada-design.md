# Coluna sem produtor para de virar zero de decisão — a classe, não a instância

> Spec de 2026-07-27. Money-path (dirige a agenda do vendedor e o ranking da carteira).
> Origem: verificação pós-merge do #1561, fora do escopo daquele PR.

## 1. O sintoma que abriu o caso

A missão `expansao` desapareceu de `customer_visit_scores`:

```
primary_mission | count | min  | max
prospeccao      |  5408 | 70.0 | 90.0
recuperacao     |  1111 | 17.9 | 50.0
relacionamento  |   114 | 18.7 | 62.6
expansao        |     0
```

Antes do #1561 havia 169 clientes em `expansao` com `visit_score` fixo em 36,00 — fósseis
derivados de 303 linhas com `expansion_score = 60` gravadas por um writer despromovido em
maio/2026. O #1561 corretamente nulou essas colunas.

## 2. A decisão de produto: honestidade, não fallback

O relatório original propunha duas leituras — (a) o desfecho está certo e o conserto é de
honestidade, ou (b) o desfecho está errado e falta um fallback. **A medição decidiu.**

`revenue_potential` e `expansion_score` são `NULL` em **6.633/6.633** linhas, com
`column_default` vazio. E, decisivo:

```
priority_score_log — 494.699 linhas desde 2026-03-02
  margin_potential_component > 0:  0    (máx histórico: 0)
```

Zero em **todas** as linhas, desde o primeiro log. **Nunca houve produtor.** A opção (b) foi
escrita como "fallback enquanto não há produtor", mas não existe um "enquanto": um fallback aqui
não restaura sinal perdido, **inventa** um que nunca existiu — e já sabemos como isso se parece,
porque os 169 clientes em `expansao` com score 36,00 eram exatamente um fallback de facto,
ocupando vaga na agenda por um motivo inexistente.

Construir um produtor de expansão é decisão de produto legítima, mas é spec própria, não remendo,
e não entra disfarçada de fallback.

**Decisão: (a) honestidade.** O código passa a dizer "não avaliada" em vez de calcular 0 como se
tivesse medido.

## 3. Isto é uma CLASSE, não uma instância

Passo 0 do protocolo `matar-classe`: **classe**. Três red flags bateram — o fix é quase literal ao
`margemConhecida`; a série já existe no git log (#1495/#1498, #1565, #1567); e o
`revenue_potential` é um bug de <10 linhas que viveu **5 meses** em produção.

Prova de que o fix pontual não termina a fila: o #1565 (4 dias atrás) consertou
`churn_risk: s.churn_risk ?? 0` em `escopo-clientes.ts` e deixou `expansion_score: s.expansion_score ?? 0`
**na linha de baixo**, no mesmo `map.set`.

### 3.1 Assinatura (calibrada com controle pré/pós-fix)

```
(expansion_score|recover_score|revenue_potential|x_score|s_score|eff_score)[^,;)]*(\|\||\?\?)\s*0
```

Controle: casa `churn_risk ?? 0` em `d0a7854a^:src/lib/carteira/escopo-clientes.ts` e não casa em
`d0a7854a:` (o site que o #1565 corrigiu). Discrimina.

### 3.2 Regra de triagem (o que separa afetado de dormente)

A classe **não** é "todo `?? 0`". É "`?? 0` sobre coluna cuja ausência significa *não medido*".
Coluna com `column_default = 0` e zero NULLs → o `??` nunca dispara: defesa dormente **legítima**
(o caso `gross_margin_pct` pré-#1495). Pré-flight canônico do `money-path.md` §2, medido
2026-07-27:

| Coluna | NULLs | zeros | positivos | default | Veredito |
|---|---:|---:|---:|---|---|
| `expansion_score` | 6633 | 0 | 0 | — | **afetada** |
| `recover_score` | 6633 | 0 | 0 | — | **afetada** |
| `revenue_potential` | 6633 | 0 | 0 | — | **afetada** |
| `x_score` | 6633 | 0 | 0 | — | **afetada** |
| `s_score` | 6633 | 0 | 0 | — | **afetada** |
| `eff_score` | 6633 | 0 | 0 | — | afetada (sem consumidor) |
| `m_score` | 5564 | 11 | 1058 | — | afetada (sem consumidor) |
| `gross_margin_pct` | 5564 | 0 | 1059 | — | já erradicada (#1495/#1498) |
| `churn_risk` | 0 | 0 | 6633 | `0` | dormente |
| `health_score` | 0 | 5556 | 1077 | `0` | dormente |
| `priority_score` | 0 | 0 | 6633 | `0` | dormente |
| `category_count` | 0 | 5426 | 1207 | `0` | dormente |
| `avg_monthly_spend_180d` | 0 | 6217 | 416 | `0` | dormente |
| `avg_repurchase_interval` | 0 | 6334 | 299 | `0` | dormente |
| `g_score` | 0 | 5726 | 907 | `0` | dormente |
| `rf_score` | 0 | 6219 | 414 | `0` | dormente |

### 3.3 Varredura — 64 sites → 17 candidatos → 13 afetados

Repo inteiro (`src/`, `supabase/functions/`, `scripts/`), testes excluídos. Fecha a conta:
**47 falsos-positivos** (colunas dormentes) + **4 já-corretos** + **13 afetados** = 64. Os
já-corretos vão listados abaixo como prova de varredura completa, não de amostra.

**Afetados (13):**

| Site | Efeito medido |
|---|---|
| `visit-score-recalc-client/index.ts:228,230,231` | missão expansão sumiu (0 de 6.633) |
| `calculate-scores/index.ts:741,807` | 35% do `priority_score` constante desde março |
| `calculate-scores/index.ts:771,772` | 20% do `health_score` (`x_score`/`s_score`), sem a renormalização que a margem tem |
| `src/lib/scoring/agenda.ts:108` | `expansion > 50` nunca dispara → tipo de agenda `'expansao'` é código morto em prod |
| `src/lib/carteira/escopo-clientes.ts:190` | o irmão que o #1565 deixou passar |
| `src/hooks/useTacticalPlan.ts:432,433` | alimenta o texto do plano de IA |
| `supabase/functions/tactical-plans-batch/index.ts:159` | idem, no batch |
| `src/lib/positivacao/ranking.ts:8` | desempate por potencial inerte (degrada p/ churn) |

**Já-corretos (4 sites) — `|| 0` presente, guard a jusante:**

- `IntelligenceStrategicTab.tsx:108,110,111` → `concentracaoIndisponivel` (linha 117) exibe "—".
- `useTacticalPlan.ts:366` → `revPotential > 0 ? revPotential : avgSpend`, e o resultado ainda
  passa pelo gate de `margemConhecida` (null → R$/h indecidível).

## 4. Desenho

### 4.1 Helper — `potencialConhecido`

Quarto irmão de `margemConhecida` (`src/lib/scoring/margin.ts`) e `churnConhecido`
(`src/lib/scoring/churn.ts`), com a mesma semântica: `0` é CONHECIDO (veredito medido), só
`null`/`undefined`/`NaN`/`Infinity` são ausência.

```ts
export function potencialConhecido(raw: unknown): number | null
```

Espelhado nas edges (Deno não importa de `src/`), com bloco `// MIRROR-START potencial-conhecido`
para o guard textual de `src/__tests__/edge-money-path-invariants.test.ts` pegar reescrita do
Lovable no deploy.

### 4.2 Tipos

`CustomerScoreInputs` (`src/lib/visit-scoring/types.ts` **e** o inline da edge) passa
`expansion_score`, `revenue_potential` e `recover_score` para `number | null`. O tipo hoje mente:
declara `number` sobre coluna que é NULL em 100% das linhas.

⚠️ **Hazard JS obrigatório** (`money-path.md` §2, corolário): tornar campo `number | null` pode
**introduzir** fabricação em comparação relacional — `null <= 0` é `true`, `null > 50` é `false`.
`normalizeRevenue` (`helpers.ts:20`) faz `if (value <= 0) return 0` e engoliria o null em silêncio.
Toda comparação relacional ganha guard explícito, com teste dedicado.

### 4.3 Missões — expansão fail-closed, recuperação parcial

**Assimetria decidida com o founder, e ela é o núcleo do desenho.**

- **`scoreExpansao` → `number | null`.** Todos os insumos medidos são ausentes; o que sobra é o
  `signalsBoost`, que nunca supera o piso 70 da prospecção. A missão já não vence hoje — devolver
  `null` só torna explícito o que a aritmética já faz, **sem mudar comportamento**.
- **`scoreRecuperacao` continua devolvendo número, marcado como parcial.** Diferente da expansão,
  a recuperação **ainda entrega 1.111 clientes à agenda**, porque `churnBoost` a sustenta sozinho.
  Fail-closed aqui tiraria 1.111 clientes da agenda dos vendedores de uma vez, sem produtor pra
  repor — mudança de comportamento que a decisão (a) não autoriza.

  O "parcial" é **dado estruturado, não prosa**: `score_breakdown.insumos_ausentes` (array de
  nomes de coluna, já gravado pela edge no upsert de `customer_visit_scores`) passa a listar
  `recover_score` quando ele for null. Escolhido em vez de um booleano porque nomeia *qual* insumo
  faltou — quando um produtor nascer, o array esvazia sozinho e nada precisa ser desligado à mão.
  A tela lê dali para dizer "recuperação — insumo incompleto".

  ⚠️ **Invariante conferida antes de escolher o jsonb** (CLAUDE.md: sinal money-path nunca em jsonb
  multi-writer, porque o upsert é destrutivo). `score_breakdown` tem **exatamente um writer** —
  `visit-score-recalc-client/index.ts:247,282` — e o upsert reescreve o objeto inteiro a cada run,
  então não há merge parcial a perder. Ressalva registrada: as policies `cvs_insert_own_or_gestor` /
  `cvs_update_own_or_gestor` *permitem* escrita de farmer/gestor via PostgREST; hoje nenhum código
  exerce esse caminho, mas se algum dia exercer, o sinal migra para coluna dedicada.

`computeVisitScore` ignora missão `null` no argmax (não a trata como 0, que empataria com o piso).
`MissionScores` vira `Record<MissionType, number | null>`.

### 4.4 Tela

`VisitSuggestionsCard` mostra "Expansão: não avaliada" em vez de "Expansão: 0". Distinguir
"ninguém qualifica" de "não temos o dado" é metade do motivo de (a) existir.

### 4.5 Gate (passo 4 — sem ele a classe reincide)

`src/lib/scoring/colunas-sem-produtor.ts`: registro declarado das colunas sem produtor, com a
medição e a data que a justificam. Um vitest **lê a fonte** (`readFileSync`, padrão já usado em
`edge-parse-parity.test.ts` — funciona para código Deno que o vitest não executa) e falha em
`<coluna> ?? 0` / `|| 0` em `src/` e `supabase/functions/`.

O registro é a peça durável: quando um produtor nascer, sai dali com a medição nova, e o gate
libera os sites daquela coluna — a lista documenta *por que* cada coluna está lá.

**Falsificação obrigatória:** reintroduzir `expansion_score ?? 0` num arquivo e exigir vermelho —
com **total de testes fixado e conferido** (`money-path.md`: em suíte JS o discriminador de "não
rodou nada" é o DENOMINADOR), sabotagem provando que aplicou (`grep -q` do texto sabotado) antes
de rodar, e âncora **ASCII** no padrão.

## 5. Plano de PRs

Três PRs, decisão do founder por bisseção limpa e blast radius separado.

**PR 1 — visit-scoring (a instância que abriu o caso).**
`types.ts`, `missions.ts`, `helpers.ts`, `escopo-clientes.ts`, `agenda.ts`, `ranking.ts`,
`useTacticalPlan.ts`, `VisitSuggestionsCard.tsx` + edges `visit-score-recalc-client` e
`tactical-plans-batch`. Inclui o helper, o gate e a falsificação.

**PR 2 — `calculate-scores` (pré-existente, não é regressão do #1561).**
`revenue_potential` (35% do `priority_score`) **e** `x_score`/`s_score` (20% do `health_score`),
juntos: mesma função, mesmo defeito, e a margem já tem a renormalização ao lado desde o #1498 —
deixar metade consertada na MESMA função é o meio-conserto do `money-path.md` §7. Renormaliza o
peso ausente entre os componentes existentes, espelhando `calculate-scores:656-678`.

Baseline obrigatório **antes** do apply (`money-path.md`): `priority_score` e `health_score` de
toda a base, mais `priority_score_log`, medidos dos dois lados — o que a mudança altera e o que
ela deve deixar intacto.

**PR 3 — documentação.** Registro da classe em `docs/agent/money-path.md` (assinatura + onde vive
o gate) e o resíduo histórico em `docs/historico/`.

### Paridade obrigatória

`src/lib/visit-scoring/missions.ts` e o inline de `visit-score-recalc-client/index.ts` são lógica
DUPLICADA (Deno não importa de `src/`). Toda mudança entra nos dois e prova paridade — bloco
`MIRROR` + o teste textual existente.

## 6. Restrições de entrega

- **Edges são deploy MANUAL** pelo chat do Lovable, verbatim da main (`docs/agent/deploy.md`).
  Merge na main **não** publica. Três edges tocadas: `visit-score-recalc-client`,
  `tactical-plans-batch`, `calculate-scores`.
- Após o merge, conferir `git log -S` dos símbolos novos: o sync bidirecional do Lovable já
  reverteu wiring de edge 4h depois de um merge (#1445→#1478), e aconteceu de novo neste repo em
  #1586.
- `bun run test:edges` roda com `--no-remote`: teste de edge não pode ter import remoto.
- Arquivo novo em `src/` precisa de dono em `src/lib/modulos/manifesto.ts` (`src/lib/scoring/**`
  já é coberto — o helper novo cai dentro, o teste do gate precisa de verificação).
- Money-path: vitest + falsificação com baseline verde explícito e contagem de vermelhos conferida.

## 7. Fora de escopo (declarado)

- **Produtor de expansão.** Decidido: é spec própria. Esta entrega torna a ausência legível, não a
  preenche.
- **Resíduo histórico.** ~42 planos em `farmer_tactical_plans` anteriores a 2026-07-23 10:45 UTC
  carregam `expansion_potential = 60` do fóssil, com texto de IA por cima. Decisão do founder:
  **deixar, com nota em `docs/historico/`** — são anteriores à migration, não contaminam nada novo,
  e apagar plano que o vendedor pode já ter lido é destrutivo sem ganho claro.
- **`health_avg = 4,0` / 93% da base em `critico`.** Medido nesta investigação e **não
  diagnosticado**. Os 20% mortos de `x_score`/`s_score` não explicam isso sozinhos (a aritmética não
  fecha), e boa parte da base são os ~6.9k aliases fiscais sem histórico de compra, para quem health
  baixo é legítimo. Fio solto que merece investigação própria — registrado aqui para não se perder,
  explicitamente **não** afirmado como consequência desta classe.
- **`eff_score` e `m_score`.** Afetadas pela assinatura, sem nenhum consumidor hoje. Entram no
  registro do gate (defesa do futuro), sem mudança de código.
