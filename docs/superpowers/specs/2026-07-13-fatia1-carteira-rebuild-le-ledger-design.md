# Fatia 1 P0-B-bis — `carteira-rebuild` lê a LISTA de membros do ledger — design

**Data:** 2026-07-13 · **Money-path** (lista de membros → carteira → comissão) · **Edge que já bloqueou 2× no Codex**
**Referências:** spec do épico `2026-07-12-carteira-membership-ledger-drop-espelho-design.md` (§3, §5), plano da Fatia 0 `2026-07-12-fatia0-carteira-membership-ledger.md`, design da ponta 2 `2026-07-11-carteira-rebuild-vendedor-proof-ponta2-design.md`.

## 1. Contexto

O épico P0-B-bis aposenta o espelho poluído `omie_clientes`. A **Fatia 0** (#1321, `865fa7f3`) criou o `carteira_membership_ledger` (acumulador durável) + backfill dos 6909 membros de hoje (`first_seen_at = omie_clientes.created_at`) + trigger `AFTER INSERT ON omie_clientes` (`ON CONFLICT DO NOTHING`, `source='trigger'`). **Aplicado e verificado** (psql-ro, 2026-07-13): `ledger == espelho == 6909`, população **idêntica** (diferença simétrica `0/0`), 100% `identity_state='verified'`/`source='backfill'`.

A **última dependência dura** do espelho no `carteira-rebuild` é a **LISTA de membros**: [carteira-rebuild/index.ts:251](../../../supabase/functions/carteira-rebuild/index.ts) faz `.from('omie_clientes').select('user_id')` — só o CONJUNTO de user_ids. O VENDEDOR (proof oben, #1310), o ALIAS (`customer_canonical_alias`) e os FLAGGEDS (`cliente_classificacao`) já vêm de fontes account-corretas.

Esta **Fatia 1** troca a FONTE DA LISTA: `omie_clientes` → `carteira_membership_ledger`. Escopo mínimo, aditivo, paridade exata com o comportamento de hoje.

## 2. Decisão de escopo — quarantine fica para a Fatia 2 (diverge da spec macro §5-Fatia1)

A spec macro (§5-Fatia1) previa que a Fatia 1 já lesse `identity_state` e marcasse `ambiguous`/`conflict` como `eligible=false` (quarantined). **Decisão desta sessão (handoff): o quarantine vai para a Fatia 2.**

**Justificativa:**
- **Dead-code hoje:** 100% dos membros são `verified` (nada popula os outros estados até a Fatia 2). Consumir `identity_state` agora não muda nada e não é testável com dados reais.
- **Risco money-path:** este edge bloqueou 2× no Codex — o menor diff possível é o mais seguro (precisão > recall).
- **Upsert-only:** o rebuild não deleta ([:359](../../../supabase/functions/carteira-rebuild/index.ts), `onConflict: 'customer_user_id'`). Filtrar um estado da lista SEM deletar deixaria o assignment antigo **stale** — pior que não filtrar.
- **Coesão:** a Fatia 2 popula E consome `identity_state` juntas (aditivo, fail-safe, com asserts +/− sobre dados reais).

**Resultado:** a Fatia 1 lê **todos** os `user_id` do ledger, **sem filtro de `identity_state`** → comportamento idêntico ao de hoje. Paridade garantida pela população idêntica (`0/0`).

## 3. Mudança de código

### 3.1 `supabase/functions/carteira-rebuild/index.ts` — só o LOAD da lista (:242-262)

```
-  .from('omie_clientes')
-  .select('user_id')
-  .not('user_id', 'is', null)
-  .order('user_id', { ascending: true })
-  .range(from, from + PAGE - 1)
+  .from('carteira_membership_ledger')
+  .select('user_id')
+  .order('user_id', { ascending: true })
+  .range(from, from + PAGE - 1)
```

- Remove `.not('user_id','is',null)` — no ledger `user_id` é **PK NOT NULL** (filtro morto).
- Paginação robusta a `max_rows` preservada: avança por `page.length` real, para na página vazia, guard `MAX_ROWS`.
- Renomeia a variável local `espelhoIds` → `membroIds` (a var local do handler está FORA do bloco MIRROR); atualiza os comentários (:242-245) para a fonte real (ledger, acumulador).
- **NÃO toca:** o VENDEDOR (proof `omie_customer_account_map_fresco` account='oben'), `computeCarteira`, o bloco `// MIRROR-START carteira-load`, nenhum guard.

### 3.2 `src/lib/carteira/rebuild-helpers.ts` — sem mudança de lógica

O helper é PURO (recebe uma *lista de ids* via `montarClientes(espelhoIds, proofOben)`; a origem é irrelevante). **A paridade edge↔helper se mantém sem tocar o corpo do MIRROR** — o LOAD vive no handler. Único toque admissível: atualizar o comentário-header (P0-B-bis ponta 2/2) que afirma "A LISTA de membros continua vindo do espelho" para refletir o ledger. O nome do parâmetro `espelhoIds` permanece (renomeá-lo exigiria mexer nos dois lados do MIRROR sem ganho de comportamento).

### 3.3 `src/__tests__/edge-money-path-invariants.test.ts` — canário do carteira-rebuild

- **Assert POSITIVO novo:** a LISTA vem de `carteira_membership_ledger` (`.from('carteira_membership_ledger')` + `.select('user_id')`).
- **Anti-reversão atualizada:** o rebuild NÃO lê mais `omie_clientes` em lugar nenhum (nem lista, nem vendedor) — `not.toMatch(/from\(['"]omie_clientes['"]\)/)`. Substitui o assert antigo que só barrava `omie_clientes` + `user_id, omie_codigo_vendedor`.
- **Mantém intactos:** VENDEDOR da proof oben (4ª leitura money-path), guards usados (pré/pós), baseline/bootstrap gated, paridade MIRROR.

## 4. Invariantes / riscos

- **Cobertura 6909 preservada.** Ledger é **append-only** (backfill + trigger INSERT; CASCADE só em delete de `auth.users`) → cobertura **monotônica, nunca encolhe** → dissolve o risco "carteira encolhe" (incidente 100% Hunter) melhor ainda que o espelho.
- **Guards fail-closed inalterados.** `carteira_omie_baseline = 2728` (≠ 0) → o guard comparativo está ATIVO no 1º run pós-deploy (não é bootstrap; sem `?bootstrap=1`). Como a população é idêntica, `omieElegivelNovo ≈ 2728 ≥ 0.8×2728` → passa.
- **Transição via trigger.** Enquanto o espelho é escrito (Fatias 0-3), o trigger mantém o ledger em dia. A Fatia 4 desacopla os writers; a Fatia 5 dropa o espelho. Risco aceito: um delete direto no espelho (raro/inexistente — é mirror de sync upsert-only) não encolhe o ledger — comportamento SEGURO.

## 5. Validação (a prova da entrega)

- `heavy bun run test src/lib/carteira/` (rebuild-helpers — inalterado, paridade) + canário `edge-money-path-invariants` atualizado.
- `deno check` do edge · `bun run typecheck` · `bun lint`.
- **Sem prove-sql PG17** — não há SQL novo (o ledger já foi provado na Fatia 0).
- **/codex challenge** (`scripts/codex-async.sh -r xhigh`) do diff antes do PR (money-path + histórico de 2 bloqueios), conduzido pelo Claude em background.
- **Pós-deploy (psql-ro):** `source='omie'` ~2747 total / ~2728 elegíveis, cobertura total 6909, `carteira_omie_baseline` permanece 2728.

## 6. Deploy

- PR não-draft → auto-merge (squash) no CI `validate` verde.
- **Edge NÃO auto-deploya** → deploy manual do founder no chat Lovable (ler `carteira-rebuild` do repo, verbatim) após o merge.
- **Migration: nenhuma** (Fatia 0 já aplicada e verificada).

## 7. Fora de escopo (fatias futuras — planos próprios)

- **Fatia 2:** popular + consumir `identity_state` (quarantine de ambiguous/conflict: vendedor removido, eligible=false, membro preservado, zero comissão).
- **Fatia 3:** migrar os leitores de código/vendedor restantes → proof.
- **Fatia 4:** migrar os 6 writers → RPC `register_carteira_member`.
- **Fatia 5:** `DROP TABLE omie_clientes` + regenerar `types.ts`.
