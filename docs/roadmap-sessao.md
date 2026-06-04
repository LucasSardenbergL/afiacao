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

## 7. Reposição — pedido órfão (R$0/sem fornecedor) na fila + 2 telas redundantes
> Founder, em `/admin/reposicao/sessao/pedidos`, perguntou: (1) por que há "Pendente" sem fornecedor / 3 SKUs / R$ 0,00; (2) por que a coluna "quem aprovou" se só ele aprova; (3) por que duas telas de pedido, uma parecendo redundante. Investiguei o código + consultei o Codex.
- ✅ **Diagnóstico de código + 3 queries em prod (CAUSA-RAIZ CONFIRMADA):**
  - **(1) Pedido órfão = CABEÇALHO FANTASMA SEM ITENS (bug da RPC).** As 3 queries provaram: os pedidos `(SEM FORNECEDOR)` têm **`itens_reais = 0`** mas `num_skus_header = 3` (ou 2/21/22) — cabeçalho criado, zero linhas em `pedido_compra_item`. **Bug:** na RPC `gerar_pedidos_sugeridos_ciclo` (`20260530143818`), o 1º INSERT (cabeçalho) usa `GROUP BY ... fornecedor_nome` (agrupa NULLs num grupo → cria o pedido com `COUNT(*)`), mas o 2º INSERT (itens) faz `JOIN ON pfg.fornecedor_nome = sn.fornecedor_nome` (linhas 147-148) **sem COALESCE** → `NULL = NULL` é falso → **nenhum item inserido** (o `grupo_codigo` ao lado TEM `COALESCE(...,'')`; o `fornecedor_nome` foi esquecido). Causa de fundo: a CTE `skus_necessitando` **não filtra fornecedor nulo**. ~19 fantasmas em 14 dias, 1-2/ciclo, viram `expirado_sem_aprovacao`. **Falso-negativo JÁ ATIVO:** SKU sem fornecedor habilitado NUNCA vira compra (nasce vazio). O caso 2-SKUs-RENNER (pedido 268, `cancelado`) é separado/pontual (primeira compra com cmc atrasado; já resolvido, ignorar).
  - **(2) Coluna "Aprovado em/Por"** (`PedidoRow.tsx:63`): grava email do aprovador; design multi-aprovador; como só o founder aprova, "Por" é redundante. Trivial esconder.
  - **(3) Redundância** (`CicloHojePanel.tsx:144`): a etapa 3 do Cockpit renderiza a tabela própria (revisão/aprovação em lote) **E embute `AdminReposicaoPedidos` inteira** logo abaixo (operação item-a-item: disparar/portal/cancelar/ciclos/geração manual). Duas tabelas do mesmo ciclo. A tela antiga nem está na sidebar.
