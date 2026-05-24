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
  `tsconfig.strict.json`. Progresso: **~409 / 629** arquivos src (~65%).
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
- 🔵 **`feat/strict-promote-pages-lote3`** (sessão determined-allen, 2026-05-24): mais pages leaf por
  lote empírico. **NÃO toco** Customer360 (lane refactor/customer360-split), pages farmer (lane farmer),
  nem `services/financeiro*`. Append-only no `include`.
- 🔵 **`feat/strict-promote-lib-leaf`** (sessão cranky-driscoll, 2026-05-23): lote leaf não-farmer —
  `lib/call-session/aggregate-customer-profile`, `lib/sip/sip-client`, `lib/transcription/{deepgram-client,transcription-engine}`,
  `components/customer360/format`, `components/financeiro/dashboard/format`, `components/portalSayerlack/types`,
  `components/reposicao/alertas/types`. **NÃO toco** scoring/visit-scoring/farmer. Append-only no `include`.

## Follow-up registrado

- **Reestruturar `tsconfig.strict.json` por lane** (fragmento por lane + include
  gerado, ou project references) pra eliminar de vez o conflito de append. **Flag-day**:
  só numa janela sem PRs strict em voo. Por ora a convenção de append basta. Ver CLAUDE.md §10.
