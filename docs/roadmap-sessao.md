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
- ✅ **PR1 (fundação) — código pronto no worktree, validado** (helper TDD 4/4 · ESLint 0 · typecheck 0 · deno net-zero): Task 1 helper `src/lib/reposicao/tipo-produto.ts` · Task 2 Migration 1 (`20260604130000`, coluna `omie_products.tipo_produto` + trigger anti-null-clobber) · Task 3 `omie-sync-metadados` vira writer autoritativo (lê `tipoItem`, grava a coluna, métricas) · Task 4 `omie-vendas-sync` para de gravar o sinal no metadata · Task 0 fix de UI da fila.
- 🧭 **Estratégia 2 PRs** (deploy-pós-merge + anti-cascata): PR1 = fundação (acima); PR2 = consumidores (M2: RPC/cold-start/vigia lendo a coluna + fail-closed + fix account-blind + vigia de cobertura) + frontend `submitOrder`. PR2 escrito **após** o founder me passar os corpos VIVOS da RPC/`_data_health_compute` (Checkpoint A) p/ não cascatear.
- ⏳ **Checkpoint A (founder, após mergear PR1):** aplicar Migration 1 (SQL Editor) → deploy `omie-sync-metadados`+`omie-vendas-sync` (chat Lovable) → full sync OBEN+Colacor → medir baseline (`tipo04>0`) → me passar `pg_get_functiondef` da RPC + `_data_health_compute` + viewdef do cold-start. Contenção: query "vazou fabricado?" entregue.
- ⏳ **PR2 + Checkpoint B** — aplicar M2 → regenerar ciclo OBEN → validar verde-verdade.

## 6. Painel das ligações da rota (capacidade × eficácia)
> Pergunta do founder: "automatizar mais (WhatsApp) vs contratar mais vendedora?" — respondida com dado do closed-loop existente.
- ✅ **Spec escrito + endurecido com passe adversário do codex.** Decisões centrais: snapshot on-open da fila (denominador); valor = `status='convertido'` + `valor_da_ligacao` (rotulado "valor esperado, não R$ realizado"); cortes por vendedora/bucket/canal; gating n≥30 + banner "direcional". Spec: `docs/superpowers/specs/2026-06-04-painel-ligacoes-rota-design.md`.
- ✅ **Plano escrito.** Plano: `docs/superpowers/plans/2026-06-04-painel-ligacoes-rota.md`.
- ✅ **Build concluído (PR #577).** Migration `route_queue_snapshot` + helpers TDD (`gating`, `agregar`) + snapshot on-open (`useSnapshotRouteQueue`) + `useRoutePanel` + página `RotaPainelLigacoes` + rota `/rota/ligacoes/painel` + link na `/rota/ligacoes`. CI passou (typecheck strict ✅ / 2186/2186 testes ✅ / lint 0 errors ✅ / build ✅).
- ⏳ **Migration `route_queue_snapshot` no SQL Editor + Publish + QA** (após merge). Colar o SQL (`20260604120000_route_queue_snapshot.sql`) no SQL Editor do Lovable → confirmar a tabela criada → Publish → QA: abrir `/rota/ligacoes` (grava snapshot) → registrar ligações → abrir `/rota/ligacoes/painel`.

## 7. Incidente — alerta `reposicao_portal_pipeline: broken` (portal Sayerlack parado desde ~02/06)
> Alerta do Watchdog (04/06). Investigação read-only via `/investigate` (sem acesso a banco — queries coladas no SQL Editor pelo founder).
- ✅ **Causa-raiz (provada por ELIMINAÇÃO — 4 hipóteses refutadas com dado: preço/qtd inválido, fornecedor fora do filtro, trigger/policy, schema-cache):** o claim atômico da edge `enviar-pedido-portal-sayerlack` (`.update({status_envio_portal}).in('id',ids).or('…neq.enviando_portal').select('id')`, do #470) **quebra na camada PostgREST** com `42703 "column pedido_compra_sugerido.status_envio_portal does not exist"` — o banco está íntegro (o UPDATE idêntico escrito à mão = "UPDATE 1"), só o REST falha. Efeito: **nenhum** pedido Sayerlack ia ao portal desde ~02/06 (quando o claim do #470 foi deployado); o motor `sayerlack_retry_orfaos` re-disparava em loop (pedido nunca progredia → reaparecia no check → `broken`). 324/325 eram os visíveis.
- ✅ **Fix — claim em SQL puro (PR a abrir):** RPC `envio_portal_claim_ids(p_ids)` (migration `20260604150000`, SECURITY DEFINER, gate espelhando `envio_portal_lock_candidatos`, atomicidade anti-duplo-envio preservada sob READ COMMITTED) + a edge troca os 2 claims (async + sync legado) por `.rpc()`. Validação: teste SQL local PG17 com 6 asserts (`db/test-envio-portal-claim-ids.sh`) + **codex challenge "sólido, sem P1/P2"** + CI local verde (lint 0 errors / typecheck / 2186 testes / build).
- ⏳ **Apply (founder, após merge):** colar a migration `20260604150000` no SQL Editor + redeploy de `enviar-pedido-portal-sayerlack` via chat do Lovable → o motor re-dispara 324/325 → vão ao portal → alerta some. Confirmar **por comportamento** (a resposta da edge sai de "Falha ao reservar pedidos" / `falhas:1`).
- 🧭 **Follow-up:** os 324/325 estão aprovados há 2 dias — confirmar que ainda são compras desejadas (senão cancelar pela tela). E investigar se outros caminhos do app usam `.or()` em UPDATE via PostgREST (mesma classe de bug).

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete **#559 + #562 mergeados** + a feature de voz acrescentada + a frente 5 dos tingidores '04').
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você:** (1) verificação visual da Fase 1 (libera o build da Fase 2) · (2) **revisão do spec da criação por voz** (libera o plano) · (3) **rodar a query de diagnóstico do sinal '04'** (frente 5) · Publish no Lovable pro preview · SQL no SQL Editor quando houver migration (Fase 2 e a feature de voz terão).
