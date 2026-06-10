# Roadmap da Sessão — atualizado 2026-06-09

> **Documento vivo.** Re-feito sempre que acrescentamos OU concluímos uma atividade, e renderizado no chat quando muda, pra o founder acompanhar. Prática padrão de toda sessão (registrada no CLAUDE.md, topo).
>
> **Legenda:** ✅ feito · 🔄 em andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado (decisão consciente) · 🧭 aguardando decisão

---

## Sessão 2026-06-09 — Auditoria de velocidade & usabilidade + execução

### Auditoria (entregue no chat)
- ✅ **Varredura do código em 5 frentes paralelas** (data-fetching, bundle, re-renders, latência percebida, custo PostgREST) + build de produção medido + spot-check das evidências (8/8 confirmadas).
- ✅ **Mapa canônico de 24 itens**: 4 bugs (B1-B4) + 13 quick wins (#1-13, Onda 1) + 7 médios (#14-20, Ondas 2-4). IDs estáveis pra referência futura.

### Onda 1 — quick wins (#1-13) — PR desta branch
- ✅ **#1** clsx/tailwind-merge/cva → `vendor-utils` (recharts+d3 saíram do boot: vendor-charts fora do modulepreload)
- ✅ **#2** regex do `vendor-react` ancorada em node_modules (elevenlabs ~100KB gzip foi pro chunk lazy do FarmerCopilot; vendor-react 181→53KB gzip)
- ✅ **#3** HelpDrawer lazy (react-markdown + manuais .md fora do entry)
- ✅ **#4** posthog-js via dynamic import pós-mount + fila pré-init (1º pageview preservado)
- ✅ **#5** Home lazy por papel (CustomerDashboard × StaffDashboard em chunks próprios)
- ✅ **#6** Gates `enabled` nos polls sem dono (useAlertasCriticos/useFinanceiroAlertas/useTintAlertas — param obrigatório; useDataHealth — badge passa isStaff)
- ✅ **#7** `invalidateQueries()` sem key → `invalidateFila()` escopado (fila de aplicação)
- ✅ **#8** WhatsApp SLA: badge compartilha a queryKey do useWhatsappSla (1 fetch deduplicado) + throttle leading+trailing 3s na invalidação realtime
- ✅ **#9** Cockpit Reposição: throttle 2,5s no realtime (fim da tempestade de refetch+toast no cron das 9h15)
- ✅ **#10** Contadores da fila de aplicação → 4 head-counts server-side; polls 15/30s → 60s
- ✅ **#11** Debounce nas 3 buscas por tecla (Revisão → `useDebouncedValue` na queryKey; wizard → rank memoizado + `useDeferredValue`; clientes → input local + URL debounced)
- ✅ **#12** FarmerCalls: busca local em paralelo com o Omie + guard de corrida por sequência
- ✅ **#13** Loader2 full-page → PageSkeleton (FarmerCalls, FarmerDashboard, RecebimentoConferencia)
- ✅ **Infra nova**: `useDebouncedValue` (TDD, 6 testes) + `createLeadingTrailingThrottle` (helper testado, 6 testes — DRY dos 2 throttles) + `rankProducts`/`filterRanked` puros no catalog-helpers
- ✅ **`/review` (gstack) com exército de 5 revisores** (testing, maintainability, performance, design + adversarial) — pegou e eu corrigi: sync input↔URL revertia ação externa (deps mínimas nos efeitos), furo no guard de corrida do FarmerCalls (early-return sem bump do seq), `invalidateFila` não cobria a key do card de substituição, replace_all incompleto na Revisão (2 blocos com indentação diferente ficaram com `search` cru na queryFn), comentário FALSO sobre RQ v5 ("menor intervalo vence" não existe — cada observer tem timer próprio), retry de analytics prometido e não implementado (agora re-tenta no `online`), toast do cockpit com id estável, HelpDrawer com latch (não some na animação de saída), badge WhatsApp ganhou o gate sales-only, dedup do useDebouncedValue privado do useGlobalSearch, `keepPreviousData` na Revisão, FilaCounterRow órfão removido
- ✅ **Achado pré-existente do review (registrado, NÃO mexido):** canal realtime `wa-sla` é reusado por topic — 2 instâncias do hook juntas (Meu Dia) podem derrubar o canal (CHANNEL_ERROR silencioso; o poll de 30s cobre). Fix = canal singleton/refcount → **Onda 3**, junto do trabalho de WhatsApp
- ✅ **Validação (Caminho B)**: typecheck strict ✅ · vitest 2856/2856 ✅ · lint 0 errors ✅ · build-diff nos bytes ✅ — **boot ~705 → ~333KB gzip (−53%)**
- 🔄 **PR aberto → CI `validate` → merge** (sem `--admin`)
- ⚠️ **Publish no Lovable** após o merge (deploy do frontend é manual — founder)

### Próximos (aguardando o founder priorizar)
- ⏳ **B1** — KPI A Receber/Pagar de `/financeiro/gestao` soma errado (filtro `PAGO` não exclui RECEBIDO/LIQUIDADO no CR + truncamento silencioso no cap 1000). **PR próprio, money-path, com teste.**
- ⏳ **Onda 2** — #14 catálogo do wizard em React Query (maior ganho percebido da vendedora) · #15 selectCustomer paralelo
- ⏳ **Onda 3** — B2 thread WhatsApp truncada + #18 optimistic nas ações da vendedora · B3 isError nas telas de receita + #16 fila de rota server-side
- ⏳ **Onda 4** — #17 split do WebRTCCallContext (re-render 1×/s em chamada) + **#17b jssip fora do entry** (IncomingCallModal importa o context estaticamente — achado do build-diff, deliberadamente NÃO feito de improviso por ser telefonia) · B4 PWA prompt · #19 prefetch · #20 precache do Workbox
- 🚧 **Codex adversarial retroativo da Onda 1** — cota do Plus esgotada (2º strike 09/06, volta ~11/06); Caminho B aplicado (validação exaustiva própria + build-diff). Rodar `/codex review` retroativo quando voltar.
