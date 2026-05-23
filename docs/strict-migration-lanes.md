# Migração TypeScript strict — coordenação de lanes

> **Por que este arquivo existe:** múltiplas sessões de IA (e devs) trabalham a
> migração strict em paralelo. Sem coordenação, duas sessões pegam o mesmo arquivo
> (já aconteceu: `FinanceiroDashboard` decomposto pelo time enquanto outra sessão o
> tipava → trabalho jogado fora) ou conflitam no `tsconfig.strict.json`.
> Este é o **registro de reserva (claim)**: quem mexe no quê, agora.

## Como usar (protocolo — leia ANTES de começar trabalho strict)

1. **Cheque o que está em voo:** `gh pr list --state open` + leia a tabela abaixo.
2. **Reserve uma lane livre:** edite a tabela, troque o status pra `🔵 em andamento`
   e ponha sua branch na coluna *Dono*. Commite essa reserva no **primeiro commit**
   da sua branch (assim outras sessões enxergam via `gh pr list` / `git fetch`).
3. **Só toque arquivos da sua lane.** Nunca edite arquivo de lane alheia.
4. **`tsconfig.strict.json` — convenção de append (até a reestruturação por lane):**
   adicione seus paths **no fim do array `include`**, um por linha, agrupados pela
   sua lane. Não reordene/realfabetize o resto do array (reordenar = conflito gigante
   com todo PR em voo). Conflito de append é trivial: resolva com *keep-both*.
5. **Ao mergear:** marque a lane como `✅ done` na tabela.

## Lanes

Contagem de `no-explicit-any` (fonte: `bun lint`, 2026-05-23). "any" aqui = lint
`@typescript-eslint/no-explicit-any` a remover; promoção a strict exige TAMBÉM passar
`strictNullChecks`/`noUnusedLocals` (alguns arquivos cascateiam — corrige o `any`
mesmo que a promoção fique pra depois).

| Lane | Status | Dono (branch) | Arquivos (any) |
|---|---|---|---|
| **L1 hooks-alertas** | 🔵 em andamento | `feat/ts-strict-wave-cold-lanes` | `useSharpeningSuggestions.ts`(2) · `useTintAlertas.ts`(1) · `usePushNotifications.ts`(1) · `useFinanceiroAlertas.ts`(1) · `useAlertasCriticos.ts`(1) · `hooks/unifiedOrder/types.ts`(1) |
| **L2 components-misc** | 🔵 em andamento | `feat/ts-strict-wave-cold-lanes` | `VoiceServiceInput.tsx`(2) · `OrderChat.tsx`(2) · `unified-order/ProductItemForm.tsx`(1) · `portalSayerlack/DispararAgoraButton.tsx`(1) · `TintColorSelectDialog.tsx`(1) · `ForgotPasswordDialog.tsx`(1) |
| **L3 pages-afiação-tint** | 🔵 em andamento | `feat/ts-strict-wave-cold-lanes` | `VendasFerramentas.tsx`(1) · `UnifiedOrder.tsx`(1) · `ToolReports.tsx`(1) · `ToolHistory.tsx`(1) · `TintCorantes.tsx`(1) |
| **L4 pages-gestão-farmer** | 🔵 em andamento | `feat/ts-strict-wave-cold-lanes` | `SavingsDashboard.tsx`(1) · `PerformanceHub.tsx`(1) · `GestaoAdmin.tsx`(1) · `FarmerIPFDashboard.tsx`(1) · `FarmerDashboard.tsx`(1) · `AdminProductivity.tsx`(1) · `AdminDemandForecast.tsx`(1) · `AIops.tsx`(1) · `Auth.tsx`(1) |
| **L5 reposição** 🔥 | 🟢 livre | — | `AdminReposicaoParametros.tsx`(1) · `AdminReposicaoHistorico.tsx`(1) — **quente: time decompondo god-components da Reposição, coordene antes** |
| **L6 route-planner** 🔥 | 🟢 livre | — | `AdminRoutePlanner.tsx`(13) — **quente: acabou de ser decomposto (#169); reconfira o any-count antes** |
| **L7 edge-functions** | 🟢 livre | — | `supabase/functions/**`(~20) — **fora do escopo do `tsconfig.strict.json`** (Deno, não roda no `tsc` do app). Tratar separado. |
| **L8 tests** | 🟢 livre | — | `src/__tests__/financeiro.test.ts`(3) · `src/lib/sip/audio-preroll.test.ts`(2) · `src/lib/financeiro/__tests__/error-handler.test.ts`(2) · +1 — escopo de teste, baixa prioridade. |

**Legenda:** 🟢 livre · 🔵 em andamento · ✅ done · 🔥 lane quente (time ativo, coordene)

## Follow-up registrado (não fazer no meio do fogo cruzado)

- **Reestruturar `tsconfig.strict.json` por lane** (um fragmento por lane + include
  gerado, ou project references) pra eliminar de vez o conflito de append. É um
  **flag-day**: só fazer numa janela sem PRs strict em voo, senão o reshuffle do
  array de 375 paths conflita com todo mundo. Por ora, a convenção de append acima
  basta (conflito trivial). Ver CLAUDE.md §10.
