# Reposição "a caminho" (on-order) — BLUEPRINT do redesign single-source

**Data:** 2026-06-14 · **Escopo:** OBEN (money-path) · **Status:** projeto FUTURO (não iniciado) · **Origem:** consulta de design ao Codex (gpt-5.5 xhigh, 2026-06-13; log integral em `/tmp/codex-perf-fix.log` na sessão).

## Por que existe este doc
A 1ª tentativa de single-source (PR #809, "Opção A endurecida": `estoque_pendente_entrada` OBEN = Σ saldo das POs abertas APROVADAS do Omie, paginando até a página vazia, sem janela de data) passou 11 rounds de Codex e o gate (round 11 = LIBERAR), MAS **não completa o full sync na janela ~400s de wall-clock do edge do Supabase** (varre todas as POs de OBEN desde 2010 com 1,1s/página, sem cursor). Tentado regs 50→200 → não bastou. **Revertido pro #752** (estado bom-conhecido) em 2026-06-14 (edges `omie-sync-estoque`/`disparar-pedidos-aprovados`/`gerar-pedidos-diario` → #752/#743/#711; migrations `195000`/`220000` ficam DORMENTES; motor `200000` e Sentinela `210000` NÃO aplicados). Este doc é a blueprint pra construir a versão correta quando priorizado.

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

### Ordem de preferência
1. **Melhor:** worker LONGO (>400s) com varredura única + réplica normalizada por PO. ⚠️ avaliar se o stack (Lovable/Supabase) oferece runtime >400s — edge é capado em ~400s; pg_cron roda SQL, não HTTP ao Omie. Se não houver worker longo → opção 2.
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

### Físico-first
Ler + persistir o físico no INÍCIO da geração. NÃO reler no fim (físico-posterior + saldo-antigo = conta recebimento 2×). Geração que excede idade-limite (60–90min) → DESCARTA + reinicia.

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

> ⚠️ **DESATUALIZADO em parte** — o furo do `nTotalPaginas` foi CORRIGIDO em prod (paginar-até-página-vazia + fail-closed) por **#979/#1004/#1009** (verificado, #1011). Restam só os furos #2 (janela 180d) e #3 (de-dup dual-source). Ver a conclusão abaixo.

## Conclusão da investigação 2026-06-23 — **C ADIADO (ROI baixo agora)**
Investigação que destrava (ou não) o redesign. Resultado: **não construir o C agora.**

**1. Runtime do stack (GATE da arquitetura) — opção 1 (worker longo) está MORTA.** Doc oficial Supabase confirmada: Edge Functions têm **wall-clock máx 400s (pago) / 150s (free), NÃO-configurável**; CPU 2s/request; memória 256MB; **background `EdgeRuntime.waitUntil` TAMBÉM é morto ao bater os 400s** (não escapa). Não há worker HTTP longo nativo (pg_cron roda SQL, não HTTP longo; queues precisam de consumer, que é edge → mesmo teto). → Da "Ordem de preferência" acima, a (1) cai; o C só pode ser **(2)/(3): réplica-por-PO + particionamento por data** (caro: staging + cursor estável + lease/fencing).

**2. Semântica de data — INFERIDA = emissão/inclusão (NÃO precisa sondar o Omie para MANTER a janela 180d).** Prova: o Caminho A (#979) está em prod cobrindo o **FUNDO PU/1054 (entrega FUTURA 19/06)**; se `dDataInicial` filtrasse por *previsão de entrega*, essa PO estaria fora de `[hoje−180d, hoje]` e o FUNDO PU não estaria coberto — mas está. Logo a janela filtra por **emissão/inclusão**, e é segura para POs de entrega futura. Risco do furo #2 = só **PO com emissão >180d ainda aberta** (medido **0 no app** em 2026-06-23; folga ~126d; raro no geral). ⚠️ A confirmação ESCRITA do Omie (protocolo acima) só é necessária se for **CORTAR** a janela (<180d) ou **particionar** — para manter 180d, a inferência basta.

**3. Decisão = ADIAR.** Justificativa: o double-buy **já está resolvido** pelo Caminho A (em prod, 20→39 SKUs com pendente); os furos que o C mataria são de **baixo risco** (#2 com folga 126d; #3 raro, direção ruptura ≠ double-buy); o C é **caro (semanas)** e a janela 180d **funciona**. ROI baixo.

**Gatilhos que REABREM o C** (vigiar):
- PO OBEN aberta se aproximando de **180d de emissão** (furo #2 deixa de ter folga) — hoje a mais antiga é ~54d.
- `paginasLidas`/`duracao_ms` da `omie-sync-estoque` (#979) crescer perto dos 400s (volume de POs abertas estourando a janela).
- Surgir runtime >400s no stack (Supabase) → reabre a opção 1 (worker longo, bem mais simples).
- Incidente de ruptura atribuível ao furo #3 (de-dup dual-source Ramo 2: portal-confirmado sem nº Omie).

**Pronto para reusar quando priorizado:** branch `claude/infallible-bouman-4ddb61` — single-source COMPLETO, validado 11 rounds Codex (só faltou a performance, que é o particionamento desta blueprint).
