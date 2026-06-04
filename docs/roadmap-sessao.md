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

## 5. Reposição — tingidores fabricados ('04') na fila + REGRESSÃO do sinal `tipo_produto`
> Founder notou 5 tingidores Sayerlack OBEN (fabricados na hora) pedindo aprovação em **Parâmetros → Revisão**. Investigação revelou DOIS problemas: (a) a fila não filtrava `produto_acabado` (ruído); (b) **o sinal `tipo_produto` foi ZERADO em 100% dos ~3651 produtos OBEN** (medido em prod: 0 com `04`, 3651 NULL, sync fresco).
- ✅ **(a) Fix de UI** — a fila esconde `produto_acabado` (`.or('tipo_reposicao.is.null,tipo_reposicao.neq.produto_acabado')`; preserva NULL/automatica/sob_encomenda). Typecheck + lint OK. ⏳ shippar **agrupado com (b)** (1 PR pra toda a frente).
- ✅ **Causa-raiz (b) confirmada** — 4 syncs descritivos (`omie-analytics-sync`/`omie-sync-metadados`/`sync-reprocess`/`tint-omie-sync`) reconstroem `omie_products.metadata` **sem** `tipo_produto` e fazem upsert na mesma linha (account `oben`) → sobrescrevem o `omie-vendas-sync` (único que grava o `04`). Upsert sobrescreve o jsonb inteiro; rodam por cron → estado estável = NULL. **Guarda viva morta + vigia `reposicao_sayerlack_fabricado` verde-mentindo.**
- ✅ **Desenho (eu+codex)** — **coluna dedicada `omie_products.tipo_produto`** (sai do metadata compartilhado) + **writer autoritativo** que pagina o catálogo todo + **trigger anti-null-clobber** + **vigia de cobertura** do sinal + **RPC fail-closed** quando cobertura broken + fix do join account-blind. Consumidores (RPC/cold-start/vigia/de-para/`submitOrder`) leem a coluna (`COALESCE(coluna, metadata->>...)` na transição). `prod.tipo` só fallback se numérico (é discriminador de Kit 'K').
- ✅ **Spec + plano escritos** — `docs/superpowers/specs/2026-06-04-tipo-produto-coluna-dedicada-design.md` + `docs/superpowers/plans/2026-06-04-tipo-produto-coluna-dedicada.md`. Founder aprovou ("pode seguir"); Q1=dono único (`omie-sync-metadados`) · Q2=OBEN+Colacor · Q3=cadência confirmar no Checkpoint A.
- ✅ **PR1 (fundação) — [#575](https://github.com/LucasSardenbergL/afiacao/pull/575) MERGED** (Migration 1 coluna+trigger · `omie-sync-metadados` writer autoritativo · `omie-vendas-sync` para de gravar o sinal · helper TDD · fix de UI da fila).
- ✅ **Checkpoint A CONCLUÍDO (em prod)** — M1 aplicada (coluna+trigger), 2 edges deployadas da main, full sync rodado. **Sinal restaurado: OBEN 0→1229 `04` (3644/3651 classificados)**; colacor 147/600/4254 (cobertura menor = follow-up, NULL=comprável seguro). Corpos vivos recebidos (RPC == 20260531160000; `_data_health_compute` = 15 checks, **sem** mapeamento_gap → #538 não aplicado).
- ✅ **PR2 (consumidores) — [#579](https://github.com/LucasSardenbergL/afiacao/pull/579) MERGED** (typecheck 0 · 146 testes · lint 0): **M2a** RPC fail-closed + guarda lê coluna + view cold-start · **M2b** Sentinela check sayerlack lê coluna + **novo check `omie_tipo_produto_oben`** (cobertura) + watchdog/heartbeat · frontend `submitOrder` lê a coluna. Migrations verbatim dos vivos + edits pontuais. **Fix account-blind ISOLADO** (follow-up).
- ✅ **Checkpoint B CONCLUÍDO (em prod)** — M2a + M2b aplicadas; ciclo OBEN regenerado (**4 pedidos / 39 SKUs / R$19.767, 0 bloqueados** — guarda viva ativa); verde-VERDADE: `reposicao_sayerlack_fabricado`=ok (lê a coluna, não mais mentindo) + `omie_tipo_produto_oben`=ok (3644/3651 classificados, 1229 `04`).
- ⭐ **FRENTE 5 ENCERRADA (em produção)** — sinal `tipo_produto` restaurado e blindado: coluna dedicada imune à sobrescrita + trigger anti-null-clobber + RPC fail-closed + vigia de cobertura. Os 5 tingidores que iniciaram tudo somem da fila (fix de UI) e a guarda de "não comprar fabricado" voltou a valer de verdade.
- ⏳ **Follow-ups (não-bloqueantes):** (1) **Publish** no Lovable → `submitOrder` lê a coluna p/ auto-OP de produto acabado; (2) **fix account-blind** na RPC (PR isolado, validar cardinalidade antes/depois); (3) **colacor cobertura 14%** (600/4254 typed) — ver se o `tipoItem` vem no payload do colacor ou se o sync cobriu menos; (4) **cadência** do cron `omie-sync-metadados` (manter o sinal <48h, senão o vigia novo alerta); (5) **registrar no CLAUDE.md** (lição: colisão de upsert zerando sinal money-path → coluna dedicada).

## 6. Painel das ligações da rota (capacidade × eficácia)
> Pergunta do founder: "automatizar mais (WhatsApp) vs contratar mais vendedora?" — respondida com dado do closed-loop existente.
- ✅ **Spec escrito + endurecido com passe adversário do codex.** Decisões centrais: snapshot on-open da fila (denominador); valor = `status='convertido'` + `valor_da_ligacao` (rotulado "valor esperado, não R$ realizado"); cortes por vendedora/bucket/canal; gating n≥30 + banner "direcional". Spec: `docs/superpowers/specs/2026-06-04-painel-ligacoes-rota-design.md`.
- ✅ **Plano escrito.** Plano: `docs/superpowers/plans/2026-06-04-painel-ligacoes-rota.md`.
- ✅ **Build concluído (PR #577).** Migration `route_queue_snapshot` + helpers TDD (`gating`, `agregar`) + snapshot on-open (`useSnapshotRouteQueue`) + `useRoutePanel` + página `RotaPainelLigacoes` + rota `/rota/ligacoes/painel` + link na `/rota/ligacoes`. CI passou (typecheck strict ✅ / 2186/2186 testes ✅ / lint 0 errors ✅ / build ✅).
- ⏳ **Migration `route_queue_snapshot` no SQL Editor + Publish + QA** (após merge). Colar o SQL (`20260604120000_route_queue_snapshot.sql`) no SQL Editor do Lovable → confirmar a tabela criada → Publish → QA: abrir `/rota/ligacoes` (grava snapshot) → registrar ligações → abrir `/rota/ligacoes/painel`.

## 7. SLA de resposta do WhatsApp — "cliente sem resposta" (NOVO nesta sessão)
> Pedido: indicador + alerta de quanto tempo um cliente está sem resposta no WhatsApp quando a conversa está sob comando humano, escopado por vendedora dona do cliente; alerta pra mostrar pro pessoal "seus clientes tão sem resposta".
- ✅ **Decisões fechadas:** os dois consumidores (card da vendedora na Meu Dia + badge + painel founder/gestor + digest diário por e-mail, espelha Tarefas); métrica = **primeira mensagem não respondida**; relógio **só expediente seg–sex 07:30–17:30** (config no `company_config`); limiares **15 min (amarelo) / 30 min (vermelho)**; digest diário ~18h reusando `fornecedor_alerta`→`dispatch-notifications`; vendedora vê **Minhas/Todas** (display-only, sem mexer na RLS do inbox).
- ✅ **Spec escrito + endurecido com passe adversário do codex** (gpt-5.5 xhigh; 6 P1 + 8 P2 folded). Achados-chave incorporados: `assigned_operator_id` é **congelado** na criação → derivar o dono **ao vivo** da carteira (+cobertura/férias); "respondido" = `sender_user_id IS NOT NULL` (exclui blast/IA de graça); âncora no `wa_timestamp`; stop-keyword e `fechada` fora do SLA; digest **idempotente**; `fornecedor_alerta` exige `titulo`+CHECK; e-mail vai pro `NOTIFICATION_EMAIL_TO`. Spec: `docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md`. **Spec aprovado pelo founder.**
- ✅ **Plano de implementação escrito** (13 tasks TDD, 2 fases). Aterrado no código real (2 explorações + leitura dos arquivos do inbox). Plano: `docs/superpowers/plans/2026-06-04-whatsapp-sla-resposta.md`.
- ✅ **Execução: subagent-driven. Build INTEIRO concluído (F1 + F2), 12 commits, gate typecheck+lint+build verde.**
- ✅ **F1** — SQL (funções+view) **validado em PG17 local** + **migration APLICADA em prod** (founder rodou: funcs=2/view=1/config=6 ✅). Front: hook + SlaBadge + selo no inbox + card Meu Dia (Minhas/Todas) + badge na sidebar + painel `/whatsapp/sla` (gestor/master).
- ✅ **F2** — digest diário (`20260604140000_whatsapp_sla_digest.sql`) **construído + testado em PG17** (idempotente: insere 1 alerta com vermelho, 2ª chamada não duplica). **Bug do plano corrigido** (o `order by` do corpo ordenava por constante → trocado pela severidade). ⭐ **Task 12 (dispatch-notifications) = ZERO edição de edge:** ele já manda `titulo`+`mensagem` genérico → o digest pré-renderiza o corpo. F2 virou só 1 migration.
- ✅ **Passe adversário do codex NO CÓDIGO** (gpt-5.5 xhigh) → 2 P1 + 8 P2. **Foldados 2 P1 + 4 P2** (re-testados em PG17): (P1) REVOKE no `whatsapp_sla_digest_tick` (qualquer logado podia marcar o dia no log e SUPRIMIR o digest); (P1) owner via **`wa_owner_efetivo` SECURITY DEFINER** (o `security_invoker` resolvia só a carteira visível ao leitor → falso "sem dono" pro gestor não-master); (P2) guarda de `wa_timestamp` futuro (cai pro `created_at`); (P2) tie-break determinístico `(anchor, created_at, id)`; (P2) acento no stop-keyword (translate, paridade c/ TS). **4 P2 disclosed como follow-up baixo:** cast de config frágil (input só-master), badge degrada silencioso (graceful), view scan-heavy (ok no volume v1), nome do CHECK (confirmado idêntico em prod).
- ⏳ **GATE founder:** (1) re-aplicar o **delta de hardening da F1** (BLOCO A — idempotente, re-cria stop-keyword/view + add `wa_owner_efetivo`); (2) aplicar a **F2** (BLOCO B, com pre-check `select distinct tipo`); (3) **Publish** + conferir no device. O cron dispara o e-mail às 18h (seg-sex).
- ⏸️ **Não-objetivos v1:** hardening de RLS do inbox, e-mail em tempo real, feriados, flag IA↔humano (o predicado de `sender_user_id` já protege).

## 8. PostHog → log de erro de produção por e-mail (NOVO, track 2, não iniciado)
> Pedido: capturar os erros que aparecem na tela em produção durante o uso e me mandar por e-mail pra eu tratar no Claude Code.
- ✅ **Viabilidade confirmada:** PostHog tem Error Tracking nativo (`captureException`) + alerta/inscrição por e-mail. Hoje o `ErrorBoundary` só faz `console.error`; o gancho de Sentry no `logger` está comentado; sem Sentry.
- 🧭 **A desenhar depois do WhatsApp SLA** (track menor): ligar `captureException` no `ErrorBoundary` + `window.onerror`/`unhandledrejection` → PostHog Error Tracking + alerta por e-mail. Alternativa Sentry = vendor novo, decisão de produto.

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete **#559 + #562 mergeados** + voz + frente 5 dos tingidores '04' + **WhatsApp SLA F1+F2 em prod ([PR #587](https://github.com/LucasSardenbergL/afiacao/pull/587))** + PostHog track 2).
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você:** (1) verificação visual da Fase 1 das Tarefas (libera o build da Fase 2) · (2) **revisão do spec / deploy da edge da criação por voz** · (3) **Publish do WhatsApp SLA + conferir no device** (backend já em prod) · (4) **query de diagnóstico do sinal '04'** (frente 5) · Publish no Lovable + SQL no SQL Editor conforme as frentes pedirem.
