# A leitura da margem nasce fechada no frontend

> 2026-07-21 · money-path · fecha o consumidor de `farmer_client_scores.gross_margin_pct`
> Terceiro PR de um programa de três. Produtor: #1495. Consumidor edge: #1498. **Este: consumidor frontend.**

## 1. Por que existe

O #1495 conserta a coluna morta: `gross_margin_pct` sai de `0` para todos e passa a ser calculada
no servidor por `get_customer_margin_summary()`, em **escala 0–100** (`*100` no SQL; média medida
em prod 53,47%, p50 56,39%, faixa −143,22% a 88,33%), com **`NULL` honesto** para os 162 clientes
sem custo conhecido.

O #1498 fecha os consumidores de **edge**. Ninguém fechou os de **frontend** — e é lá que mora a
inconsistência de escala que hoje está mascarada porque tudo vale zero:

- **Escala.** [Customer360View.tsx:194](../../../src/components/adminCustomers/Customer360View.tsx)
  faz `gross_margin_pct * 100` e [CustomerHero.tsx:141](../../../src/components/customer360/CustomerHero.tsx)
  compara `>= 0.3` — ambos tratam a coluna como **fração**. Com 53,47 o primeiro exibe **"5347.0%"**
  e o segundo pinta **verde para todo mundo** de 0,3% a 88%.
- **`ausente ≠ zero`.** Seis pontos fazem `|| 0` / `?? 0`, o que **refabrica** exatamente o zero que
  o #1495 acabou de remover. Nas duas médias do Intelligence, os 162 ausentes entram como `0` e
  puxam o KPI para baixo.

O risco não é temporal — os dois PRs estão draft. É de **ordem**: este PR é **inerte hoje**
(coluna toda `0` e não-nula ⇒ `??` nunca dispara, e normalizar `0` dá `0`), então mergeia primeiro
e fecha a porta antes de o #1495 abrir a torneira.

## 2. Desenho: mecânica na plataforma, política no negócio

A regra de fronteira do CI ([fronteiras.ts:66](../../../src/lib/modulos/fronteiras.ts)) só isenta
imports de módulos `plataforma`. Sete consumidores vivem em `farmer-inteligencia`; o do "5347.0%"
(`Customer360View`) vive em `admin-crm`. Um helper único no negócio faria esse import virar aresta
nova ⇒ CI vermelho. A partição não é contorno — é a distinção correta:

| Camada | Onde | Contrato |
|---|---|---|
| **Mecânica** — fato do schema | `src/lib/format.ts` (plataforma, arquivo existente) | `lerMargemPct(v): number \| null` · `formatarMargemPct(v): string` |
| **Política** — regra de negócio | `src/lib/scoring/margem.ts` (farmer-inteligencia, novo) | `tomMargem(v)` · `mediaMargem(scores)` |

"A coluna vem em 0–100 e ausente é `null`" é fato do contrato de dados — mesma categoria de
`src/lib/postgrest.ts`, que já mora na plataforma encapsulando armadilhas. "30% é boa margem" é
política e fica no negócio.

### 2.1 `formatPctMaybe` NÃO morre

A heurística `v > 1 ? v : v * 100` de [format.ts:14](../../../src/components/customer360/format.ts)
é ambígua (margem real de 0,8% vira 80%), mas o helper serve **outros quatro consumidores** com
semântica de escala legitimamente ambígua — `taxaConversao` em `VisitasKpiTiles`/`CustomerVisitsTab`,
`b.pct` em `MinhasVisitasResultadoCard`, `Math.abs(v)` em `TeamKpiTiles`. Substituí-lo quebraria
essas telas.

`formatarMargemPct` nasce **ao lado**, com escala **conhecida** (0–100, sem adivinhação). Só o
call-site de margem (`CustomerHero:149`) troca de helper.

### 2.2 Contratos

```ts
// src/lib/format.ts — plataforma
/** Escala SEMPRE 0–100 (fonte: get_customer_margin_summary, que já multiplica por 100).
 *  Ausente ≠ zero: null/undefined/NaN → null, JAMAIS 0. Negativo é dado real e passa. */
export function lerMargemPct(v: unknown): number | null;
/** "53%" · "−12,3%" · "—" para ausente. Sem heurística de escala. */
export function formatarMargemPct(v: unknown): string;

// src/lib/scoring/margem.ts — farmer-inteligencia
export function tomMargem(v: unknown): 'success' | 'warning' | 'error' | 'neutral';
/** Média SÓ sobre margens conhecidas + contagem exposta (no silent caps). */
export function mediaMargem(vs: unknown[]): { media: number | null; conhecidas: number; total: number };
```

`mediaMargem` devolve a contagem porque o CLAUDE.md proíbe truncar silencioso: a tela precisa poder
dizer "53,5% · 1.052 de 1.214", não um número que finge cobrir todo mundo.

## 3. Call-sites

