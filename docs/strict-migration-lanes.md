# Migração TypeScript strict — coordenação de lanes

> **Por que este arquivo existe:** múltiplas sessões de IA (e devs) trabalham a
> migração strict em paralelo. Sem coordenação, duas sessões pegam o mesmo arquivo
> (já aconteceu: `FinanceiroDashboard` decomposto pelo time enquanto outra sessão o
> tipava → trabalho jogado fora) ou conflitam no `tsconfig.strict.json`.
> Este é o **registro de reserva (claim)**: quem mexe no quê, agora.

## Estado atual (2026-05-23, fim do dia)

- **`no-explicit-any` no repo: 0.** A fase de eliminação de `any` está **concluída**
  (src + edge functions + tests). Convergência de várias sessões + lotes deste claim.
- **Fase atual: PROMOÇÃO** — adicionar arquivos strict-clean ao `include` do
  `tsconfig.strict.json`. Progresso: **~475 / 695** arquivos src (~68%).
- Edge functions (`supabase/functions/`): lint zerado também (any + prefer-const +
  no-empty + no-unused-expressions). Restam só 4 `ban-ts-comment` com eslint-disable
  **justificado** (`@ts-ignore` do `EdgeRuntime` — NÃO trocar pra `@ts-expect-error`,
  quebraria o typecheck do Deno no deploy).

## Como usar (protocolo — leia ANTES de começar trabalho strict)

1. **Cheque o que está em voo:** `gh pr list --state open` + `git worktree list`.
2. **Reserve sua fatia** editando este arquivo (status 🔵 + branch) no **primeiro
   commit** da sua branch.
3. **Só toque arquivos da sua fatia.** Nunca edite arquivo de fatia alheia.
4. **`tsconfig.strict.json` — convenção de append:** adicione paths **no fim do
   array `include`**, um por linha. **Não reordene** o resto (reordenar = conflito
   gigante). Conflito de append é trivial: *keep-both*.
5. **Ao mergear:** atualize o estado aqui.

## Promoção — o que sobrou e como fazer (lições aprendidas)