- ✅ **Codex consult (sequência + risco):** default = **conserto de DADOS** (não tocar a RPC money-path); só ir pra RPC se for padrão recorrente, e aí preferir **alerta de "cadastro incompleto"** a sumir o SKU silenciosamente (não esconder demanda real). Redundância = **plano dedicado**, não unificar no impulso; se unificar, a operacional sobrevive e extrai-se componentes (nada de "página dentro de página"); risco de regressão no disparo/portal/Omie.
- ✅ **Fase 1 — DIAGNÓSTICO CONCLUÍDO (3 queries em prod):** os 3 SKUs do fantasma = `8803974155` WASH PRIMER VINÍLICO 600ML, `12024868656` SERRA P/MADEIRA 300mmX36Z FEPAM, `12024869234` SERRA P/MADEIRA 300mmX48Z INDFEMA (ativos, habilitados, abaixo do ponto, sem fornecedor — batem com o "3 SKUs" da tela). +4 inativos sem fornecedor (RPC já exclui por `omie_ativo=false`). **Universo: ~82 SKUs OBEN habilitados na reposição automática SEM fornecedor** (cadastro furado em escala; bomba-relógio). **Decisões do founder (AskUserQuestion):** (1) compra os 3 → cadastrar fornecedor; (2) limpar + **blindar a RPC**.
- 🔄 **Fase 2 — conserto (ordem: blindar primeiro mata o fantasma de TODOS):**
  1. ✅ **Blindar a RPC** — migration `20260604170000_reposicao_blindar_sku_sem_fornecedor.sql`: `+ AND sp.fornecedor_nome IS NOT NULL AND btrim(sp.fornecedor_nome) <> ''` na CTE (corpo VERBATIM da `20260604140000` + 2 linhas). **Validado em PG17 local** (`/tmp/.../test-blindagem-rpc.sh`): ANTES 1 fantasma → DEPOIS 0; SKU c/ fornecedor segue gerando pedido c/ item; SKU sem fornecedor cai na view. **Codex challenge: SEM P1** (corpo confirmado verbatim por diff; P2s são só observabilidade).
  2. ✅ **Alerta visível** — view `v_reposicao_sku_sem_fornecedor` **APLICADA EM PROD** (lista os 3 SKUs ✅) + **banner em `AdminReposicaoPedidos.tsx`** (typecheck/lint ✅; aguarda PR+Publish). Fecha o P2 do Codex.
  3. ✅ **Limpar fantasmas existentes (em prod)** — BLOCO B aplicado: regenerou o ciclo de hoje sem fantasma + DELETE dos ativos. **Fila de hoje LIMPA** (0 fantasma ativo, 0 de hoje). Restam 8 `cancelado_humano` de mai (cabeçalhos vazios já cancelados, histórico inofensivo — limpeza opcional).
  4. ⏳ **Cadastrar fornecedor dos 3** — guiado pelo alerta, com calma (FEPAM/INDFEMA/primer; precisa estar em `fornecedor_habilitado_reposicao`).
  - ⏳ **PR do código** (migration `20260604170000` + UI banner + roadmap) → merge → **Publish** (pro banner aparecer). Aguardando OK do founder pra commitar/pushar.
- ✅ **Em produção (SQL aplicado pelo founder):** RPC blindada (rpc=1) + view de alerta (lista 3) + fila limpa. **NÃO nasce mais cabeçalho-fantasma.**
  - 📌 **Follow-ups do Codex challenge (não-bloqueantes):** (a) check Sentinela `reposicao_sugestoes` mede `max(data_ciclo)` — o fantasma mascarava dias sem pedido; sem ele, dia sem pedido real >3d vira falso-stale → trocar p/ log de execução do cron (mexe no `_data_health_compute` quente); (b) view diverge da CTE (sem `em_transito`, `op` account-aware) = alerta impreciso, não quebra geração; (c) `btrim` não pega tab/NBSP (dado já é "sem fornecedor"); (d) edge "fornecedor preenchido mas NÃO habilitado em `fornecedor_habilitado_reposicao`" → pedido com `horario_corte_planejado` NULL (caso distinto, fora de escopo); (e) alerta no e-mail/Sentinela (proativo) = follow-up.
- ⏳ **Fase 3 — esconder coluna "Por"** (UI trivial, opcional, separado do money-path).
- ⏸️ **Fase 4 — unificar as 2 telas** (plano dedicado; superfície grande, encosta em disparo/portal/Omie). Adiado.

---

### Encerramento da sessão (housekeeping recorrente)
- Manter este roadmap atualizado a cada mudança (reflete a sessão: #559/#562/#572/#577/#583/#586 mergeados + a frente 5 dos tingidores '04').
- PRs de doc/fix abertos com auto-merge quando o CI passar.
- **O que depende de você (consolidado):** **1 Publish** no Lovable (leva voz #572, voz-polish #583, painel #577, gap #586 e a Fase 1) · SQL Editor: **`ALTER ... ADD COLUMN cliente_nome`** (do #586) — a `route_queue_snapshot` já foi aplicada · **verificação visual da Fase 1** das Tarefas (libera o build da **Fase 2**) · **QA** (criar por voz no microfone; painel em `/rota/ligacoes/painel`) · [frente 5 '04', sessão paralela] Checkpoint B (M2a/M2b).