| Arquivo | Hoje | Depois |
|---|---|---|
| `adminCustomers/Customer360View.tsx:194` | `* 100` → "5347.0%" | `formatarMargemPct()` |
| `customer360/CustomerHero.tsx:141,149` | `>= 0.3` cru; cor ≠ texto | `tomMargem()` + `formatarMargemPct()` |
| `lib/carteira/escopo-clientes.ts:187` | `?? 0` refabrica | `lerMargemPct()` |
| `hooks/useTacticalPlan.ts:338,390` | `\|\| 0` | `null` ⇒ gate indecidível (espelha #1498) |
| `hooks/useBundleEngine.ts:551` | `\|\| 0` ⇒ vira `sensivel_preco` | `null` ⇒ sem rótulo fabricado |
| `intelligence/IntelligenceManagerialTab.tsx:70` | soma `\|\| 0` ÷ `length` | `mediaMargem()` + contagem |
| `intelligence/IntelligenceStrategicTab.tsx:108` | idem | idem |
| `farmer/copilot/useFarmerCopilot.ts:111` | cru pro prompt da IA | escala rotulada; ausente omitido |

**Type lie:** [adminCustomers/types.ts:43](../../../src/components/adminCustomers/types.ts) declara
`gross_margin_pct: number` (não-nullable). Sem corrigir para `number | null`, o TS impede o `null`
honesto de chegar.

**Escalas que já estão certas** e ficam como estão: `useFarmerScoring.ts:410`
(`clientMargin * 1000 / 10` = 0–100), `classifyCustomerProfile` (`< 20` / `> 35`),
`useTacticalPlan.ts:339` (`marginPct / 100`).

### 3.1 Thresholds: tradução literal, calibração é follow-up

`0.3`/`0.15` viram `30`/`15`. Decisão do founder (2026-07-21): traduzir literal agora e **não**
embutir decisão de produto nova num PR de conserto técnico. Com p50 = 56,39% a maioria vai pintar
verde e o gradiente ficará pouco informativo — **follow-up de calibração** fica registrado, para ser
decidido vendo a distribuição real na tela.

### 3.2 Capa de 1.000 no cluster de pares (incluído)

[useTacticalPlan.ts:406](../../../src/hooks/useTacticalPlan.ts) monta o cluster com
`.select('gross_margin_pct').eq('farmer_id', ownerId).neq(...)` — **sem `.range()` e sem `.order()`**.
Os farmers em prod têm até 3.858 clientes ⇒ a régua sai de ~26% da carteira, em ordem indefinida.

É o mesmo bug que o #1498 corrigiu na edge, aqui no frontend, e é money-path (o cluster decide o
objetivo estratégico via `selectObjective`). `coletarEmLotes` já existe em `escopo-clientes.ts`.
O guard de peers em si já está correto (filtra `!= null`, exige ≥1 par, sem par → `null`) — só a
paginação falta.

## 4. Prova

Helpers puros ⇒ vitest direto, sem mock de Supabase.

**Casos que separam certo de errado** (um assert "não é nulo" passaria em todos os errados):

| caso | entrada | esperado | o que pega |
|---|---|---|---|
| escala | `53.47` | `"53%"` | o `* 100` → "5347.0%" |
| fronteira | `0.8` | `"0,8%"` | a heurística `v > 1` → "80%" |
| ausente | `null` | `null` / `"—"` | o `\|\| 0` → `0` |
| negativo | `-143.22` | `-143.22` | clamp indevido |
| média | `[50, null, 100]` | `75`, 2 de 3 | `\|\| 0` → `50` sobre 3 |

**Falsificação obrigatória** (CLAUDE.md: sabotar e exigir vermelho, em `LC_ALL=C` e `pt_BR.UTF-8`):
`lerMargemPct` devolvendo `0` no ausente · `formatarMargemPct` reintroduzindo `v > 1` ·
`mediaMargem` dividindo por `total` em vez de `conhecidas`.

Gates: `heavy bun run test` · `heavy bun run typecheck` · `bun lint` · `manifesto.gate`
(`src/lib/scoring/margem.ts` precisa de dono) · `fronteiras.gate` (nenhuma aresta nova).

## 5. Deploy

**Frontend puro** ⇒ só **Publish** no editor do Lovable. Sem migration, sem edge.

Ordem do programa: **este PR** → #1495 (migration + edge `calculate-scores`) → #1498 (2 edges).
Este é inerte até o #1495 landar, então pode mergear a qualquer momento antes.

## 6. Fora de escopo

- Calibrar os thresholds pela distribuição real (§3.1) — follow-up.
- A mesma heurística `v > 1` em `churnTone` ([format.ts:121](../../../src/components/customer360/format.ts)) —
  `churn_risk` é outra coluna, com sua própria pergunta de escala. Não medida aqui.
- Dropar a coluna: descartado. O #1495 já a popula com prova.