**Regra de ouro (custou um PR refeito — ver #180):** promover um arquivo puxa os
**imports transitivos** dele pro programa strict. Promover um page/god-component puxa
subgrafos sujos (`noUnusedLocals`/`strictNullChecks`) → cascata. **Promova leaf-first.**

- **⚠️ `lazy(() => import("..."))` CONTA como import pro tsc** (lição do lote 3,
  2026-05-24). Pages-hub pequenas (PerformanceHub, GestaoAdmin, TintIntegracao,
  TintCatalogo, VendasFerramentas, AdminReposicaoParametros) parecem leaf pelo
  `import ... from` (só ui+supabase), mas lazy-carregam **sub-páginas inteiras**
  (CoachingSPIN, FarmerBundles, AdminReposicaoAlertas, TintApiContract, Admin, ...)
  que entram no programa strict e quebram. **NÃO são leaf.** Ao triar candidatos,
  `grep -nE 'lazy\(' src/pages/<page>.tsx` — se houver lazy, trate como hub (defira
  até o subgrafo lazy estar limpo). Pages realmente leaf: sem `lazy`, só importam
  ui/hooks/lib já no programa.

- **`typecheck:strict` SÓ é confiável com CPU calma.** Com várias sessões rodando
  `tsc` em paralelo (load chegou a ~50), o comando é morto por contenção e dá
  **falso-negativo** (grep vê saída vazia → "0 erros" mentiroso). Confirme `load`
  baixo (`uptime`) e **espere o run completar** antes de confiar.
- **Padrão por lote:** adicione N candidatos ao `include` → `bun run typecheck:strict`
  → **remova os que derem erro** (mantém o lote tsconfig-only) → commit. Lotes leaf
  são tsconfig-only (zero edição de source).
- **CI**: o check `validate` roda `typecheck:strict` (gate real) — só promova o que
  passa. `bun lint` NÃO é gate de CI (no-explicit-any/lint não bloqueiam merge).

### Categorias restantes (~220 arquivos), por risco

| Fatia | Risco | Nota |
|---|---|---|
| `src/lib/**` restantes (scoring, visit-scoring, sip, transcription, call-session) | baixo-médio | leaf; scoring/visit-scoring são **farmer-adjacent** (coordene se houver sessão farmer ativa); sip/transcription têm boundaries de lib externa |
| `src/components/**` (~95) | médio | leaf primitivos OK; componentes de feature puxam deps |
| `src/contexts/**` restantes (AuthContext, CompanyContext, WebRTC*) | médio-alto | foundational/WebRTC — importados largamente, cascata |
| `src/services/**` (financeiroService, omieService, financeiroV2Service) | **alto** | grandes, cascata; precisam de edição de source |
| `src/pages/**` (~83) | **alto** | god-components/pages — cascata transitiva, edição de source, **fazer com CPU calma + sessões pausadas** |

### Lanes quentes (coordene antes)
- **Farmer/types**: sessões reescrevem `src/integrations/supabase/types.ts` + área farmer/scoring. Evite colidir.
- **Reposição**: god-components sendo decompostos.

### Reservas ativas (🔵 = em voo)
- ✅ **`feat/strict-promote-contexts`** (sessão determined-allen, 2026-05-23): fatia foundational —
  `contexts/{AuthContext,CompanyContext,ConditionalWebRTCProvider,WebRTCCallContext}` + `services/omieService`.
  **MERGEADA** (#220). `services/financeiroService`/`financeiroV2Service` ficaram fora (colidem com `feat/financeiro-a2-impl`).
- ✅ **`feat/strict-promote-pages`** (lote 1, #225 MERGEADO) + ✅ **`feat/strict-promote-pages-fixes`**
  (lote 2, #228 MERGEADO): 16 pages leaf promovidas (MeuDia, AdminCalculadora, NotFound,
  AdminReposicaoSessao{Aplicacao,Historico,Confirmacao}, AdminDesTrimestreAtual, AdminStandardProcesses,
  FinanceiroCapitalGiro, AdminKnowledgeBase, TintCorantes, FinanceiroAnalise, AdminOrderDetail, Telefonia,
  IntelligenceDashboard, Index).
- ✅ **`feat/strict-promote-pages-lote3`** (sessão determined-allen, 2026-05-24, #232 MERGEADO):
  3 pages leaf de verdade (Orders, AdminVendorSipCredentials, AdminReposicaoHistorico). Triagem do
  batch revelou que a maioria das pages "pequenas" restantes são **hubs com `lazy(() => import())`**
  (não-leaf — ver lição acima) ou têm dead-code/typing próprios. Deferidas p/ próximos lotes:
  hubs (PerformanceHub, GestaoAdmin, TintIntegracao/Catalogo, VendasFerramentas, AdminReposicaoParametros)
  e pages com fix próprio (Auth, AdminAjuda, AdminPriceTable, Support, ToolPublicHistory,
  AdminReposicaoSessaoPedidos, AdminStandardProcessNew).
- ✅ **`feat/strict-promote-pages-fixes2`** (sessão determined-allen, 2026-05-24, #241 MERGEADO): lote de
  fixes próprios (grupo C) — AdminAjuda, Support, ToolPublicHistory (dead-code), Auth, AdminPriceTable
  (typing: coerção de null no `.map()`, sem mexer em tipos compartilhados). Ainda deferidos:
  **AdminStandardProcessNew** (zodResolver com defaults opcionais vs required) e os **hubs com `lazy()`**
  (precisam do subgrafo lazy limpo — método bottom-up).
- 🔵 **`feat/strict-promote-lib-leaf`** (sessão cranky-driscoll, 2026-05-23): lote leaf não-farmer —
  `lib/call-session/aggregate-customer-profile`, `lib/sip/sip-client`, `lib/transcription/{deepgram-client,transcription-engine}`,
  `components/customer360/format`, `components/financeiro/dashboard/format`, `components/portalSayerlack/types`,
  `components/reposicao/alertas/types`. **NÃO toco** scoring/visit-scoring/farmer. Append-only no `include`.
- ✅ **`feat/strict-promote-hooks-leaf`** (sessão loving-nash, 2026-05-24, #237 MERGEADO): lote de hooks leaf não-reivindicados —
  `hooks/useIsTouchDevice`, `hooks/useIsTelefoniaManager`, `hooks/useBiometricAuth`, `hooks/useEstoqueValor`,
  `hooks/useDirectTintImport`, `hooks/unifiedOrder/useCart`, `hooks/unifiedOrder/useProductCatalog`. Append no fim do
  `include` + 3 fixes mínimos que o strict revelou (dead-code `base64ToArrayBuffer` em useBiometricAuth; param
  `importacaoId` não usado + 2 chaves de cache `string|null` guardadas em useDirectTintImport). **NÃO toco**
  `useMyAgendaToday` (puxa `lib/scoring/agenda`, lane farmer) nem `useAdminOrderDetail`/`useCallLog` (PR #228) nem
  `useValor` (financeiro-a2) nem `useRoutePlanner` (reposição).
- ✅ **`claude/strict-promote-fin-helpers`** (2026-05-26): 2 helpers **novos** (criados hoje nos PRs de
  segurança #322/#324/#327), pure-leaf, strict-clean por construção — `lib/financeiro/dre-period`,
  `lib/financeiro/omie-request`. Append-only no `include`. **NÃO toco** mais nada de financeiro
  (engines/services em churn por outras sessões); fatia disjunta da `cranky-driscoll` (que não tem `lib/financeiro/*`).
- 🔵 **`claude/strict-promote-leaf-tint-picking`** (sessão strange-hellman, 2026-05-27): lote leaf puro das lanes
  **tint/picking/offline/time** (disjunto de hooks=loving-nash, lib-leaf=cranky-driscoll, farmer/scoring, financeiro):
  `lib/tint/compute-price` (novo, tested), `lib/picking/view-pref`, `lib/picking/optimistic-merge`,
  `lib/offline-handlers`, `lib/time/sp-day`, `lib/routeCrumbs`. Append-only; `typecheck:strict` verde com os 6
  (transitivos de optimistic-merge/offline-handlers — picking-confirm/recebimento-* services + useOfflineFlush —
  já strict-clean). Tsconfig-only, zero edição de source. **NÃO toco** scoring/visit-scoring/farmer/financeiro/hooks.
- 🔵 **`claude/strict-promote-leaf-datahealth-impersonation`** (sessão strange-hellman, 2026-05-27): segundo lote leaf —
  `lib/dataHealth/{types,health-helpers}` + `lib/impersonation/{types,effective-user}`. Self-contained (types + helper
  que importa só os próprios types); nenhum PR aberto toca essas áreas. `typecheck:strict` verde com os 4. Tsconfig-only.
  **NÃO toco** carteira/mixgap/positivacao (farmer-adjacent) nem clientes-nao-vinculados (churn recente do #383).
- 🔵 **`claude/strict-promote-leaf-components`** (sessão strange-hellman, 2026-05-27): terceiro lote leaf — **`.ts` puros**
  (types/config/format/priority, **sem JSX**) de `components/{adminCustomers,aiOps,analyticsSync,customerDashboard}` +
  `components/des/{simulador,checkinQualitativo,historico}`. 14 arquivos; imports só de `lucide-react` (pacote tipado) ou
  os próprios `./types`. `typecheck:strict` verde. Tsconfig-only. **NÃO toco** os `useX.ts` (puxam queries/deps, não-leaf),
  nem `components/{farmer,financeiro,customer360}` (lanes quentes / reserva cranky-driscoll).
- 🔵 **`claude/strict-promote-leaf-components2`** (sessão strange-hellman, 2026-05-27): quarto lote leaf — 31 `.ts` puros
  (types/config/format/shared/helpers/queries) de `components/{loyalty,notificacoes,reposicao/*,salesOrders,salesOrderEdit,
  skuMapeamento,tintColorSelect,tintImport,unifiedAI}`. Reposição já saiu do mutirão de decomposição (encerrado 2026-05-25,
  §10) → types estáveis. Imports: próprios `./types`, `date-fns`/`react-query`/supabase-client (deps tipadas já no programa).
  `typecheck:strict` verde com os 31. Tsconfig-only. **NÃO toco** farmer/financeiro/customer360 nem os `useX.ts`.
- 🔵 **`claude/strict-promote-leaf-tsx`** (sessão strange-hellman, 2026-05-27): primeiro lote de `.tsx` presentacionais
  leaf (6, hand-verificados): `aiOps/{EvidenceItem,StatsCards,AiOpsHeader}`, `notificacoes/badges`,
  `des/historico/StarsRow`, `customerDashboard/PriorityCard`. Imports só de `lucide`/`react-router-dom`/`@/components/ui/*`
  (38 ui já no strict)/`@/lib/utils`/próprios `./types`. `typecheck:strict` verde. **NÃO toco** `reposicao/alertas/*`
  (reserva cranky-driscoll). ⚠️ **2 LIÇÕES de triagem `.tsx` (custaram um lote refeito):** (1) o filtro de imports
  TEM que casar **aspas duplas E simples** (`from "..."` e `from '...'`) — só-simples gera falso-leaf (deixa passar
  `import { supabase } from "..."`); (2) `lazy(() => import('...'))` e `import()` dinâmico **contam como import pro tsc**
  e puxam o subgrafo (ex.: um "leaf" que `lazy`-carrega `CiclosAnteriores.tsx` quebrou com `string|null`). Filtrar
  `grep -qE 'lazy\(|import\('` e **excluir** quem usa. ~100 `.tsx` candidatos restantes (re-filtrar com o filtro correto).

## Follow-up registrado

- **Reestruturar `tsconfig.strict.json` por lane** (fragmento por lane + include
  gerado, ou project references) pra eliminar de vez o conflito de append. **Flag-day**:
  só numa janela sem PRs strict em voo. Por ora a convenção de append basta. Ver CLAUDE.md §10.
