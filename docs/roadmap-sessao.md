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
- ✅ **Plano escrito.** Plano: `docs/superpowers/plans/2026-06-04-tarefa-criar-por-voz.md`.
- ✅ **Build concluído (código mergeável).** Edge `tarefa-extrair-voz` + helpers TDD (parser data, match cliente/vendedora, validação, montar-rascunhos) + `VozTarefaDialog` + wiring em `Tarefas.tsx`. CI passou (typecheck strict ✅ / 2145/2145 testes ✅ / lint 0 errors ✅ / build ✅).
- ⏳ **Deploy da edge + Publish + QA** (após merge). Edge `tarefa-extrair-voz` precisa ser criada via chat do Lovable. Publish do frontend no editor. QA manual no device com microfone.

## 5. "Buddy" (inspirado na UPOPS/PMBuddy do Itaú) — Crítica da Fila v1
> Pedido nesta sessão: "como copiar a UPOPS do Itaú a nosso favor?" Discutido com o codex (consult salvo em `.context/codex-session-id`). Reframe: nós **já somos** o OS consolidado → o transferível NÃO é chat-sobre-tudo (teatro p/ <20 users, morre em 60d no 1º erro factual), é **"contradição com evidência"** (a fila diz X, os sinais do cliente dizem Y; aja aqui). 1º Buddy = **VendedoraBuddy** (loop mensurável), v1 **determinístico-puro** (sem LLM → sem custo, sem alucinação no money-path).
- ✅ **Estratégia decidida (eu+codex).** VendedoraBuddy primeiro; GestorBuddy (brief de exceção agregado) sai depois, do **mesmo** motor de evidência. Provider do LLM no v1.5 = **Anthropic** (consolidar stack; hoje `copilot-analyze` usa Gemini via Lovable — a pref "single-provider Anthropic" não é verdade).
- ✅ **Spec escrita + aprovada pelo founder.** `docs/superpowers/specs/2026-06-04-critica-da-fila-design.md`. v1 = bloco **"Por que agora"** nos top-5 cards do Meu Dia: timeline de fricção + **4 badges de contradição determinísticos** (`recorrente_sumiu`, `tarefa_feita_sem_prova`, `sem_resposta_repetido`, `alto_valor_fora_rota`) + feedback instrumentado (PostHog). **100% frontend, zero backend** (customer_metrics_mv é client-readable; thresholds reusam o `useAiOps`). WhatsApp-voz **adiado** (bug de pendentes). **Critério de morte de 2 semanas** embutido.
- ✅ **Plano escrito.** `docs/superpowers/plans/2026-06-04-critica-da-fila.md` — 10 tasks TDD (4 detectores + composer + mapper `buildCriticaInputs` + hook `useCriticaFila` + UI `PorQueAgora`/`FilaDoDia` + telemetria + health gate). 100% frontend, sem migration/edge/cron.
- ⏳ **Build → Publish → piloto de 2 semanas** — aguardando seu **ok pra executar** (subagent-driven). Calibrar `altoValorFat90dMin`/`altoValorDiasQuietoMin` no piloto.

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete **#559 + #562 mergeados** + a feature de voz + o programa **Buddy (Crítica da Fila)** acrescentados).
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você:** (1) verificação visual da Fase 1 (libera o build da Fase 2) · (2) **revisão do spec da criação por voz** (libera o plano) · (3) **ok pra buildar a Crítica da Fila** (spec + plano prontos) · Publish no Lovable pro preview · SQL no SQL Editor quando houver migration (Fase 2 e a feature de voz terão).
