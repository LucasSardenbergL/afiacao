# Roadmap da Sessão — atualizado 2026-06-01

> **Documento vivo.** Re-feito sempre que acrescentamos OU concluímos uma atividade, e renderizado no chat quando muda, pra o founder acompanhar. Prática padrão de toda sessão (registrada no CLAUDE.md, topo).
>
> **Legenda:** ✅ feito · 🔄 em andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado (decisão consciente) · 🧭 aguardando decisão (eu+codex)

---

## 1. Tarefas — Fase 1 (cobrança das vendedoras)
- ✅ **Desenho → spec → plano → build → ship.** PRs **#545** (módulo), **#549** (registro CLAUDE.md), **#551** (fix do e-mail de cobrança). Backend vivo em produção (6 migrations + crons + fix do matcher).
- ⏳ **Verificação visual da Fase 1** (founder) — **GATE** que libera o build da Fase 2. Em andamento (você está testando no preview do Lovable).
- 🔄 **Fix #1 — card "Minhas tarefas" visível no "Ver como"** (impersonation-aware no `useMinhasTarefas` + render no `MasterDashboard`, somente-leitura quando impersonando). Acordado nesta sessão; **aguardando seu OK pra implementar**.
- ⏸️ **Fast-follow — editar tarefa** (cancelar já existe; YAGNI até o uso mostrar necessidade).

## 2. Tarefas — Fase 2 (enforcement: recorrência + trava de comprovação)
- ✅ **Desenho → spec (endurecido com passe adversário do codex) → plano.** PR **#553** (doc-only).
- 🚧 **Build** — **BLOQUEADO** até a Fase 1 ser verificada (decisão eu+codex: não empilhar código sobre base não-clicada).

## 3. Visitas sugeridas / Rota (feature EXISTENTE — feedback desta sessão)
> Contexto confirmado: **Regina e Tatyana são farmers só de ligação + WhatsApp** (não fazem visita presencial).
- 🧭 **#2 — realinhar "Visitas sugeridas"** pras vendedoras que só ligam (relabel "Visitas"→"Ligações"? trocar o dashboard pra usar a lista de ligações da rota? ajustar persona/cópia?). **Decisão eu+codex em andamento.**
- 🧭 **#3 — city picker default só nas cidades da rota do dia (D-1)**, com "ver outras cidades" como opção secundária. **Decisão eu+codex.**

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança.
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- Lembrar o founder do que depende dele (verificação visual; deploy/Publish no Lovable; SQL no SQL Editor).
