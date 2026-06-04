# Roadmap da Sessão — atualizado 2026-06-04

> **Documento vivo.** Re-feito sempre que acrescentamos OU concluímos uma atividade, e renderizado no chat quando muda, pra o founder acompanhar. Prática padrão de toda sessão (registrada no CLAUDE.md, topo).
>
> **Legenda:** ✅ feito · 🔄 em andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado (decisão consciente) · 🧭 aguardando decisão (eu+codex)

---

## 1. Tarefas — Fase 1 (cobrança das vendedoras)
- ✅ **Desenho → spec → plano → build → ship.** PRs **#545** (módulo), **#549** (registro CLAUDE.md), **#551** (fix do e-mail de cobrança). Backend vivo em produção (6 migrations + crons + fix do matcher).
- ✅ **Fix #1 — card "Minhas tarefas" visível no "Ver como"** (impersonation-aware no `useMinhasTarefas` + render no `MasterDashboard`, somente-leitura quando impersonando). **PR #559, mergeado.** (Pegou um CI do guard `no-write-leak` — `effectiveUserId` é uso read-only; resolvido com allowlist + justificativa.)
- ⏳ **Verificação visual da Fase 1** (founder) — **GATE** que libera o build da Fase 2. Depende de **Publish no Lovable** + clicar no preview. **Bola com você.**
- ⏸️ **Fast-follow — editar tarefa** (cancelar já existe; YAGNI até o uso mostrar necessidade).

## 2. Tarefas — Fase 2 (enforcement: recorrência + trava de comprovação)
- ✅ **Desenho → spec (endurecido com passe adversário do codex) → plano.** PR **#553** (doc-only), mergeado.
- 🚧 **Build** — **BLOQUEADO** até a Fase 1 ser verificada (decisão eu+codex: não empilhar código sobre base não-clicada). Plano pronto: 5 blocos SQL (A: `tarefa_templates`; B: colunas de comprovação + `customer_user_id` nullable + CHECK + UNIQUE; C: view window-aware + RLS; D: trigger anti-bypass + RPCs + cron de materialização; E: bucket de Storage).

## 3. Visitas sugeridas / Rota (feature EXISTENTE — feedback desta sessão)
> Contexto confirmado: **Regina e Tatyana são farmers só de ligação + WhatsApp** (não fazem visita presencial). Decisão eu+codex: o dashboard delas deve liderar com a lista de ligações da rota, não com visitas.
- ✅ **#2 — dashboard do farmer lidera com "Ligações da rota"** (CTA → `/rota/ligacoes`); card "Visitas sugeridas" renomeado pra **"Visitas sugeridas — equipes de campo"** (só Hunter/Closer visitam presencialmente). **PR #562, mergeado.**
- ✅ **#3 — lista default só nas cidades da rota (D-1).** A `/rota/ligacoes` **já é D-1 por construção** (`useRouteContactList` usa as cidades da rota de amanhã); o farmer agora é apontado pra ela. **Subsumido por #562 + o programa de rota existente.**
- ⏸️ **Deferred — `useRouteContactList` impersonation-aware** (pra "Ver como farmer" mostrar as ligações daquele farmer). Follow-up de baixo valor sem demanda concreta.

## 4. Tarefas — criar por voz (áudio → IA estrutura → revisa → cria)
> Pedido nesta sessão: founder grava um áudio ("manda a Regina ligar pra Padaria do Zé amanhã e oferecer a linha nova, e whatsapp pra Maria sexta") → transcreve → IA estrutura em N tarefas → founder revisa/corrige cliente+vendedora → cria. Multi-tarefa por áudio; "calendário" = o prazo (data) que joga no Meu Dia.
- ✅ **Decisões fechadas:** (A) fala tudo + IA infere + revisa/corrige antes de salvar (zero auto-criação); multi-tarefa por áudio. Transcrição já existe (`elevenlabs-transcribe`).
- ✅ **Spec escrito + endurecido com passe adversário do codex.** Princípio central (codex): IA faz extração+split; **datas e entidades saem da IA** pra parser determinístico pt-BR + match local com limiar + confirmação humana. Spec: `docs/superpowers/specs/2026-06-04-tarefa-criar-por-voz-design.md`.
- ⏳ **Revisão do spec pelo founder** → libera o plano de implementação.
- ⏳ **Plano + build** (depois da revisão). Inclui edge `tarefa-extrair-voz` (Anthropic tool-use) + helpers TDD (parser de data, match cliente/vendedora) + `VozTarefaDialog`.

