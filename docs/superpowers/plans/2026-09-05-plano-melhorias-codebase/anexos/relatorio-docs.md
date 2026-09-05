# Auditoria de documentação — Afiação (read-only, 2026-09-05)

Worktree: `.claude/worktrees/intelligent-yalow-39d4e7` (branch `claude/code-improvements-plan-2bc5f9`, HEAD 9fe4e8880).
Método: leitura por recorte + `grep`/`sed`/`git log`/`gh` (leitura). Sem `bun`/`tsc`/`deno`/psql. "Fechado" só com código ou commit/PR que prove; "não confirmado" quando a prova exigiria banco (psql-ro) ou execução.

Escopo medido: `docs/` = 589 arquivos (superpowers 451 → 446 `.md` + 1 `.sql` + … · historico 96 · agent 17 · runbooks 3 · ux-audit 4 · visual-direction 5 · handoff 4 · cfo 2 · modulos 1 · pareceres 1 · 5 `.md` soltos na raiz) · `README.md` 73 l · `CLAUDE.md` 108 l · `supabase/README-schema.md` 81 l (regenerado 2026-09-05) · `.claude/skills/` 15 dirs (14 `SKILL.md`, 238 KB).

---

## §1 — Backlog herdado: o que continua aberto

### 1.1 `docs/historico/revisao-completa-2026-07-04.md` §Backlog NÃO corrigido (38 itens)

Legenda status: **ABERTO** · **PARCIAL** · FECHADO · não confirmado · adiado.

