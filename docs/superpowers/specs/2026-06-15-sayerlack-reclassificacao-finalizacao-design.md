# Sayerlack — reclassificação por finalização: falha ANTES do "Efetivar" → `erro_retentavel` (não `indeterminado`)

**Data:** 2026-06-15 · **Escopo:** edge `enviar-pedido-portal-sayerlack` (money-path) · **Status:** SPEC v3 (2 passes de BLOQUEIO do Codex incorporados) · **Origem:** pedido 355.

## Problema
Portal Sayerlack = automação Browserless (flaky). Falha → **`indeterminado_requer_conciliacao`** (ação humana; o motor `sayerlack_retry_orfaos` NÃO retenta, por risco de PO duplicado) = reconciliação manual. **Causa do excesso:** a classificação usa `requestSent` (liga em QUALQUER POST de ordem, incl. o de criar o RASCUNHO, cedo) → qualquer falha pós-rascunho vira indeterminado, **mesmo sem pedido finalizado**.

## Evidência (pedido 355)
10+ itens; 0-8 salvos OK; **travou no item 9** (`validacao-data`, hang >15s); budget sobrando (198s). Trace **sem `efetivar_clicked`** → nunca clicou "Efetivar Pedido" → nenhum pedido colocado, só rascunho parcial → mas virou indeterminado (manual). Era hang transitório → deveria auto-retentar.

## INVARIANTE-MESTRA (money-path)
`erro_retentavel` → o motor AUTO-RE-DISPARA. Se um pedido pode ter sido colocado e for reclassificado retentável → **DUPLICATA**. ⛔ Só relaxar→`erro_retentavel` quando **PROVADAMENTE não houve pedido**. Desconhecido/ausência de prova → **`indeterminado`** (fail-closed). A camada Deno **só endurece, nunca afrouxa** — jamais rebaixar um `indeterminado`.

## Fronteira de finalização (CONFIRMADA no código)
`grep` de todos os `page.click`: pedido só é colocado ao clicar **`#btnSalvarNovoPedido` ("Efetivar Pedido")**, L1086, UMA vez. `#btnSalvarProposta` NUNCA é clicado (só debug do DOM). `#btnGravarItem`→`save-tab-preco-session` nem casa `SUSPECT_RE`. Sem Enter/`submit()`/auto-submit. → **clique de Efetivar não ocorreu ⟺ nenhum pedido.** ⚠️ **Confirmação EMPÍRICA do founder (gate de deploy):** "Salvar Proposta" e rascunho abandonado **não** geram PO na Sayerlack.

## Duas camadas de classificação (o Codex pegou — eu via só uma)
1. **`buildEnvelope`** (DENTRO do Browserless, ~L296-355): produz o `status` do envelope.
2. **Máquina de estados Deno** (~L1945-2070): recebe o envelope, decide o `status_envio_portal` final + persiste. Inclui a rede de segurança L1978. **Ambas precisam virar `efetivarAttempted`-aware e CONSISTENTES** (mexer só numa é inútil).

## Sinal: `efetivarAttempted` (substitui `requestSent` na decisão de falha)
**Codex v2 P1.1:** `requestSent` é proxy ruim — ele liga em POST de rascunho (falso-perigo: vira indeterminado à toa) E pode FALHAR de capturar o POST de finalização (recorder perde → falso-seguro: vira retentável após o clique = duplicata). O sinal preciso é **`efetivarAttempted`** = clicou `#btnSalvarNovoPedido`. `requestSent` segue só como evidência/log.

### (A) Flag em closure do Browserless (undefined-safe)
`let efetivarAttempted = false;` no topo da função Browserless (ao lado de `trace`/`t0`), fora do `runFlow`. `efetivarAttempted = true;` **IMEDIATAMENTE ANTES** de `await page.click('#btnSalvarNovoPedido')` (L1086) — antes, não depois (hang no clique → já `true` → indeterminado). `buildEnvelope` lê do closure (sobrevive aos try/catch interno L1258 e externo L1284 — Codex v2 confirmou) e grava `evidence.efetivarAttempted` (SEMPRE boolean).

