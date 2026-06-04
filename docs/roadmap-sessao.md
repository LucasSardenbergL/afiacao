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

## 7. Inativação de SKU — durabilidade do giro + embalagem econômica (QT/GL)
> Pergunta do founder: ao inativar um item, transpor o histórico de giro pro sucessor — **onde** se faz isso? Achado: existe a tela de Substituição (Reposição → Aplicação Omie → "Item inativo"), mas "Transferir" só copia **parâmetros**, não o giro.
- ✅ **Item 1 — durabilidade do "Transferir" (investigação).** É **band-aid**: `omie-cron-diario` chama `atualizar_parametros_numericos_skus` **diário**, recalculando min/PP/máx a partir de `venda_items_history` (90d, por `sku_codigo_omie`); o Transferir some quando o sucessor começa a vender. Causa-raiz: o motor não tem noção de equivalência entre SKUs.
- 🔄 **Item 2 — pivô para multi-embalagem econômica (QT/GL).** Founder priorizou um caso adjacente de maior retorno: comprar a embalagem mais barata por unidade-equivalente (concentrados Sayerlack WP; 1 GL = 4 QT).
  - ✅ Brainstorming + consult Codex (gpt-5.5) + spec + self-review → `docs/superpowers/specs/2026-06-04-embalagem-economica-design.md` (**aprovado pelo founder**).
  - ✅ **Plano de implementação escrito** → `docs/superpowers/plans/2026-06-04-embalagem-economica.md` (6 tasks TDD).
  - ✅ **v1 (build) CONSTRUÍDA** (subagent-driven): migration (2 tabelas + kill-switch) · helper `embalagem-helpers.ts` (12 testes) · hook `useEmbalagemPedido` · painel "Embalagem" no `DetalhesModal` + dialog de preço manual. **typecheck/lint(0 err)/build/2254 testes verdes.** Auto-review pegou 2 fixes (economia coerente + guard grupo-de-1). ⚠️ **Codex review externo pendente** (limite de uso do Plus; reseta ~19:55).
  - 🧭 **Pendências do founder p/ ir ao ar:** (1) aplicar a migration no **SQL Editor do Lovable** (`20260604182408_embalagem_economica.sql`); (2) merge do PR; (3) cadastrar os ~12 pares QT/GL em `sku_embalagem_equivalencia`; (4) **Publish** no Lovable.
  - ⏸️ Fase 1.5 spike (viabilidade do scraping) · Fase 2 captura automática · Fase 3 refino (lote mínimo, badge, histórico).
- ⏸️ **Sucessão de giro (item 2 original)** — adiado; reusa a fundação de equivalência (vínculo **temporal**, fator ~1, demanda transposta de fato).

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete a sessão: #559/#562/#572/#577/#583/#586 mergeados + a frente 5 dos tingidores '04').
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você (consolidado):** **1 Publish** no Lovable (leva voz #572, voz-polish #583, painel #577, gap #586 e a Fase 1) · SQL Editor: **`ALTER ... ADD COLUMN cliente_nome`** (do #586) — a `route_queue_snapshot` já foi aplicada · **verificação visual da Fase 1** das Tarefas (libera o build da **Fase 2**) · **QA** (criar por voz no microfone; painel em `/rota/ligacoes/painel`) · [frente 5 '04', sessão paralela] Checkpoint B (M2a/M2b).