| # | Item | Origem (doc:linha) | Sev. | Status hoje | Evidência |
|---|---|---|---|---|---|
| 1 | Conversão orçamento→pedido não valida `empresa_omie` | revisao:25 | P0 | FECHADO | `SalesQuotes.tsx:118-142` envia `account` do orçamento e o servidor deriva a identidade (#1194 guard cross-conta, #1198 "identidade Omie por conta derivada no servidor") |
| 2 | Status vira `rascunho` antes do envio, sem rollback | revisao:26 | P1 | FECHADO | `SalesQuotes.tsx:192-197` — update só após sucesso ("Só AQUI — falha do edge deixa o orçamento intacto"); l.182-190 fail-closed p/ `blocked` desconhecido (lição Codex 2026-08-06) |
| 3 | `{blocked:'credito'}` vira toast de sucesso | revisao:27 | P1 | FECHADO | `SalesQuotes.tsx:149` trata `blocked==='credito'`; l.155 `tint_preco`; l.182 genérico |
| 4 | `handleRestore` não trava o cliente do rascunho | revisao:28 | P1 | **ABERTO** | `UnifiedOrder.tsx:262-270` restaura cart/notes/ordemCompra sem checar cliente; `draftScope = user?.id` (l.216) — draft por vendedor, não por cliente; único commit no símbolo = 300ff0893 (o original) |
| 5 | `submitQuote` sem guard re-entrante | revisao:29 | P2 | **PARCIAL** | `useUnifiedOrder.ts:804-805` `submittingRef` protege `submitOrder`; `submitQuote` (l.744-746) só faz `setSubmitting(true)` (estado, não ref) |
| 6 | Edição sincroniza fire-and-forget | revisao:30 | P2 | FECHADO | `useSalesOrderEdit.ts:337-345` "o edge vem PRIMEIRO, aguardado" (#1460 Fase 3) |
| 7 | Score sobre `sales_orders` sem paginação | revisao:33 | P1 | FECHADO | `useFarmerScoring.ts:166-231` `fetchAllPages` (classe #1338→#1564) |
| 8 | "Faturado hoje" não filtra `account` | revisao:34 | P1 | **ABERTO** | `useVendasZone.ts:47-52` query só `deleted_at`/`order_date_kpi`; `companies` entra na queryKey (l.21-22) mas não na query; #737 mudou só a data |
| 9 | "Gap de Margem" soma 100 linhas de log append-only | revisao:35 | P1 | **ABERTO** | `IntelligenceStrategicTab.tsx:34` `.limit(100)` em `margin_audit_log`; l.93 `totalGap = Σ margin_gap`; #1579 tratou só erro→zero |
| 10 | Customer360 faturamento sem `isPedidoValido`/`deleted_at`; janela por `created_at` | revisao:36 | P1 | **ABERTO** | `customer360/hooks.ts:140-146` sem filtro de status/deleted_at, `.limit(200)`, `data ?? []` (engole erro — classe #1581); `Customer360.tsx:67-69` filtra por `created_at` |
| 11 | Scores sempre com DEFAULT_CONFIG | revisao:37 | P2 | FECHADO | `useFarmerScoring.ts:665` deps do efeito incluem `config` |
| 12 | `getFluxoCaixa` sem paginação | revisao:40 | P1 | FECHADO | `financeiroService.ts:351-378` `.order("id").range()` paginado, erro lança |
| 13 | DRE por categoria `.range()` sem `.order()` | revisao:41 | P1 | FECHADO | `financeiroV2Service.ts:600-614` ordem total (achado Codex xhigh) |
| 14 | `getAnaliseDimensional` sem paginação | revisao:42 | P1 | FECHADO | `financeiroV2Service.ts:518-535` `fetchAllPages` (#1581) |
| 15 | Drill-down "Total" soma só `.limit(500)` | revisao:43 | P2 | **ABERTO** | `CockpitDrillDown.tsx:105/116/127/141` `.limit(500)`; l.96-143 `total = rows.reduce(...)`; último commit funcional 986d3d317 |
| 16 | `getAging*` engolem erro → R$0 | revisao:44 | P2 | **ABERTO** | `financeiroService.ts:308-313` `if (error \|\| !data) return {...EMPTY_AGING}` |
| 17 | FluxoCaixaTab "Acumulado" dupla-conta; `todayStr` UTC | revisao:45 | P2 | **ABERTO** | arquivo moveu p/ `components/financeiro/dashboard/FluxoCaixaTab.tsx`; l.22 `new Date().toISOString().slice(0,10)`; acumulado (l.38-55) não confirmado; sem commit desde #168 |
| 18 | "Aprovar e disparar" descarta `precoEdits` | revisao:48 | P1 | **PARCIAL** | `useDetalhesModal.ts:231` salva antes do disparo **só se** `Object.keys(edits).length>0`; `salvar` inclui `precoEdits` (l.156-161) — edição só-de-preço ainda pula o salvar |
| 19 | Editor de quantidade grava `num_skus`, não os itens | revisao:49 | P1 | **ABERTO** | `PedidoRow.tsx:64-69` grava só `num_skus`; comentário admite que a trilha canônica não toca |
| 20 | Rejeição em lote sem guard de status | revisao:50 | P1 | **ABERTO** | `useCicloHoje.ts:146-155` UPDATE `status='cancelado'` `.in("id", ids)` sem filtro de status |
| 21 | Baixo giro lê `account='oben'` mas saldo vive em `'vendas'` | revisao:51 | P2 | não confirmado (provável fechado) | `useBaixoGiro.ts:35` agora `.eq("account", empresa.toLowerCase())`; writer `omie-analytics-sync` upsert por `(omie_codigo_produto, account)` — valor real exige banco |
| 22 | Contagem offline enfileira valor absoluto stale | revisao:54 | P0 | FECHADO | `RecebimentoConferencia.tsx:285-296` — contador só avança após persistência (#1167 Onda 3) |
| 23 | `handleFinalize` não checa `data.modo` | revisao:55 | P1 | **ABERTO** | `RecebimentoConferencia.tsx:397-423` só `if (res.error) throw`; a edge devolve **200** com `success:false, modo:'falha_efetivacao'` (`omie-nfe-recebimento/index.ts:537`, `:642`) → toast "efetivada" |
| 24 | SW não cobre `picking_task_items`/`nfe_lotes_escaneados` | revisao:56 | P1 | **ABERTO** | `vite.config.ts:207` só `picking_tasks\|picking_units\|picking_lotes` |
| 25 | `signOut` sem `queryClient.clear()` | revisao:59 | P1 | **ABERTO** | `AuthContext.tsx:368-373` sem clear; `queryClient.clear` = 0 ocorrências em `src/` |
| 26 | `?` nunca abre o dialog de atalhos | revisao:60 | P2 | FECHADO (provável, não testado) | `ShortcutsDialog.tsx:19,26` registra `shift+/` **e** `?`; normalização em `ShortcutsRegistry.tsx:66-71` |
| 27 | `useUrlState` boolean default-`true` não persiste `false` | revisao:61 | P2 | **ABERTO** | `useUrlState.ts:26` `value ? '1' : null`; único commit = 300ff0893 |
| 28 | `parseBrDecimal` não trata milhar (fórmula 1000×) | revisao:64 | P0 | FECHADO (por remoção) | `useDirectTintImport.ts` não existe; `parseBrDecimal` 0 ocorrências; #1195 preflight fail-closed → #1314 aposentou o import CSV |
| 29 | Nova chamada sobrescreve sessão SIP sem `terminate()` | revisao:65 | P1 | **ABERTO** (camada sip-client) | `src/lib/sip/sip-client.ts:119-133` `makeCall` atribui `currentSession` sem terminar a anterior; guard busy só no inbound (l.75). Não confirmado se `WebRTCCallContext` gateia na UI |
| 30 | `fin-funding`/`fin-cashflow-engine` filtram `status_titulo='ABERTO'` (morto) | revisao:68 | P1 | **PARCIAL** | cashflow-engine l.399 → `.neq('status_titulo','CANCELADO')`; **`fin-funding/index.ts:555` ainda `.eq("status_titulo","ABERTO")`** |
| 31 | `fin-ic-reconcile` sem paginação + delete-all antes do insert | revisao:69 | P1 | **ABERTO** | 0 `.range(`; `.delete()` l.267; commits desde a criação = só refactor `Deno.serve` (#1685) e "Changes" |
| 32 | ~8 loops param em `total_de_paginas` | revisao:70 | P1 | FECHADO (amostra) | os 3 citados (`omie-sync-estoque`, `omie-analytics-sync`, `omie-sync-nfes-recebidas`) não referenciam mais o campo; 8 outras edges usam com guard (`omie-financeiro:574` `proximoTotalPaginas(..., MAX_PAGINAS_FIN)`; `omie-sync:393` só como flag) — amostra 2/8 |
| 33a | `generate-tactical-plan` grava fallback do LLM como plano | revisao:71 | P2 | FECHADO | `index.ts:266-267` fallback 25 removido, guard null (#982 + follow-ups) |
| 33b | `generate-bundle-argument` gate só `getUser` | revisao:71 | P2 | FECHADO | commit 0b5662801 "fix(seguranca): o gate guardava só a SONDA…"; `authorizeCronOrStaff` l.59 |
| 34 | Cap 1.000 (`useRoutePanel`, `useCrossSellEngine`, `useRevisaoParametros`, `useClientesScope`) | revisao:74 | sistêmico | FECHADO | todos com `.order`+`.range` em laço/`fetchAllPages` (+ gate estrutural #1550/#1581) |
| 35 | Datas UTC como "hoje" (7 sítios) | revisao:75 | sistêmico | **PARCIAL** | limpos: `agruparPorMes`, `RecebimentoConferencia`. Seguem `toISOString`: `lib/visitas/today.ts:3` (comentário diz "UTC por convenção do route planner"), `RotaPropostas.tsx`, `useKpisVisita.ts`, `useNotificacoes.ts`, `FluxoCaixaTab.tsx:22`. Total em `src/` não-teste: **29** `new Date().toISOString().slice/split` |
| 36 | TTL 5 min do lock de efetivação (mitigar c/ `AbortSignal`) | revisao:76 | P2 | **ABERTO** | `omie-nfe-recebimento/index.ts:485-489` `LOCK_TTL_MIN = 5`; 0 `abort` na edge |
| 37 | `process-recurring-orders` legado | revisao:77 | — | adiado por desenho | edge existe; condição "só se voltar a ter schedules" |

**Placar:** 16 FECHADO · **16 ABERTO** · **4 PARCIAL** · 1 não confirmado · 1 adiado. Os abertos concentram-se em **UI/hook de interação** (o que a própria revisão previu) e em **3 edges financeiras nunca retocadas** (#31 `fin-ic-reconcile`, #30 `fin-funding`, #36 lock).

### 1.2 Outros docs de backlog

| Item | Origem | Sev. orig. | Status | Evidência |
|---|---|---|---|---|
| ~78 cores Tailwind hardcoded → `text-status-*` | auditoria-health-2026-07-06:63 | baixa | **PARCIAL** | 18 ocorrências hoje (`text-emerald/red/green/amber/yellow/blue-600` em `src/**/*.tsx` não-teste) |
| ~20 `exhaustive-deps` em pages + components | auditoria-health:65 | baixa | não medido | lint não rodado; 15 `eslint-disable react-hooks/exhaustive-deps` em `src/` |
| 74 unused exports + 180 types (knip) | auditoria-health:66 | baixa | FECHADO | #1212 + #1707 "knip exit 0" |
| Perf ondas 1-5 — Publish frontend | perf-ondas:31-43 | — | sem pendência identificável | Onda 5 = #1211; Publish é ato manual não verificável aqui |
| #10 skill `benchmark-externo` | melhorias-code:81 | M | FECHADO | `.claude/skills/benchmark-externo/SKILL.md` (131 l) |
| #11 bi/cfo-colacor pós-psql-ro | melhorias-code:87 | S | FECHADO | `bi-colacor/SKILL.md:42-56`, `cfo-colacor/SKILL.md:59-92` já mandam rodar via psql-ro |
| #12 verify-frontend paralelo + QA visual | melhorias-code:93 | M | FECHADO | marcado ✅ no doc; `.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh` |
| Micro: `cd` no comando · chips · segredos | melhorias-code:104-106 | S | FECHADO | `CLAUDE.md:13-16` |
| Micro: receituário CSV governo BR | melhorias-code:107 | S | FECHADO | `docs/agent/csv-governo-br.md` |
| Micro: aliases de voz | melhorias-code:108 | S | FECHADO | `docs/agent/skills.md:106-108` |
| Micro: hook branch-pós-squash | melhorias-code:109 | S | FECHADO | `.claude/hooks/branch-pos-squash-guard.sh` |
| #14/#16 tabelas `nfe_receipt_runs`/`user_segments` (localStorage) | ux-audit/04:209 | decisão | **ABERTO** | `TODO(schema)` em `src/hooks/useCustomerSegments.ts` e `src/pages/NfeReceipt.tsx` (desde 2026-05-13) |
| #18 catálogo tint offline ~100 MB | ux-audit/04:210 | decisão | **ABERTO** (não verificado) | scaffold; nenhuma decisão registrada em historico |
| #19 auto-redirect picking mobile | ux-audit/04:211 | decisão | **ABERTO** | rota `admin/estoque/picking/mobile` existe (`App.tsx:407`); redirect por `pointer:coarse` não encontrado |
| #20 conflict resolution offline | ux-audit/04:212 | decisão | **ABERTO** (não verificado) | sem registro de decisão |
| Paginação real SalesOrders/AdminCustomers | ux-audit/04:225 | perf | PARCIAL | AdminCustomers paginado (`useClientesScope.ts:68-71`); SalesOrders não confirmado |
| 53 callsites `useToast` | ux-audit/04:226 | opcional | FECHADO | 1 arquivo restante com `useToast` em `src/` |
| `/unified-order` redirect ("precisa log de uso") | ux-audit/04:228 | — | **ABERTO** | `App.tsx:324` ainda redireciona; hoje há HogQL (`docs/agent/analytics.md`) — a query que decide nunca foi rodada |
| Branding stale `index.html`/manifest | ux-audit/04:229 | — | FECHADO (index) | `index.html:11` `<title>Colacor</title>`; manifest não localizado em `public/` |
| `deleteOrder` sem soft-delete · Account/Empresa em SalesOrders | ux-audit/04:230-231 | decisão | não confirmado | `SalesOrders.tsx:31,121` chama `deleteOrder`; implementação não inspecionada |
| A1 "Não cobrindo ainda": A2, A3, estoque_valor manual, `pmr_subindo` | FINANCEIRO_CONFIABILIDADE:21-29 | — | A2/A3 FECHADOS no próprio doc (§113/§133); **estoque_valor manual segue** (`cfo-colacor/SKILL.md:158` `fin_estoque_valor` preenchimento manual); `pmr_subindo` não verificado | doc internamente contraditório |
| "Fica para Onda 2" (cron, conciliação, orçado×realizado, intercompany, tributário, fechamento, projeção 13s) | ONDA1_PLANO_OPERACIONAL:373-382 | — | FECHADO em bloco | tudo entregue conforme FINANCEIRO_CONFIABILIDADE (Ondas 2/3, A2-A4, Otimizadores, Funding, Rolling); ONDA1_* são templates de **2026-03-29** com checkboxes vazios |
| Handoff cost-proxy | handoff-cost-proxy-fix.md:3 | money-path | FECHADO 2026-06-22 | banner "CONCLUÍDO E VERIFICADO EM PROD" |
| Handoffs BOM PR-1/PR-2/guard CFOP | docs/handoff/* | money-path | PR-1/PR-2 aplicados (confirmado no doc 2026-07-11; #1308); apply do guard CFOP (2026-07-12) **não confirmado** (exige psql-ro) | dois handoffs se contradizem sobre PR-1 (temporal) |
| #1332 migration `20260713050000_whatsapp_proposta_cotacao_v2.sql` no SQL Editor | prs-parados:100 | deploy | não confirmado (exige psql-ro) | — |
| migrations-audit.md | docs/migrations-audit.md | — | **não é backlog**: gerado por `scripts/audit-custom-migrations.ts`, atualizado 2026-09-04; 504 custom = 682 − 178 UUID (confere) | 4.235 linhas na raiz de `docs/` |

### 1.3 Issues e PRs abertos (GitHub, 2026-09-05)

13 issues abertas: **8 são "deploy/prova pendente"** (#2147, #2141, #2140 omie-vendas-sync bundle velho, #2139 migration não aplicada, #2138, #2129, #2082, #2072) — todas exigem Lovable/psql para fechar; 2 sentinelas automáticas (#1686, #1109); 1 GOAL (#1696); **2 antigas sem movimento**: #624 (2026-06-05, transposição durável de giro — 0 commits com "transposi") e #56 (2026-05-17, adoção do Dashboard V3 via PostHog — 0 menções a "dashboard v3" em `analytics.md`/historico apesar de o HogQL existir desde #1900).

PR aberto parado: **#2093** (2026-08-29, não-draft, `chore(ci): db/*.sh entra no shellcheck`, CI com FAILURE) — exatamente a "Forma 1" de `prs-parados-2026-08-06.md:103` ("PR não-draft em conflito é esquecimento").

---

## §2 — Saúde da documentação viva (CLAUDE.md + docs/agent)

Formato: `ID | título | categoria | evidência | por que importa | proposta | I·R·E`

- **D1 | "~119 rotas" envelheceu 50% | documentação | `docs/agent/mapa-do-app.md:3` ("~119 rotas lazy") e `:78`; real: 180 `path=` / 186 `<Route ` em `src/App.tsx` | o mapa é a fonte de "onde faço X"; 60+ rotas sem dono no mapa invalidam o propósito | trocar o número por um comando (`grep -c 'path=' src/App.tsx`) e regenerar a lista de rotas por gate por script; ou adicionar uma linha "medido em <data>" | I=3 R=2 E=1**
- **D2 | "~30 worktrees" ×3 e "39/40" | documentação | `money-path.md:26,187`, `deploy.md:98`, `worktrees.md:236` ("~20"), `:318-320` ("39/40"); real `git worktree list` = 79 | a regra de RAM/`heavy` e `/tmp` compartilhado escala com N; 79 ≠ 30 muda a urgência do `wt:reap` | substituir por "N (meça: `git worktree list \| wc -l`)"; adicionar o número ao `wt:status` | I=2 R=2 E=1**
- **D3 | Contagens absolutas de edges/testes/chunks | documentação | `deploy.md:98` "32 edges", `money-path.md:198` "93 edges" (real 95 dirs), `worktrees.md:83` "5681 testes" (não mensurável sem rodar), `deploy.md:464,481` "334 chunks" | número morto vira falsa precisão em regra viva | política: número só com data + comando que o mede; caso contrário, palavra ("dezenas") | I=1 R=1 E=1**
- **D4 | `analytics.md` (1.074 l) é 60% diário | documentação | §6 `l.474-1074` (56% do doc) = 11 sub-seções com timestamp 2026-08-24→26 ("Baseline no dia da instalação", "Primeira leitura PÓS-Publish 01:33Z", "DECISÃO: proxy RECUSADO"); §4 Armadilhas `l.111-315`: 4 de 5 sub-seções datadas; 61 linhas com data, 28 com #PR; regra viva ≈ §2-3 (`l.23-111`) + cabeçalhos | é o maior doc de `docs/agent/`, lido "antes de tocar o domínio" — 1.000 linhas para extrair ~100 de regra | mover §6 e as narrativas de §4 para `docs/historico/analytics-adocao-build-id.md` (1 linha no índice), deixando em cada armadilha só o bullet-regra + link | I=4 R=2 E=2**
- **D5 | `deploy.md` (503 l): §Canárias = 74% | documentação | `l.76-449`; "Sonda de versão" `l.96-312` (216 l, manual + post-mortem); 58 linhas com #PR, 44 com data | a mecânica das sondas já vive na skill `lovable-deploy-verify` (984 l) — dois lugares divergem | manter em `deploy.md` a tabela de decisão (canária × sonda × assinatura de log) e mover post-mortems para historico; a mecânica executável fica só na skill | I=3 R=2 E=2**
- **D6 | `worktrees.md` (407 l): §Colisão de código = 66% de prosa | documentação | `l.32-300` (268 l): timeline #1519-#1526, 37 refs a PR, 14 datas, **5 bullets-regra** (l.191-210) | as 5 regras estão enterradas na página 4 de um post-mortem | extrair as 5 regras para o topo; mover o post-mortem para `docs/historico/colisao-multi-sessao-2026-07.md` | I=3 R=1 E=2**
- **D7 | 3 docs de `docs/agent/` fora do índice do CLAUDE.md e de qualquer gate | documentação/processo | índice lista 14/17; faltam `csv-governo-br.md`, `review.md`, `threat-model-template.md`; `scripts/docs-indice-gate-check.ts:11-12` exclui `docs/agent/` de propósito | doc que nenhum índice cita não é carregado "sob demanda" — é invisível | adicionar 2 linhas ao índice (review/threat-model como "método"); ou estender o gate para exigir que todo `docs/agent/*.md` seja citado no CLAUDE.md | I=2 R=2 E=1**
- **D8 | Citações de caminho: 0 quebradas | documentação | 100% dos caminhos `src/ scripts/ supabase/ docs/ db/ .claude/` citados em `CLAUDE.md` e `docs/agent/*.md` existem (falsos positivos: globs `db/test-*`, hook global `~/.claude/hooks/`, URL posthog `docs/data/events`, pacote `postgrest-js/src/PostgrestBuilder.ts`) — o gate `docs:citacoes` funciona | achado positivo; nada a fazer | — | I=0**
- **D9 | 5 `.md` soltos na raiz de `docs/` + 4 pastas sem índice nem gate | documentação/processo | `ONDA1_PLANO_OPERACIONAL.md`/`ONDA1_FOLHA_EVIDENCIAS.md` (2026-03-29, templates com `☐`), `FINANCEIRO_CONFIABILIDADE.md` (2026-05-31, §A1 diz "não cobrindo A2/A3" e §113/§133 entregam A2/A3), `handoff-cost-proxy-fix.md` (concluído 06-22), `migrations-audit.md` (gerado, 4.235 l); `docs/handoff/` (4 handoffs concluídos), `docs/cfo/`, `docs/modulos/`, `docs/pareceres/` — nenhum em `ALVOS_VIVOS` (`docs-citacoes-gate-check.ts:23`) nem com README (`docs:indice` só onde há README) | o "caminho feliz" do CLAUDE.md (historico/agent/superpowers) não contempla esses 15 arquivos; o CI não vê apodrecimento | mover ONDA1_* e handoff-cost-proxy para `docs/historico/` (linha no índice); `FINANCEIRO_CONFIABILIDADE` → seção "estado das engines" em `docs/agent/financeiro.md` (40 l hoje) ou historico; `migrations-audit.md` → `db/` ou `docs/generated/`; `docs/handoff` + `pareceres` + `cfo` + `modulos` ganham README ou entram no `ALVOS_VIVOS` | I=3 R=2 E=2**
- **D10 | `README.md` contradiz o CLAUDE.md no gerenciador de pacotes | documentação | `README.md:30-36` `npm i` / `npm run dev`; `CLAUDE.md` §Scripts `bun dev`, "Worktree novo: `bun install` antes" | um humano segue o README e cria `package-lock.json` num repo `bun` | ver §4 | I=3 R=2 E=1**
- **D11 | `docs/agent/skills.md` não cita `doc2md`; `farmer-industrial-workspace/` não é skill | documentação | `ls .claude/skills` = 15 dirs; `farmer-industrial-workspace/` só `trigger-eval.json`; `doc2md` ausente de `skills.md` | roteamento de skills é "canônico" por definição do CLAUDE.md — skill fora dele não é roteada | 1 linha em `skills.md`; mover `trigger-eval.json` para dentro de `farmer-industrial/` | I=1 R=1 E=1**
- **D12 | `CLAUDE.md` claims verificadas e corretas | documentação | 18/18 caminhos citados existem; 10/10 scripts (`claude:size`, `wt:*`, `sonda:*`, `edges:typecheck`, `test:edges`) no `package.json`; `sonner` único (`useToast` em 1 arquivo); `claude-sonnet-4-6` é o único modelo nas edges (13 arquivos); `next-themes` e `density-compact` presentes | achado positivo | — | I=0**

---

## §3 — Sprawl

- **S1 | `docs/superpowers/` = 446 `.md` (199 plans + 248 specs — mais 1 `.sql` perdido em `plans/`), 9,8 MB, sem índice, fora de todos os gates | documentação/processo | referenciados por CLAUDE.md/historico/agent/runbooks: **74/446 (17%)** → 372 órfãos; marcador de conclusão no texto: plans 65/199, specs 81/248; 69 plans sem #PR nem marcador; criação por mês (prefixo do nome): plans 77/83/38/**1** (mai/jun/jul/ago), specs 74/110/54/8 — a convenção migrou de fato para `docs/historico/` | 10 MB que ninguém indexa nem gateia; `docs:citacoes` exclui a pasta (`ALVOS_VIVOS`), `docs:indice` só atua onde há README | **política:** (1) declarar `docs/superpowers/` congelado (só a skill `superpowers:writing-plans` cria lá); (2) gerar `docs/superpowers/INDEX.md` por script (nome · data · #PR citado · status inferido por marcador) e colocá-lo sob `docs:indice`; (3) mover para `docs/superpowers/arquivo/2026-Q2/`,`2026-Q3/` tudo com >90 dias sem referência viva (372 arquivos); (4) expurgo só com decisão do founder, por trimestre | I=3 R=1 E=2**
- **S2 | `docs/historico/`: 95 arquivos, 100% indexados (gate `docs:indice` comprovado: 0 sem linha, 0 links quebrados — o "b.md" é o exemplo `[a.md](b.md)` do próprio README), 2,3 MB; README de 108 l / **81 KB** | documentação | a tabela é lida por quem procura contexto e é o maior arquivo-índice do repo | achado positivo; opcional: coluna "mês" e ordenação cronológica reversa para que a leitura parcial (`head`) traga o recente | I=1 R=1 E=1**
- **S3 | Cobertura real dos 3 gates de docs | processo | `docs:indice` → pastas com README (`docs/historico`, `docs/runbooks`); `docs:citacoes` → `ALVOS_VIVOS = CLAUDE.md, docs/agent, docs/visual-direction, docs/runbooks, .claude/skills` (`scripts/docs-citacoes-gate-check.ts:23`; historico fora de propósito); `docs:links` → `.claude/skills` + docs (raízes não extraídas com certeza do script). **Fora de todos:** `docs/superpowers` (446), raiz de `docs/` (5), `docs/handoff`, `docs/cfo`, `docs/modulos`, `docs/pareceres`, `docs/ux-audit` (4) | 470+ arquivos (80% de `docs/`) sem sensor de apodrecimento | ampliar `docs:links` para `docs/**` (links relativos quebrados são baratos de checar) e adicionar README gateado em `docs/handoff` e `docs/pareceres` | I=2 R=2 E=2**

---

## §4 — Onboarding (README.md)

- **R1 | `README.md` é o boilerplate do Lovable intocado | documentação | 73 l; `REPLACE_WITH_PROJECT_ID` ×3 (l.5, 13, 61); "Node.js & npm"; lista genérica (Vite/TS/React/shadcn/Tailwind); zero menção a Supabase, `bun`, `.env.example` (existe na raiz), `psql-ro`, auto-merge/draft, 3 deploys manuais, worktrees, `heavy`, CLAUDE.md, `docs/agent` | um dev humano novo não tem porta de entrada: tudo isso vive no CLAUDE.md (escrito para agentes, com regras de sessão/compact/chips que não lhe dizem respeito); sem `CONTRIBUTING.md` | reescrever README em ~80 linhas, humano: (1) o que é (SO B2B das 3 empresas, Lovable Cloud, ref prod); (2) setup: `bun install`, `.env` a partir de `.env.example`, `bun dev`; (3) scripts canônicos (`bun run test/typecheck/lint`, `heavy`); (4) fluxo: branch → PR não-draft → auto-merge no `validate` → **3 deploys manuais** (Publish/edge/migration) → verificação; (5) worktrees (`bun run wt`); (6) mapa de leitura: CLAUDE.md (regras p/ agentes), `docs/agent/mapa-do-app.md`, `docs/historico/README.md`, `docs/runbooks/lovable-supabase.md`. O que sai do CLAUDE.md para o README: §Stack, §Scripts, §Merge (auto) e a explicação dos 3 deploys — o CLAUDE.md passa a linká-los | I=4 R=1 E=2**

---

## §5 — Skills proprietárias (`.claude/skills/`)

15 dirs · 14 `SKILL.md` · 238 KB total.

| Skill | linhas | bytes | assets |
|---|---|---|---|
| lovable-deploy-verify | **984** | **86.493** | 12 |
| fecho | 341 | 20.973 | 1 |
| lovable-db-operator | 319 | 20.848 | 4 |
| cfo-colacor | 261 | 17.656 | 14 |
| reposicao-caixa | 229 | 15.114 | 2 |
| bi-colacor | 191 | 12.076 | 5 |
| farmer-industrial | 182 | 12.036 | 7 |
| benchmark-externo | 131 | 10.920 | 0 |
| prove-sql-money-path | 127 | 12.264 | 3 |
| diagnose-supabase-sync | 100 | 10.111 | 3 |
| handoff-sessao | 99 | 5.104 | 0 |
| doc2md | 86 | 4.624 | 1 |
| matar-classe | 57 | 5.919 | 0 |
| goal | 46 | 3.832 | 0 |
| farmer-industrial-workspace | — (sem SKILL.md) | — | `trigger-eval.json` |

- **K1 | `lovable-deploy-verify/SKILL.md` = 36% de todas as skills | documentação | 984 l / 86 KB (~21k tokens ao invocar); 12 assets/scripts próprios | é invocada em TODO fecho de entrega; o custo de contexto é pago a cada uso; e duplica a narrativa de `deploy.md` §Canárias (D5) | cortar para o ritual (≤300 l) e mover mecânica/post-mortems para `assets/` ou historico; medir com `wc -c` no `claude:size`-like para skills | I=3 R=2 E=2**
- **K2 | 0 caminhos quebrados nas skills | documentação | 3 falsos positivos: `scripts/verify-*.sh` são relativos à skill (`.claude/skills/lovable-deploy-verify/scripts/` contém os 5); `docs/cfo/AAAA-MM-fechamento.md` é placeholder; `.claude/tasks` é diretório de runtime | o gate `docs:citacoes` cobre `.claude/skills` desde 2026-08-31 e funciona | — | I=0**
- **K3 | Skills não citadas no roteamento | documentação | `doc2md` fora de `docs/agent/skills.md`; `farmer-industrial-workspace/` só com `trigger-eval.json` | ver D11 | idem | I=1 R=1 E=1**
- **K4 | CLAUDE.md cita 3 skills locais (`fecho`, `handoff-sessao`, `prove-sql-money-path`); as outras 11 só via `docs/agent/skills.md` | documentação | consistente com a política "roteamento em skills.md" | nada a fazer | — |

---

## Medições

| Medida | Valor |
|---|---|
| `docs/` arquivos | 589 (superpowers 451 · historico 96 · agent 17 · runbooks 3 · ux-audit 4 · visual-direction 5 · handoff 4 · cfo 2 · modulos 1 · pareceres 1 · raiz 5) |
| Tamanho | superpowers 9,8 MB (plans 6,4 + specs 3,4) · historico 2,3 MB · agent 724 KB · skills 238 KB |
| `docs/agent/*.md` linhas | 3.259 (analytics 1.074 · deploy 503 · worktrees 407 · money-path 337 · database 193 · sync 142 · reposicao 131 · skills 110 · mapa-do-app 85 · …) |
| Rotas `src/App.tsx` | 180 `path=` / 186 `<Route ` (docs dizem ~119) |
| Worktrees | 79 (docs dizem ~30/~20/39-40) |
| Edges (dirs em `supabase/functions`, exceto `_shared`) | 95 (docs dizem 32/93) |
| Testes | 751 arquivos `*.test.ts(x)` em src/scripts/db · 63 `_test.ts` Deno · 270 `db/test-*.sh` |
| Migrations | 682 (178 UUID Lovable + 504 custom — bate com `migrations-audit.md`) |
| Schema snapshot | 336 `CREATE TABLE`, regenerado 2026-09-05 |
| Superpowers referenciados por docs vivos/historico | 74/446 (17%) |
| Superpowers por mês (plans/specs) | mai 77/74 · jun 83/110 · jul 38/54 · ago 1/8 |
| historico indexado | 95/95 (gate) |
| Skills | 15 dirs · 14 SKILL.md · maior 984 l |
| `toISOString().slice/split` como "hoje" em `src/` não-teste | 29 |
| Cores Tailwind hardcoded (`text-*-600`) | 18 (eram ~78) |
| Issues abertas | 13 (8 deploy/prova · 2 sentinela · 1 GOAL · 2 antigas) |
| PRs abertos | 5 (4 de hoje; #2093 de 2026-08-29 com CI FAILURE) |

## Descartei porque…

- **Caminhos "quebrados" que eram globs/prefixos/URLs:** `db/test-`, `db/test-seg-onda2e5-`, `scripts/wt-`, `scripts/test-heavy*`, `src/hooks/useTint`, `supabase/functions/tint-`, `docs/superpowers/specs/2026-0…` (prefixos truncados pela regex), `~/.claude/hooks/concurrent-session-guard.sh` (hook GLOBAL, fora do repo), `posthog.com/docs/data/events` (URL), `postgrest-js/src/PostgrestBuilder.ts` (pacote), `supabase/supabase-js` (pacote), `docs/superpowers/specs/2026-07-09-...-design.md` (reticências literais).
- **"b.md" sem arquivo** no índice do historico: é o exemplo `[a.md](b.md)` da regra do gate, não um link.
- **`/agent /autoplan /browse /codex /health /qa /review /security-review …`** citados no CLAUDE.md/skills.md e ausentes de `.claude/skills/`: são skills globais (gstack/plugins) presentes na listagem da sessão; `/login` e `/recebimento` são rotas.
- **`migrations-audit.md` como "backlog":** é inventário gerado (script + data 2026-09-04) e os números conferem — só o LUGAR (raiz de `docs/`, 4.235 l) é achado (D9).
- **`total_de_paginas` em 8 edges:** verifiquei 2/8 com guard (`proximoTotalPaginas` + teto; uso só como flag); não li as outras 6 — registrei como "fechado (amostra)".
- **Itens que exigem produção/banco** (#1332 migration v2, apply do guard CFOP, #2139/#2140, `inventory_position.account`): não rodei psql-ro nem Lovable — marcados "não confirmado".
- **`exhaustive-deps` contagem e "5681 testes":** exigem `bun run lint`/`test` — proibidos nesta auditoria.
- **`useVendasZone` (#8):** poderia ser desenho ("tile do grupo") — mas a queryKey carrega `companies` (l.21-22) e a query não, o que é a assinatura de filtro esquecido; mantive ABERTO.