### (B) Camada 1 — `buildEnvelope`
1. `if (data.success === true)` → `sucesso_portal`/`aceito_portal_sem_protocolo` (INALTERADO; success só é setado pós-clique pela lógica de submit → implica efetivarAttempted=true).
2. `else if (protocoloAutoExtraido && efetivarAttempted === true)` → `sucesso_portal` (**MUDOU de `&& requestSent` p/ `&& efetivarAttempted===true`** — Codex v2 P1.3). Um protocolo extraído de resposta de RASCUNHO é necessariamente pré-clique → `efetivarAttempted=false` → este ramo é pulado → **subsume a checagem de URL `/order-creation/form/add`** que o Codex sugeriu.
3. `else` (falha) — decisão PURA por `efetivarAttempted` (`requestSent` SAI):
   - `if (erroLogicoPreSubmit)` → `erro_nao_retentavel` (LOGIN_FAILED/CLIENTE_NOT_FOUND/SKU_NOT_FOUND/GRUPO_LEADTIME_MISMATCH — pré-clique determinístico; Codex P3 confirmou seguro).
   - `else if (efetivarAttempted === false)` → **`erro_retentavel`** ⭐ (clique nunca ocorreu → nenhum pedido → seguro).
   - `else` (efetivarAttempted `true` OU `undefined`) → **`indeterminado`** (clicou ou desconhecido → pode ter colocado). **Fecha o P1.1**: clicou-mas-sem-requestSent cai AQUI (indeterminado), não em retentável.

### (C) Camada 2 — rede de segurança Deno L1978 (endurece, undefined-safe)
```
if (envStatus === 'erro_retentavel' && evidence?.efetivarAttempted !== false) {
  envStatus = 'indeterminado_requer_conciliacao';  // só mantém retentável se efetivarAttempted EXPLÍCITO false
}
```
(`requestSent` sai daqui também — coerente com (B).) `undefined`/ausente → endurece p/ indeterminado.

### (D) Deno tempFail 408/5xx/0 → `indeterminado` (Codex P1 v1, confirmado correto v2)
L1957-1964 hoje → `erro_retentavel` assumindo "não submeteu". O Browserless pode falhar PÓS-clique → desconhecido → **`indeterminado`**. (`httpErr`/abort L1951 já é indeterminado — manter; `401/403` L1830 fica retentável — nenhum browser subiu.) **Tempo decorrido NÃO prova que o clique não ocorreu** (Codex v2) → não usar heurística de tempo.

### (E) Deno — status DESCONHECIDO → `indeterminado` (fail-closed; Codex v2 P1.2)
A máquina L1984-2070 tem branches p/ sucesso/aceito/indeterminado/erro_nao_retentavel; o `else` final (L2061) é `erro_retentavel` e captura TAMBÉM `envStatus` não-reconhecido (fail-OPEN). Mudar: branch **explícito** `envStatus === 'erro_retentavel'` → retentável; **catch-all (desconhecido) → `indeterminado`**.

### (F) Watchdog L2104-2138 — stub + UPDATE CONDICIONAL (Codex P1-Q3 v1 + P2 v2)
Ao setar `indeterminado` num pedido travado em `enviando_portal`: **(1)** sobrescrever `portal_resposta` com stub `{phase:'watchdog', efetivarAttempted:null}` (não deixar envelope obsoleto da tentativa anterior dizendo `efetivarAttempted=false` sob um indeterminado de tentativa posterior que talvez efetivou → senão humano lê "false" e re-envia → duplicata); **(2)** o UPDATE deve ser **condicional** `.eq('status_envio_portal','enviando_portal')` — senão uma conclusão concorrente (edge terminando entre o SELECT e o UPDATE do watchdog) seria sobrescrita.

