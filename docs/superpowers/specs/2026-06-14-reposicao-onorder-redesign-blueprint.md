# Reposição "a caminho" (on-order) — BLUEPRINT do redesign single-source

**Data:** 2026-06-14 · **Escopo:** OBEN (money-path) · **Status:** projeto FUTURO (não iniciado) · **Origem:** consulta de design ao Codex (gpt-5.5 xhigh, 2026-06-13; log integral em `/tmp/codex-perf-fix.log` na sessão).

## Por que existe este doc
A 1ª tentativa de single-source (PR #809, "Opção A endurecida": `estoque_pendente_entrada` OBEN = Σ saldo das POs abertas APROVADAS do Omie, paginando até a página vazia, sem janela de data) passou 11 rounds de Codex e o gate (round 11 = LIBERAR), MAS **não completa o full sync na janela ~400s de wall-clock do edge do Supabase** (varre todas as POs de OBEN desde 2010 com 1,1s/página, sem cursor). Tentado regs 50→200 → não bastou. **Revertido pro #752** (estado bom-conhecido) em 2026-06-14 (edges `omie-sync-estoque`/`disparar-pedidos-aprovados`/`gerar-pedidos-diario` → #752/#743/#711; migrations `195000`/`220000` ficam DORMENTES; motor `200000` e Sentinela `210000` NÃO aplicados). Este doc é a blueprint pra construir a versão correta quando priorizado.

## ⚡ ATUALIZAÇÃO 2026-06-14 — consulta Codex (xhigh) pós-investigação do worker: ARQUITETURA PIVOTADA
Confirmado que não há worker >400s, consultei o Codex sobre o caminho. 4 achados:

**Q1 — filtro server-side por etapa NÃO dissolve o problema.** O Omie filtra PO só por CATEGORIA operacional (`Pendentes`, `Faturados`, `Recebidos parcialmente`, `Faturados parcialmente`, `Recebidos`, `Cancelados`, `Encerrados`) — NÃO por `cEtapa=15` nem por saldo>0. Esses filtros JÁ eram enviados pelo #752 e pelo #809. Saldo>0 se espalha por ~4 categorias e `cEtapa` é customizável por conta → não dá pra encolher o universo a "dezenas" com um filtro só. (`ListarPedidosCompra`/`ListarPedComprasResumido` não existem no Omie; o método é `PesquisarPedCompra`.)

**Q2 — a arquitetura certa NÃO é "scan diário", é RÉPLICA INCREMENTAL por-PO.** Cursor por offset sobre lista mutável continua PROIBIDO (não prova não-omissão). Manter uma **réplica PERMANENTE por `nCodPed`** (`reposicao_po`/`reposicao_po_item`) atualizada in-place por 3 caminhos:
  1. **App fast-path:** após `IncluirPedCompra` (o app cria PO), `ConsultarPedCompra` + atualiza SÓ aquela PO.
  2. **Webhook fast-path (UNLOCK):** o Omie **já manda** webhooks de PO (`CompraProduto.Incluida/Alterada/EtapaAlterada/Cancelada/Encerrada/Excluida`) pro `supabase/functions/omie-webhook/index.ts` — mas **o processamento está `TODO`** (~linha 142; eventos chegam e não são processados). Fix: webhook só PERSISTE o evento; cron curto drena `omie_webhook_events` pendentes + `ConsultarPedCompra` por evento (NÃO depender de `waitUntil`).
  3. **Reconciliação periódica (backstop):** varredura por janelas de data com TODOS os 7 estados habilitados (não só abertas — assim fechar/receber NÃO remove linha nem desloca offset). NUNCA remover uma PO porque "sumiu" de uma listagem; só zerar após `ConsultarPedCompra` confirmar estado terminal.
  Pendente = derivado da réplica. Scan histórico particionado = só BOOTSTRAP/auditoria, não recompute diário. Antes do apply agregado, `ConsultarPedCompra` individual de TODAS as POs que a réplica julga abertas; qualquer falha BLOQUEIA.
  ⚠️ **Limite honesto (Codex):** sem contrato confiável de webhook OU keyset OU snapshot, é **matematicamente impossível** provar descoberta imediata de toda PO manual nova usando só paginação offset mutável. A garantia ESTRITA exige **validar a entrega dos webhooks** OU **proibir criação de PO fora do fluxo controlado**. → próximo passo de investigação: checar se os webhooks de PO do Omie estão de fato chegando em `omie_webhook_events`.

**Q3 — sonda da semântica de data.** Action read-only `probe_pedcompra` (zero writes): por POs conhecidas, janelas de 1 dia em `dIncData` (emissão) × `dDtPrevisao` (entrega) × janela de alteração, cada uma com `lApenasAlterados` false/true, 7 estados, D-1/D/D+1 pra inclusividade, retorna params + `nTotalRegistros` + IDs. Doc só confirma que `lApenasAlterados=true` usa o período de ALTERAÇÃO; no modo normal, **tratar a data como NÃO-confiável** até a sonda. A arquitetura não deve depender só dela.

**Q4 — ⛔ CORREÇÃO CRÍTICA: o "físico-first" deste blueprint estava ERRADO (money-path).** Ler físico ANTES + saldo DEPOIS, com um recebimento no meio, dá físico-baixo + saldo-baixo = **SUBESTIMA → COMPRA DUPLA** (o incidente). O certo INVERTE: **pendente/saldo PRIMEIRO, físico POR ÚLTIMO** → recebimento no meio vira físico-alto + saldo-alto = **SUPERESTIMA → ruptura (seguro)**. (Verificado numericamente: recebimento move Q de saldo→físico; saldo-antes + físico-depois conta Q 2× = overcount seguro.) Ordem de finalização: (1) drenar eventos → (2) `ConsultarPedCompra` das abertas → (3) derivar pendente → (4) **ler físico POR ÚLTIMO** → (5) apply atômico físico+pendente+markers. A subseção de ordem de leitura abaixo foi CORRIGIDA conforme isto.

**Modelo simplificado:** réplica PERMANENTE `reposicao_po`/`reposicao_po_item`; tabelas de geração só pra bootstrap/reconciliação; ponteiro `run_id` só pro snapshot AGREGADO completo consumido pelo motor/UI. Fonte: https://app.omie.com.br/api/v1/produtos/pedidocompra/

### ✅ DECISÃO DE PROCESSO (founder, 2026-06-14): EXISTE PO MANUAL no Omie
Confirmado pelo founder: pedidos de compra são criados/editados **direto no painel do Omie**, fora do app. Somado à **queda silenciosa de 5 semanas dos webhooks** (192 eventos 18/04→09/05, mudos desde — diagnóstico em `omie_webhook_events`), isso TRAVA a arquitetura:
- **A RECONCILIAÇÃO PERIÓDICA é a GARANTIA de correção** — é o único caminho que enxerga PO manual E cobre buraco de webhook. NÃO é opcional/backstop secundário: é a fonte-da-verdade.
- **Webhook fast-path** (corrigir a queda de 09/05 + ligar o processamento `TODO` do `omie-webhook`) e **app fast-path/bump** (#743) são só ACELERADORES de frescor entre reconciliações — NUNCA a garantia (o webhook já provou que cai mudo; o bump só vê PO do app).
- → caminho **MÉDIO** (reconciliação obrigatória). **GATE do próximo passo = sonda da semântica de data** (Q3): sem saber o que `dDataInicial/dDataFinal` filtra, não dá pra particionar a reconciliação por janela com segurança no money-path.
- **Plano sequenciado:** `docs/superpowers/plans/2026-06-14-reposicao-onorder-redesign-plano.md`.

## ⚠️ INVARIANTE-MESTRA (Codex corrigiu — eu tinha invertido)
- **`pendente` SUBESTIMADO → COMPRA DUPLA** (o motor não vê o que está vindo → recompra) = **exatamente o incidente FUNDO PU**.
- **`pendente` SUPERESTIMADO → RUPTURA** (subcompra).
- → **NUNCA subestimar o pendente.** Snapshot PARCIAL ou PO OMITIDA = subestima = compra dupla. Fail-closed (não-completar = não-gravar = motor segue dado velho) é aceitável; gravar incompleto NÃO é.

## Por que os atalhos NÃO servem (Codex rejeitou)
- **Cursor por offset ingênuo (`next_page` + `porSku` acumulado):** paginação por offset MUTÁVEL pode OMITIR uma PO sem gerar repetição detectável (ex.: lê A,B; A fecha; pág 2 retorna D,E omitindo C). "Página vazia no último run" NÃO prova que o conjunto ficou completo. → subestima → compra dupla.
- **Janela de data pura (cortar p/ 24/36 meses):** a doc do Omie é AMBÍGUA sobre `dDataInicial` (`dIncData`=inclusão, `dDtPrevisao`=previsão de entrega, mas `dDataInicial` é só "a partir desta data" — não prova qual campo filtra no modo normal). Cortar pode excluir PO aberta antiga → subestima → compra dupla. **NÃO entra no money-path sem confirmação.** (FUNDO PU=3 é evidência FORTE contra "filtro por previsão" — a previsão 19/06 estaria fora de `dDataFinal=amanhã` — mas não prova que seja emissão.)
- `EdgeRuntime.waitUntil` **não** resolve: background também obedece os ~400s da plataforma.

## A ARQUITETURA recomendada (Codex)
Omie continua **fonte única da quantidade**; o banco guarda uma **réplica materializada por PO (`nCodPed`)** — não uma 2ª fonte. Reconciliação completa + snapshot por-SKU aplicado **só no fim, atomicamente**.

### ⚙️ Investigação do worker >400s — CONCLUÍDA (2026-06-14, pesquisa nas docs atuais do Supabase)
**Resultado: NÃO existe compute >400s no stack.** Edge Function = **400s wall-clock (pago) / 150s (free)**; `EdgeRuntime.waitUntil` herda o MESMO teto; não há tier/config que estenda; o Lovable Cloud não adiciona compute longo próprio. `pg_net` é **fire-and-forget** (não faz paginação dependente N→N+1 dentro de um job — a resposta cai async em `net._http_responses`); `pg_cron` só agenda SQL. `pgmq` existe mas serve fan-out de tarefas PRÉ-enumeradas, não paginação contínua de um endpoint.
→ **A opção 1 (worker longo) está FORA.** O caminho é a **opção 2: cursor + reinvocação por `pg_cron`** (a edge processa UMA fatia por invocação, grava o cursor, e o cron `*/5`–`*/10` reinvoca enquanto `next_page IS NOT NULL`). ⭐ **O stack JÁ TEM esse padrão em produção e cicatrizado por incidentes:** `fin_sync_cursor` + `omie-financeiro` actions `sync_contas_*` (retomam de `next_page`, orçam `TIME_BUDGET_MS` ~100s) + cron `fin-sync-continuacao-10min`. Reusar esse template é o de menor risco.
⚠️ **MAS o cursor NÃO pode ser offset-por-página ingênuo sobre a lista MUTÁVEL de POs abertas** — é exatamente o que o Codex rejeitou: PO que fecha no meio desloca as páginas → OMITE outra PO → subestima → **compra dupla**. A robustez vem de **janelas de data COMPLETAS** (cada janela varrida start-to-finish numa ÚNICA invocação, dimensionada p/ caber em ~80–100s) — daí a opção 2 ser "particionada por data", não "offset contínuo". Isso **reativa a confirmação da semântica da data do Omie (seção abaixo) como o PRÓXIMO passo concreto do redesign** (gate de qualquer particionamento por data no money-path).
**Obrigatórios herdados do codebase (não re-descobrir):** `timeout_milliseconds:=150000` no cron (default 5s mata silencioso e o `job_run_details` mente "succeeded"); advisory lock no início da edge (tick concorrente sai sem re-buscar a mesma página); paginar até a página VAZIA (nunca confiar no `total_de_paginas`/`nTotalPaginas` do Omie — lição #426; o 100/página é o teto real); retry/backoff no `callOmie` (o Omie flaka — broken response/soap-error); log estilo `fin_sync_log` pro Sentinela vigiar órfã `running`; UI lê só o último run COMPLETO via ponteiro `run_id` (padrão `v_clientes_nao_vinculados_atual`).

### Ordem de preferência
1. ~~**Melhor:** worker LONGO (>400s) com varredura única.~~ **DESCARTADA (2026-06-14):** não há compute >400s no stack (ver investigação acima). Restam só as opções 2 e 3.
2. **Ficando em Edge:** **geração persistente por PO, particionada em janelas de data COMPLETAS** (varre 2010→hoje em fatias pequenas o bastante p/ cada fatia terminar numa invocação; acumula por-PO; SEM cortar histórico).
3. **C (só otimização):** reduzir o sleep 1,1s — adaptativo + instrumentado (medir latência/tamanho de página/429 antes; o 60s de 429 está no `callOmie` do estoque, não no `callOmiePedidos`).

### Modelo de estado (staging por geração)
- `reposicao_po_scan`: `generation_id`, `run_id` (fixo da geração), `status`, `started_at`, filtros CONGELADOS, cursor/bucket atual, `lease_token`, `lease_expires_at`, contadores, erro.
- `reposicao_po_scan_fisico`: físico T1 por SKU daquela geração (lido + persistido no INÍCIO).
- `reposicao_po_scan_pedidos`: 1 linha por `generation_id + nCodPed`.
- `reposicao_po_scan_itens`: itens normalizados por PO/SKU.
- `reposicao_po_scan_paginas`: página, digest, IDs retornados, ts.
- (NÃO guardar milhares de IDs/agregados em `sync_state.metadata`.)

### RPC por página (transacional)
1. valida `generation_id` + cursor esperado + `lease_token`; 2. substitui INTEGRALMENTE os dados das POs daquela página; 3. grava digest da página; 4. avança o cursor (mesma tx); 5. replay c/ mesmo digest = no-op; digest diferente INVALIDA a geração.
**Acumular por PO, não por SKU** — se uma PO reaparecer alterada, o agregado por SKU não permite desfazer a contribuição anterior.

### Ordem de leitura: pendente PRIMEIRO, físico POR ÚLTIMO ⛔ (CORRIGIDO 2026-06-14 — antes dizia "físico-first", que estava INVERTIDO)
Derivar o **pendente (saldo das POs) PRIMEIRO** e ler o **físico POR ÚLTIMO**, no apply atômico. Razão (money-path): um recebimento move qty de saldo→físico; se ler físico ANTES e saldo DEPOIS, ambos saem baixos → **SUBESTIMA → COMPRA DUPLA**. Com saldo-antes + físico-depois, um recebimento no meio é contado 2× → **SUPERESTIMA → ruptura (seguro)**. Geração que excede idade-limite (60–90min) → DESCARTA + reinicia.

### RPC final (apply)
Valida todas as partições + página vazia + zero `problemas` + idade máxima → deriva `porSku` das staging → aplica físico + pendente + **os 2 markers na MESMA transação** → marca a geração aplicada. (Mais forte que o fluxo atual, que grava físico e pendente separadamente e depende do marker pra bloquear o motor — `index.ts:631` da versão #809.)

### Claim (reformular)
Separar: geração LONGA (run_id fixo) + lease CURTO por invocação + fencing token monotônico + continuação FREQUENTE (não só cron 2h) + watchdog por idade da geração e falta de progresso. O claim atual (`20260611220000`) NÃO serve: re-claim substitui `run_id`/metadata.

### Bump pós-disparo (fast-path)
Usar **`ConsultarPedCompra(cCodIntPed)`** pra atualizar SÓ a PO recém-criada (a API aceita `cCodIntPed`) — NÃO revarrer milhares. O modo `only_pending` atual FAZ a varredura completa → mesmo timeout (× tentativas `esperar_codints`).

## Como confirmar a semântica da data (sem chutar)
1. Selecione POs conhecidas com criação e previsão em datas BEM diferentes; 2. chamadas read-only com janelas de 1 dia ao redor de cada data; 3. repita com `lApenasAlterados=false` e `true`; 4. teste limites inclusivos + POs antigas alteradas recentemente; 5. confirme com várias POs + peça confirmação ESCRITA ao suporte Omie.

## Outros furos a fechar (Codex)
- `aplicar_snapshot_pendente` aceita o mesmo `run_id` de novo → deveria exigir `generation_id + payload_hash` (replay idêntico = no-op; payload diferente = rejeita).
- Mudança na lista de SKUs habilitados no meio da geração → restart ou hash do contrato.
- Marker `syncing` renovado indefinidamente parece saudável → vigiar `started_at`, não só heartbeat.

## Rollout sugerido
(1) worker longo mantendo a semântica atual [se disponível]; (2) réplica por-PO + fast-path `ConsultarPedCompra`; (3) só então particionamento por data. **B puro NÃO entra no money-path.**

## Estado das limitações do #752 (a versão revertida, em prod)
O #752 É bom-conhecido mas tem furos próprios: varredura para no `nTotalPaginas` (que SUB-REPORTA em listas grandes → pode PERDER POs além do total → subestima → compra dupla, o mesmo risco), janela de 180 dias (mesma ambiguidade de semântica de data) e de-dup dual-source frágil (em_transito × on-order). O redesign resolve os três.
