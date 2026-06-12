# Reposição — "a caminho" via FONTE ÚNICA (Omie POs) + barreira fail-closed

**Data:** 2026-06-11 · **Escopo:** OBEN (money-path) · **Codex:** design consult ✅ + adversarial xhigh pendente

## Estado da implementação (un componente por vez)

- ✅ **Helper** `src/lib/reposicao/pendente-entrada-po.ts` (`computeOnOrder`, fail-closed, 23 testes).
- ✅ **Passo 1 — RPC `aplicar_snapshot_pendente`** (`supabase/migrations/20260611150000_*`). Snapshot atômico: SUBSTITUI (nunca `+=`) todo `estoque_pendente_entrada` OBEN + marcador `complete` na MESMA transação; `run_id` monotônico (run velho → SKIP); advisory lock por empresa; **a RPC é dona única da coluna** (D1); UPSERT cria linha só-pendente (`fisico=0`/`ultima_sincronizacao=NULL`/`fonte_sync='snapshot_pendente_sem_fisico'`) p/ SKU sem física (D2); `account='oben'` no marcador (D3); grava `codints_aprovados` (jsonb array) p/ a barreira do passo 3 cruzar; **guards fail-closed** (auto-challenge): `meta.empty_page_reached='true'` obrigatório (payload vazio só zera com varredura completa) + saldo `<=0`/não-numérico recusado. Validado em **PG17** (`db/test-aplicar-snapshot-pendente.sh`, **A1..A13 verdes**). ⚠️ **Caminho B**: Codex esgotou (usage limit, volta 12/06 00:11) → design decidido solo + auto-challenge; **Codex adversarial xhigh é GATE antes do deploy** (roda retroativo quando voltar).
- ✅ **Passo 2 — edge `omie-sync-estoque` fonte única**. Helper estendido com a coleta pura (`coletarDaPagina`/`paginaVazia`/`fingerprintPagina`/`codintsFaltantes`/`varrerPedidos` com fetcher injetável — **44 testes vitest**). Edge: PesquisarPedCompra paginando **até página vazia** (não `nTotalPaginas`) + fingerprint anti-loop + teto técnico fatal; **sem corte de 180d** (`dDataInicial='01/01/2010'`); retry/backoff robusto (rede/5xx/429); `computeOnOrder` fail-closed (`problemas != []` → FATAL, mantém snapshot); modos `{only_pending}` (não toca físico) e `{esperar_codints}` (re-varre até ver os `AFI-<id>`; se faltar, aplica e a barreira do passo 3 cobre); gravação via RPC `aplicar_snapshot_pendente`; upsert do físico **sem** a coluna pendente (D1); COLACOR mantém `ListarSaldoPendente`; marcador `reposicao_estoque_full`. Regex de fim conservadora (preferir falso-negativo a parar cedo = double-buy). **deno check limpo · typecheck · lint** verdes. ⚠️ requer **deploy via Lovable** (segurado p/ pós-Codex).
- ✅ **Passo 3 — motor `gerar_pedidos_sugeridos_ciclo` fonte única** (`20260611200000`). REMOVE o `em_transito` (CTE+join+`qtde_em_transito_recente`+os 5 `+COALESCE(et.qtde,0)`) → `estoque_efetivo = fisico + pendente`. ADICIONA a barreira fail-closed **OBEN-only** (4 condições): (1) `aprovado_aguardando_disparo`; (2) portal-confirmado sem PO Omie; (3) recém-disparado (<30min) cujo `AFI-<id>` não consta em `marcador.codints_aprovados`; (4) marcador `reposicao_pendente_po` ausente/incompleto/stale (>6h). Parte da `20260609160000` (confirmada a + recente do motor normal; #743 tocou só oportunidade); TODAS as marcas preservadas (**diff mecânico** prova: só barreira ADD + em_transito DEL). **PG17 B1..B11 verdes** (`db/test-motor-fonte-unica.sh`). ⚠️ migration MANUAL — aplicar SÓ após a edge ter populado o marcador `complete` (senão a cond 4 aborta tudo); preflight `pg_get_functiondef` de prod antes do `CREATE OR REPLACE`. **Thresholds p/ Codex:** 6h (cond 4), 30min (cond 3), barreira GLOBAL vs por-SKU.
- ✅ **Passo 4 — bump no disparo** (`disparar-pedidos-aprovados`): helper `bumpSnapshotPendente` (OBEN-only, best-effort, **background via `EdgeRuntime.waitUntil`** p/ não somar a latência da varredura à resposta do disparo — crítico p/ o "aprovar=disparar na hora" #638) chama `omie-sync-estoque {only_pending, esperar_codints:[AFI-<id>…]}` com os IDs recém-disparados (só `modo='producao'`). Se falhar, a barreira do passo 3 (cond 3) cobre. **deno check · lint net-zero vs main.** ⚠️ requer deploy via Lovable.
- ⚠️ **Passo 5** (Sentinela `estoque_reposicao` usa o marcador `reposicao_pendente_po`/`reposicao_estoque_full` em vez de `max(ultima_sincronizacao)`) — PENDENTE.

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

## Anexo — Codex (achados que motivaram o rework; `/tmp` é efêmero, fixado aqui)

### Adversarial do keep-both — BLOQUEOU (3 P1, 5 P2)
- **P1** De-dup por PO descarta quantidade: a RPC conta `qtde_final` CHEIA no `em_transito`, a fonte Omie usa saldo → pedido 10/recebido 4 = físico 4 + em_transito 10 = **14** (real 10) → overcount → ruptura. `concluido_recebido` duplica o recebido por até 7d.
- **P1** `fetchEmTransitoKeys` não replicava o **2º ramo** da CTE (`sucesso_portal/enviado_portal + protocolo + omie_numero NULL`) → double-count de borda.
- **P1** Paginação por `nTotalPaginas` (Omie SUB-REPORTA — já mordeu em CR/CP, ver `omie-financeiro`) → página omitida = PO perdida = double-buy. Paginar **até página vazia** + fingerprint anti-loop + teto técnico fatal.
- **P2** etapa aberta desconhecida descartada em silêncio (não é "lado seguro" — vira double-buy) → **fatal**; NaN/negativo no parsing conta a qtde inteira → **fatal**; Sentinela com `max(ultima_sincronizacao)` fica verde com sync parcial → usar **marcador `complete`**; `callOmiePedidos` só retenta 429 (rede/5xx falha de primeira) → retry/backoff; janela `PEDIDOS_JANELA_DIAS=180` perde PO aberta antiga → **sem corte**.

### Design da fonte única ("Opção A endurecida") — invariantes
Nunca `+=` (recalcula e SUBSTITUI todo `estoque_pendente_entrada`); apply + marcador `complete` na **mesma transação**; `run_id`/`observed_at` monotônico (run velho não sobrescreve novo); full-sync e bump usam a **MESMA** função de derivação/apply; `{only_pending}` NÃO atualiza frescor do físico; falha/etapa-desconhecida **mantém** o snapshot anterior (nunca zeros parciais); o bump espera ver os `AFI-<id>` antes de declarar completo; a barreira da RPC é **fail-closed** (aborta a geração, não chuta).
