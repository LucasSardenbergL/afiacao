# Candidatos `.tsx` à promoção strict — triagem validada (2026-05-27)

> ## ✅ Status de execução (2026-05-27) — Lote A + B ENTREGUES
>
> - **Lote A (119 mecânicos)** → promovidos no PR **#410** (539→658).
> - **Lote B (12 com fix)** → PRs **#414** (11: dead-code + 1 guard, 658→669) + **#417**
>   (o 12º, zodResolver do `StandardProcessForm` + irmão `AdminStandardProcessNew`, 669→671).
> - **Strict agora ~671/853 (~79%).**
>
> **O que resta** (re-rode `bun scripts/strict-tsx-triage.mjs` p/ números frescos): os **NEAR (~83)**
> e **RISKY (~51)**. Vários NEAR estão em **lanes quentes farmer/scoring/financeiro** — promover ali
> exige **coordenar com sessões paralelas ativas** (decisão eu+Codex: parar antes de entrar nelas).
> O caminho dos NEAR é promover o blocker (`./types.ts`/`./config.ts`/`useX.ts` leaf) **no mesmo lote**.
>
> ---

> Artefato **read-only** para ser consumido numa **janela calma** (sem PRs em voo / CPU calma),
> conforme a disciplina do `docs/strict-migration-lanes.md` e o handoff do CLAUDE.md §10
> ("strict-mode: só em janela sem PRs em voo, leaf-first, sem reordenar o include").
>
> Gerado por `bun scripts/strict-tsx-triage.mjs` (filtro correto: casa aspas duplas+simples,
> exclui `lazy()`/`import()` dinâmico) e **validado** anexando os 131 READY ao `include` e
> rodando `heavy bun run typecheck:strict`. O tsconfig **não** foi commitado — só este relatório
> e o script. Re-rode o script quando o strict crescer (os números mudam).

## Estado na geração

- strict atual: **539** arquivos no `include` (~63% de 853 `.ts/.tsx`).
- `.tsx` fora do strict: **303**.
- Classificação dos 303: **READY=131, NEAR=83, RISKY=51, LAZY=10**.

## Veredito da validação (typecheck:strict com os 131 READY anexados)

Todos os erros caíram **dentro** do conjunto READY (zero erro transitivo fora — confirma que o
resolvedor de deps do filtro está correto: READY não puxa nenhum arquivo novo pro programa).

- **119 dos 131 compilam LIMPO** sob strict → **promoção mecânica** (append-only no `include`,
  zero edição de source). Lote pronto.
- **12 precisam de fix de source** antes de promover (detalhe abaixo).

### Lote A — 119 mecânicos (zero edição de source)

Append-only no fim do `include` do `tsconfig.strict.json`, rodar `heavy bun run typecheck:strict`
(deve seguir verde), commitar. Pegue a lista exata com:

```bash
bun scripts/strict-tsx-triage.mjs --ready   # 131 READY; tire os 12 da lista B = 119 mecânicos
```

Distribuição por área (todos leaf presentacionais, deps já no strict):
`reposicao/*` (~45), `farmer/{copilot,bundles,locc,tacticalPlan}` (~8), `des/{historico,checkinQualitativo,simulador}` (~10),
`notificacoes` (5), `loyalty` (5), `customerDashboard` (5), `unifiedAI` (4), `skuMapeamento` (4),
`tintColorSelect` (3), `salesOrderEdit` (3), `financeiro/cockpit` (3), `call`/`telefonia` (5),
`analyticsSync`/`customer`/`adminCustomers`/`picking`/`dashboard`/`salesOrders` + `VoiceServiceInput`.

> Sugestão de fatiamento (evita um PR gigante): por área-pai (`reposicao/*`, `farmer/*`, `des/*`, …),
> ~4-6 PRs pequenos, cada um append-only. NÃO reordene o array `include` (reordenar = conflito com
> todo PR em voo).

### Lote B — 12 precisam de fix de source

**B1 — dead-code only (10 arquivos; fix trivial = apagar import/var não usado, depois promover):**

