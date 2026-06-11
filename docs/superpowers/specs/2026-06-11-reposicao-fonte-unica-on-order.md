# Reposição — "a caminho" via FONTE ÚNICA (Omie POs) + barreira fail-closed

**Data:** 2026-06-11 · **Escopo:** OBEN (money-path) · **Codex:** design consult ✅ + adversarial xhigh pendente

## Problema

O motor `gerar_pedidos_sugeridos_ciclo` decide comprar por `estoque_efetivo = estoque_fisico + estoque_pendente_entrada + em_transito ≤ ponto_pedido`.

- `estoque_pendente_entrada` vinha de `ListarSaldoPendente` (Omie) — **cego à previsão FUTURA de PO aprovada** (incidente 2026-06-11: PO 1054 aprovada/entrega 19/06, FUNDO PU 3un → re-sugeria = double-buy).
- 1ª tentativa (keep-both: `em_transito` interno + fonte Omie manual com de-dup) → **Codex BLOQUEOU (3 P1)**: o `em_transito` conta `qtde_final` CHEIA (inclusive já-recebido), enquanto a fonte Omie usa saldo → **modelos inconsistentes → overcount → ruptura**. + paginação por `nTotalPaginas` (bug conhecido do Omie) + de-dup não cobre o 2º ramo da CTE.

## Decisão (Codex: "Opção A endurecida")

**Quantidade = FONTE ÚNICA Omie.** `estoque_pendente_entrada` = Σ `saldo = max(0, nQtde − nQtdeRec)` por SKU sobre **TODAS as POs abertas APROVADAS** do Omie (app + manual). **Remover o `em_transito`** da RPC.

O estado interno (`pedido_compra_sugerido`) deixa de ser estoque alternativo e vira **barreira de consistência fail-closed**: o motor **ABORTA** quando não pode garantir que o snapshot reflete tudo em voo. Mata double-buy (latência) **e** ruptura (overcount) sem 2 fontes de quantidade.

## Componentes

### 1. Helper puro `src/lib/reposicao/pendente-entrada-po.ts`
`computeOnOrder(items, {etapasAprovadas, etapasIgnoradas}) → {porSku, problemas[]}`.
- saldo por SKU sobre etapa ∈ aprovadas (`{"15"}`); etapa ∈ ignoradas (`{"10"}` em aprovação) = pula sem alarme.
- **fail-closed** em `problemas`: etapa desconhecida com saldo>0, OU número inválido (qtde/recebido não-finito ou negativo). `problemas` não-vazio ⇒ a edge **NÃO aplica** (mantém snapshot anterior).
- **SEM de-dup** (fonte única).

### 2. Edge `omie-sync-estoque` (OBEN)
- PesquisarPedCompra **paginando ATÉ PÁGINA VAZIA** (não `nTotalPaginas`; teto técnico alto só como fatal anti-loop). **Sem corte de 180d** (viola "todas as POs abertas") — `dDataInicial` antes do início operacional, `dDataFinal = hoje+1`.
- `computeOnOrder` → se `problemas` não-vazio: **FATAL** (não grava; mantém snapshot). Senão: aplica.
- **Snapshot atômico** (via RPC `aplicar_snapshot_pendente`): recalcula e **SUBSTITUI** todo `estoque_pendente_entrada` (zera quem não tem PO; nunca `+=`) + grava marcador `complete` na **mesma transação**. `run_id`/`observed_at` monotônico (run velho não sobrescreve novo).
- Modo `{only_pending:true}`: roda **só** a parte de PO (rápido, ~5s); **NÃO** atualiza frescor do físico.
- `{only_pending, esperar_codints:["AFI-<id>", ...]}`: espera/retry (poucos s) até o snapshot conter todos os `cCodIntPed` esperados (HTTP 200 sem ver a PO ≠ completo).

### 3. RPC `gerar_pedidos_sugeridos_ciclo`
- **Remove** `em_transito` (CTE + termo) → `estoque_efetivo = estoque_fisico + estoque_pendente_entrada`.
- **Barreira fail-closed**: `RAISE`/aborta a geração enquanto houver (OBEN):
  - `pedido_compra_sugerido` em `aprovado_aguardando_disparo` (aprovado não disparado);
  - portal-confirmado sem PO Omie (`status_envio_portal IN sucesso_portal/enviado_portal AND portal_protocolo NOT NULL AND omie_pedido_compra_numero IS NULL`);
  - `cCodIntPed` recém-criado (disparado nos últimos N min) **não confirmado** no snapshot pending corrente;
  - última execução `complete` do snapshot **stale**.

### 4. Disparo `disparar-pedidos-aprovados`
- Após `IncluirPedCompra` (por lote), **bump** `omie-sync-estoque {only_pending:true, esperar_codints:[AFI-<id>...]}` (best-effort + a barreira da RPC cobre se o bump falhar).

### 5. Sentinela (check `estoque_reposicao`)
- Marcador `complete` em `sync_state` (entidades `reposicao_estoque_full` + `reposicao_pendente_po`); `status=complete` só após página-vazia + apply integral; metadata `run_id`/páginas/itens/`empty_page_reached`/etapas. O check usa o **marcador** como verdade (não `max(ultima_sincronizacao)`, que fica verde com sync parcial).

## Riscos endereçados (Codex)
- Etapa 10 sem `OMIE_*_EMAIL_APROVADOR`: PO nasce 10 (não 15) → barreira (aprovado-não-disparado / portal-sem-Omie) cobre o app; manual etapa-10 = não conta (correto, não comprometido).
- Idempotência: full-sync e bump usam a MESMA função de derivação/apply; nunca `+=`; falha mantém snapshot anterior.

## Verificação
- Helper TDD (vitest). RPC + barreira em **PG17** (`db/`). Smoke: FUNDO PU = 3. **Codex adversarial xhigh** antes do deploy.

## Não-objetivos v1
- COLACOR mantém `ListarSaldoPendente`.