## 5. SLA de resposta do WhatsApp — "cliente sem resposta" (NOVO nesta sessão)
> Pedido: indicador + alerta de quanto tempo um cliente está sem resposta no WhatsApp quando a conversa está sob comando humano, escopado por vendedora dona do cliente; alerta pra mostrar pro pessoal "seus clientes tão sem resposta".
- ✅ **Decisões fechadas:** os dois consumidores (card da vendedora na Meu Dia + badge + painel founder/gestor + digest diário por e-mail, espelha Tarefas); métrica = **primeira mensagem não respondida**; relógio **só expediente seg–sex 07:30–17:30** (config no `company_config`); limiares **15 min (amarelo) / 30 min (vermelho)**; digest diário ~18h reusando `fornecedor_alerta`→`dispatch-notifications`; vendedora vê **Minhas/Todas** (display-only, sem mexer na RLS do inbox).
- ✅ **Spec escrito + endurecido com passe adversário do codex** (gpt-5.5 xhigh; 6 P1 + 8 P2 folded). Achados-chave incorporados: `assigned_operator_id` é **congelado** na criação → derivar o dono **ao vivo** da carteira (+cobertura/férias); "respondido" = `sender_user_id IS NOT NULL` (exclui blast/IA de graça); âncora no `wa_timestamp`; stop-keyword e `fechada` fora do SLA; digest **idempotente**; `fornecedor_alerta` exige `titulo`+CHECK; e-mail vai pro `NOTIFICATION_EMAIL_TO`. Spec: `docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md`. **Spec aprovado pelo founder.**
- ✅ **Plano de implementação escrito** (13 tasks TDD, 2 fases). Aterrado no código real (2 explorações + leitura dos arquivos do inbox). Plano: `docs/superpowers/plans/2026-06-04-whatsapp-sla-resposta.md`.
- ✅ **Execução: subagent-driven.** Build da **F1 CONCLUÍDO** (8 commits, gate typecheck+lint+build verde). SQL (funções+view) **validado em PG17 local** (10 asserts da função + cenários da view: esperando/bola/fechada/stop/sem-dono/template + dono ao vivo). Front: hook + SlaBadge + selo no inbox + card Meu Dia (Minhas/Todas) + badge na sidebar + painel `/whatsapp/sla` (gestor/master).
- ⏳ **GATE da F1 (founder):** aplicar a migration `20260604130000_whatsapp_sla.sql` no SQL Editor + **Publish** no Lovable + conferir no device (selo/card/badge/painel). Libera a F2.
- ⏳ **Build F2** (após o gate): digest cron + e-mail (`20260604140000_whatsapp_sla_digest.sql` + edita `dispatch-notifications`). Já especificado no plano (Tasks 11-13).
- ⏸️ **Não-objetivos v1:** hardening de RLS do inbox, e-mail em tempo real, feriados, flag IA↔humano (o predicado de `sender_user_id` já protege).

## 6. PostHog → log de erro de produção por e-mail (NOVO, track 2, não iniciado)
> Pedido: capturar os erros que aparecem na tela em produção durante o uso e me mandar por e-mail pra eu tratar no Claude Code.
- ✅ **Viabilidade confirmada:** PostHog tem Error Tracking nativo (`captureException`) + alerta/inscrição por e-mail. Hoje o `ErrorBoundary` só faz `console.error`; o gancho de Sentry no `logger` está comentado; sem Sentry.
- 🧭 **A desenhar depois do WhatsApp SLA** (track menor): ligar `captureException` no `ErrorBoundary` + `window.onerror`/`unhandledrejection` → PostHog Error Tracking + alerta por e-mail. Alternativa Sentry = vendor novo, decisão de produto.

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete **#559 + #562 mergeados** + voz + **WhatsApp SLA** + **PostHog erros** acrescentados).
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você:** (1) verificação visual da Fase 1 das Tarefas (libera o build da Fase 2) · (2) **revisão do spec da criação por voz** · (3) **revisão do spec do WhatsApp SLA** (libera o plano) · Publish no Lovable pro preview · SQL no SQL Editor quando houver migration.