| Arquivo | Erros |
|---|---|
| `pages/FarmerRecommendations.tsx` | 11× TS6133/6192 (imports `TrendingUp/Package/Sparkles/CardHeader/CardTitle/CustomerRecommendations/Recommendation`, vars `isAdmin/activeTab/setActiveTab`, 1 import inteiro não usado) |
| `pages/CoachingSPIN.tsx` | 11× TS6133 (`ScrollArea/Filter/ArrowRight/Eye/EyeOff/FileText/Mic/Play/Zap/Button/Textarea`) |
| `components/unified-order/CartSummaryBar.tsx` | 9× TS6133 (`isWeekend/fmt/Badge` + vars `cart/totalEstimated/notes/setNotes/volumesColacor/volumesOben`) |
| `pages/UXRules.tsx` | 5× TS6133 (`RefreshCw/BarChart3/MessageSquare/Phone/HelpCircle`) |
| `pages/DesignSystem.tsx` | 5× TS6133 (`ChevronRight/Eye/EyeOff/X/Package`) |
| `components/SharpeningSuggestions.tsx` | 4× TS6133 (`ChevronRight/formatDistanceToNow/ptBR` + var `ref`) |
| `pages/FarmerIPFDashboard.tsx` | 2× TS6133 (`useState/Users`) |
| `components/unified-order/ProductItemForm.tsx` | 2× TS6133 (`useCallback/useRef`) |
| `components/recebimento/LoteScannerOCR.tsx` | 1× TS6133 (`React` — import default não usado) |
| `components/aiOps/DecisionCard.tsx` | 1× TS6133 (prop `customerPhone` declarada e não usada) |

> ⚠️ Em `DecisionCard` e `CartSummaryBar`, alguns "não usados" são **props/vars desestruturadas** —
> conferir se é dead-code real ou se faltou fiar (apagar a prop muda a interface do componente).
> Os de `import` (lucide/date-fns/ui) são 100% seguros de apagar.

**B2 — typing real (2 arquivos):**

| Arquivo | Erro | Fix provável |
|---|---|---|
| `components/tintImport/ImportCard.tsx:183` | TS18048 `'r.failed_chunks' is possibly 'undefined'` | guard `r.failed_chunks ?? 0` / `?.` — 1 linha |
| `components/standard-process/StandardProcessForm.tsx:54,247,251` | TS2322/TS2345 — `Resolver<>` / `SubmitHandler<>` mismatch (zod com campos opcionais c/ default vs required) | **mesmo padrão deferido** do `AdminStandardProcessNew` (lane doc). Resolver com `zodResolver` quando o schema tem optional-com-default vs required no tipo inferido. Médio; fazer junto do irmão. |

## NEAR (83) — batcháveis quando os blockers forem promovidos

`bun scripts/strict-tsx-triage.mjs` lista cada NEAR com seus 1-2 blockers. Padrão comum: o blocker
é o `./types.ts`/`./config.ts`/`useX.ts` da própria feature. Promova o blocker (se for `.ts` leaf)
no mesmo lote e o NEAR vira READY. Áreas: `farmer/{calls,copilot,locc}` (blocker = `types.ts`/`config.ts`),
`analyticsSync` (blocker = `useAnalyticsSync.ts`), `customer360`, `customer`, `des/simulador`.

> Atenção a lanes quentes: `farmer/*` é farmer-adjacent (coordene com sessões farmer/scoring);
> `financeiroV2Service` é blocker de `RequireFinanceiroAccess` (alto, em churn).

## RISKY (51) e LAZY (10)

- **RISKY**: tocam `supabase`/`.rpc(`/`posthog`/`useUrlState` no corpo. Promovíveis, mas exigem que
  o cliente supabase e tipos estejam estáveis — caso a caso, não em lote cego.
- **LAZY**: usam `lazy()`/`import()` dinâmico = **não são leaf** (puxam o subgrafo lazy). Excluídos
  de propósito. Só promover com o método bottom-up (subgrafo lazy limpo primeiro) — ver lição no lane doc.
