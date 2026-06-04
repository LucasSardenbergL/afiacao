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
- ✅ **Build (#572) MERGEADO.** Edge `tarefa-extrair-voz` + helpers TDD (parser data, match cliente/vendedora, validação, montar-rascunhos) + `VozTarefaDialog` + wiring em `Tarefas.tsx`.
- ✅ **Polish (#583) MERGEADO:** empresa derivada do cliente (`empresaDeOmie`, fallback honesto, nas 2 entradas) + 2º ponto de entrada "🎙️ criar por voz" no **Customer 360** (`clienteFixo`).
- ✅ **Edge `tarefa-extrair-voz` deployada** (founder, chat do Lovable). ⏳ **Publish + QA** (microfone) pendentes.

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
- ✅ **Build (#577) MERGEADO.** Migration `route_queue_snapshot` + helpers TDD (`gating`, `agregar`) + snapshot on-open (`useSnapshotRouteQueue`) + `useRoutePanel` + página `RotaPainelLigacoes` + rota `/rota/ligacoes/painel` + link na `/rota/ligacoes`.
- ✅ **Gap acionável (#586) MERGEADO:** o gap de valor virou LISTA dos clientes valiosos sem contato (top 15: nome/cidade/vendedora/valor). `agregarPainel.gap_clientes` + `GapClientesCard`.
- ✅ **Migration `route_queue_snapshot` APLICADA** (founder, SQL Editor). ⏳ **`ALTER ADD cliente_nome`** (do #586) + **Publish + QA** pendentes (abrir `/rota/ligacoes` grava snapshot → `/rota/ligacoes/painel`).

## 7. SLA de resposta do WhatsApp — "cliente sem resposta" (NOVO, SHIPPADO)
> Pedido: indicador + alerta de quanto tempo um cliente está sem resposta no WhatsApp quando a conversa está sob comando humano, por vendedora dona; alerta pra mostrar pro pessoal.
- ✅ **Desenho → spec → plano → build (subagent-driven) → codex no design (6 P1) + adversarial no código (2 P1 + 4 P2) → SQL validado em PG17 → [PR #587](https://github.com/LucasSardenbergL/afiacao/pull/587) MERGED** (CI verde).
- ✅ **Backend em prod** (founder aplicou F1 endurecida + F2): função `whatsapp_minutos_uteis` + view `v_whatsapp_sla` (1ª msg não respondida · "respondido"=humano `sender_user_id` · dono AO VIVO da carteira via `wa_owner_efetivo` SECURITY DEFINER · expediente 07:30-17:30 config · limiares 15/30) + digest diário 18h idempotente → `fornecedor_alerta` → `dispatch-notifications` (SEM edge nova). Front: selo no inbox + card Meu Dia (Minhas/Todas) + badge na sidebar + painel `/whatsapp/sla`.
- ⏳ **Publish no Lovable** + conferir as 4 superfícies no device (única pendência).
- 🧭 **PostHog → erro de produção por e-mail (track 2)** — em desenho (o 2º pedido original do founder).

## 7. Incidente — alerta `reposicao_portal_pipeline: broken` (portal Sayerlack parado desde ~02/06)
> Alerta do Watchdog (04/06). Investigação read-only via `/investigate` (sem acesso a banco — queries coladas no SQL Editor pelo founder).
- ✅ **Causa-raiz (provada por ELIMINAÇÃO — 4 hipóteses refutadas com dado: preço/qtd inválido, fornecedor fora do filtro, trigger/policy, schema-cache):** o claim atômico da edge `enviar-pedido-portal-sayerlack` (`.update({status_envio_portal}).in('id',ids).or('…neq.enviando_portal').select('id')`, do #470) **quebra na camada PostgREST** com `42703 "column pedido_compra_sugerido.status_envio_portal does not exist"` — o banco está íntegro (o UPDATE idêntico escrito à mão = "UPDATE 1"), só o REST falha. Efeito: **nenhum** pedido Sayerlack ia ao portal desde ~02/06 (quando o claim do #470 foi deployado); o motor `sayerlack_retry_orfaos` re-disparava em loop (pedido nunca progredia → reaparecia no check → `broken`). 324/325 eram os visíveis.
- ✅ **Fix — claim em SQL puro ([PR #592](https://github.com/LucasSardenbergL/afiacao/pull/592)):** RPC `envio_portal_claim_ids(p_ids)` (migration `20260604150000`, SECURITY DEFINER, gate espelhando `envio_portal_lock_candidatos`, atomicidade anti-duplo-envio preservada sob READ COMMITTED) + a edge troca os 2 claims (async + sync legado) por `.rpc()`. Validação: teste SQL local PG17 com 6 asserts (`db/test-envio-portal-claim-ids.sh`) + **codex challenge "sólido, sem P1/P2"** + CI local verde (lint 0 errors / typecheck / 2186 testes / build).
- ⏳ **Apply (founder, após merge):** colar a migration `20260604150000` no SQL Editor + redeploy de `enviar-pedido-portal-sayerlack` via chat do Lovable → o motor re-dispara 324/325 → vão ao portal → alerta some. Confirmar **por comportamento** (a resposta da edge sai de "Falha ao reservar pedidos" / `falhas:1`).
- 🧭 **Follow-up:** os 324/325 estão aprovados há 2 dias — confirmar que ainda são compras desejadas (senão cancelar pela tela). E investigar se outros caminhos do app usam `.or()` em UPDATE via PostgREST (mesma classe de bug).

## 8. "Buddy" (inspirado na UPOPS/PMBuddy do Itaú) — Crítica da Fila v1 (SHIPPADO)
> Pedido: "como copiar a UPOPS do Itaú a nosso favor?" Discutido com o codex (consult salvo em `.context/codex-session-id`). Reframe: já somos o OS consolidado → o transferível NÃO é chat (teatro p/ <20 users, morre em 60d no 1º erro factual), é **"contradição com evidência"** (a fila diz X, os sinais do cliente dizem Y; aja aqui). 1º Buddy = **VendedoraBuddy** (loop mensurável); v1 **determinístico-puro** (sem LLM → sem custo, sem alucinação no money-path). GestorBuddy (brief de exceção) sai depois, do **mesmo** motor.
- ✅ **Estratégia (eu+codex) → spec → plano → build (subagent-driven) → revisão em 2 etapas (conformidade ✅ + qualidade ✅, opus) + 2 fixes P3 → [PR #585](https://github.com/LucasSardenbergL/afiacao/pull/585) MERGED** (CI verde; mergeado com o #580 G1-Fase-2 e o #584 G2 — `PorQueAgora` convive com `AcaoOutcomeMenu` + empty-state com fallback).
- ✅ **Entregue:** bloco **"Por que agora"** nos top-5 cards do Meu Dia — timeline de fricção + **4 badges de contradição determinísticos** (`recorrente_sumiu`/`sem_resposta_repetido`/`tarefa_feita_sem_prova`/`alto_valor_fora_rota`) + feedback (PostHog `fila.critica_shown/opened/acted/feedback`). **100% frontend, zero backend** (`customer_metrics_mv` client-readable; thresholds reusam o `useAiOps`). Motor puro TDD em `src/lib/fila/critica/` + hook `useCriticaFila` + `PorQueAgora`. WhatsApp-voz adiado (bug de pendentes). Specs/planos `docs/superpowers/{specs,plans}/2026-06-04-critica-da-fila*`.
- ⏳ **Publish + piloto de 2 semanas** (critério de morte na spec §8). Calibrar `altoValorFat90dMin` (R$5.000) / `altoValorDiasQuietoMin` (45d) com dado real. Provider do LLM no v1.5 = **Anthropic**.

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete a sessão: #559/#562/#572/#577/#583/#586 mergeados + a frente 5 dos tingidores '04').
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você (consolidado):** **1 Publish** no Lovable (leva voz #572, voz-polish #583, painel #577, gap #586, **a Crítica da Fila #585 [§8]** e a Fase 1) · SQL Editor: **`ALTER ... ADD COLUMN cliente_nome`** (do #586) — a `route_queue_snapshot` já foi aplicada · **verificação visual da Fase 1** das Tarefas (libera o build da **Fase 2**) · **QA** (criar por voz no microfone; painel em `/rota/ligacoes/painel`; **Crítica da Fila no Meu Dia da vendedora**) · **iniciar o piloto de 2 semanas da Crítica da Fila** (calibrar limiares com dado real) · [frente 5 '04', sessão paralela] Checkpoint B (M2a/M2b).