## Por que é seguro (pós-fixes)
- Pedido só é colocado no clique de Efetivar (ponto único confirmado). `efetivarAttempted===false` ⟺ sem clique ⟺ sem pedido.
- `erro_retentavel` exige `efetivarAttempted===false` **explícito** nas DUAS camadas. `true`/`undefined`/desconhecido → indeterminado.
- Flag ANTES do clique → falha no/após clique → indeterminado.
- Auto-extract de protocolo exige `efetivarAttempted===true` → resposta de rascunho não vira falso-sucesso.
- 408/5xx/abort sem envelope → indeterminado. Status desconhecido → indeterminado. Watchdog condicional + sem evidência obsoleta.

## Rede de segurança preservada
- Motor `sayerlack_retry_orfaos` (`*/15`, age-bound 3d, `tentativas<3`, lock + `LIMIT 1` + claim atômico) consome `erro_retentavel`. Sem infra nova.
- Esgotamento (3ª falha) → a edge grava **`erro_nao_retentavel`** (L2061-2065, NÃO "erro_retentavel esgotado" — correção Codex P3) → coberto pelo check `reposicao_portal_humano` do Sentinela.

## Trade-off conhecido (aceito v1)
Cada retry abandona o rascunho parcial → **rascunhos órfãos acumulam** na Sayerlack. ⚠️ NÃO totalmente inofensivos (Codex P2): humano pode efetivar um órfão depois. v1 aceita (rascunho ≠ pedido; retry não os retoma); **cleanup de rascunhos órfãos = follow-up nomeado**.

## Teste (TDD)
Helper puro **`src/lib/reposicao/sayerlack-classificacao.ts`** — `classifyEnvelopeStatus({ success, protocolo, protocoloAutoExtraido, efetivarAttempted, erroTipo }) → { status, ok, safeToRetry, needsReconciliation }` — encoda a Camada 1 (B), **espelhada VERBATIM** no `buildEnvelope`. **A Camada 2 do Deno reusa o MESMO helper de verdade** (Deno importa) pra `decidirStatusDeno(envStatus, efetivarAttempted)` (endurece L1978 + catch-all desconhecido (E)) — **Codex v2 P2: testar a máquina Deno, não só `deno check`**. Casos:
1. timeout pré-Efetivar + efetivarAttempted=false → `erro_retentavel` (355).
2. clicou + sem sinal (efetivarAttempted=true) → `indeterminado`.
3. **clicou + requestSent=false** (efetivarAttempted=true) → `indeterminado` (P1.1).
4. efetivarAttempted=**undefined** → `indeterminado` (undefined-safety).
5. success + protocolo → `sucesso_portal`; success sem protocolo → `aceito_portal_sem_protocolo`.
6. SKU_NOT_FOUND (efetivarAttempted=false) → `erro_nao_retentavel`.
7. protocoloAutoExtraido + efetivarAttempted=true → `sucesso_portal`; protocoloAutoExtraido + efetivarAttempted=false → NÃO-sucesso (cai em erro_retentavel).
8. GRUPO_LEADTIME_MISMATCH → `erro_nao_retentavel`.
9. Deno: envStatus='erro_retentavel' + efetivarAttempted=true → endurece p/ indeterminado; efetivarAttempted=false → mantém retentável.
10. Deno: envStatus desconhecido → indeterminado (fail-closed).

## Não-objetivos (v1)
- Reclassificar `bodySuccessFalse` (portal rejeitou pós-submit) — fica `indeterminado`.
- Cleanup de rascunhos órfãos (follow-up nomeado).
- Mitigação "retry do passo que trava" (ortogonal).

## Deploy
Edge **verbatim da main** via chat do Lovable. Sem migration, sem mudança de schema. **Gate final: Codex adversarial no CÓDIGO** (helper + 2 camadas do edge) + **confirmação empírica do founder** (rascunho ≠ PO) antes do deploy.
