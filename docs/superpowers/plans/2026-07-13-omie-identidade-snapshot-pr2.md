# PR-2 (achado A2) — prova positiva `client_to_user` no snapshot atômico — plano

> **Para workers agênticos:** SUB-SKILL: `superpowers:executing-plans` (inline, esta sessão). Money-path — cada passo com gate. Stacked sobre PR-1 (#1298, branch `claude/infallible-kepler-ac5e97`); PR-2 fica **draft** até o #1298 reconciliar+mergear. Design: [`docs/superpowers/specs/2026-07-11-omie-identidade-snapshot-atomico-design.md`](../specs/2026-07-11-omie-identidade-snapshot-atomico-design.md) §4.1/§4.2/§4.4, §5 (PR-2), §7 (gate).

**Goal:** Fechar o cache-first bypass (A2): o `clientCache` do `syncPedidos` passa a vir do `client_to_user` do MESMO snapshot atômico (prova positiva por documento), aposentando a view fresca `omie_customer_account_map_fresco` (TTL 7d, stale).

**Arquitetura:** A RPC `omie_sync_identity_snapshot(p_account)` (PR-1, `client_to_user` era `'{}'`) passa a preencher `client_to_user` por join da proof-table com a MESMA CTE `doc_agg WHERE n_users=1` (prova positiva compartilhada com `doc_to_user`). Nova coluna `omie_customer_account_map.evidence_document_normalized` dá a provenance; o writer document-first grava o doc que casou; backfill = política NULL-fail-closed (linha sem evidence cai no fallback `doc_to_user`, não entra em `client_to_user`). O helper `parseIdentitySnapshot` ganha `clientToUserMap`.

**Tech:** Postgres 17 (`sql STABLE`, `BEGIN ATOMIC`), Deno edge (helper espelhado MIRROR + paridade textual CI), vitest, prove-sql-money-path (PG17 + falsificação).

## Global Constraints (do design + regras VIVAS)

- **Prova positiva, NUNCA ausência** (money-path §1). `client_to_user` só com `source='document'` ∧ `evidence_document_normalized IS NOT NULL` ∧ doc ∈ `doc_to_user` (único) ∧ `da.user_id = m.user_id` ∧ `updated_at >= now()-7d`.
- **v1 só `source='document'`** em `client_to_user` (design §6). `manual`/`code` fora.
- **CREATE OR REPLACE puro, MESMA assinatura** `(text)` — sem DROP. Preservar verbatim `doc_to_user`/`ambiguous_docs`, REVOKE/GRANT, comentário atualizado. `ALTER TABLE ADD COLUMN` ANTES do CREATE (BEGIN ATOMIC referencia a coluna → 42703 no deploy se faltar).
- **Helper espelhado**: `parseIdentitySnapshot` vive em `src/lib/omie/omie-identity-snapshot.ts` e ESPELHADO verbatim (bloco `// MIRROR-START omie identity-snapshot-parse`) nos 2 edges. Paridade textual 3-way (src × vendas × analytics) no CI.
- **Migration custom não auto-aplica** (Lovable) → empacotar via `lovable-db-operator` (SQL Editor + NOTIFY pgrst + validação psql-ro). Pré-flight `pg_get_functiondef` da prod antes do CREATE OR REPLACE.
- **Deploy**: PR-2 depende de PR-1 aplicado + 1 run do sync (evidence populado). Cada leitor degrada a fallback se a prova faltar (aditivo).

---

## Task 1 — Helper `parseIdentitySnapshot` expõe `clientToUserMap` (TDD, src/)

**Files:** Modify `src/lib/omie/omie-identity-snapshot.ts`; `src/lib/omie/omie-identity-snapshot.test.ts`.

**Interface (Produces):** `parseIdentitySnapshot(snap) → { docToUserMap: Map<string,string>; ambiguousDocs: Set<string>; clientToUserMap: Map<string,string> }`. `clientToUserMap`: omie_codigo (string) → user_id (UUID validado). Fail-closed: `client_to_user` ausente/não-objeto/valor não-UUID → LANÇA (consistente com doc_to_user).

- Teste RED: `client_to_user: { '1001': U1 }` → `clientToUserMap.get('1001')===U1`; `client_to_user: null` → throw; valor não-UUID → throw. (Os testes de falha do PR-1 lançam ANTES de client_to_user — permanecem verdes.)
- Impl: após montar docToUserMap, validar `s.client_to_user` (objeto), iterar, validar UUID, `clientToUserMap.set(codigo, user)`.
- Gate: `bun run test src/lib/omie/omie-identity-snapshot.test.ts` verde + `bun run typecheck`.

## Task 2 — Migration: coluna + RPC estendida (prove-sql-money-path)

**Files:** Create `supabase/migrations/20260713140000_omie_identity_snapshot_client_to_user.sql`; Modify `db/test-omie-identidade-snapshot.sh`.

**Migration:**
```sql
ALTER TABLE public.omie_customer_account_map
  ADD COLUMN IF NOT EXISTS evidence_document_normalized text;

CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document, '\D', '', 'g') AS doc, p.user_id
    FROM public.profiles p
    WHERE p.document IS NOT NULL
      AND length(regexp_replace(p.document, '\D', '', 'g')) >= 11
  ),
  doc_agg AS (
    SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id
    FROM doc_valid GROUP BY doc
  ),
  client_valid AS (          -- prova positiva: só doc único que ainda aponta pro MESMO user do vínculo
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m
    JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized
     AND da.n_users = 1
     AND da.user_id = m.user_id::text
    WHERE m.account = p_account
      AND m.source = 'document'
      AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user', coalesce((SELECT jsonb_object_agg(codigo, user_id) FROM client_valid), '{}'::jsonb)
  );
END;

REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;
COMMENT ON FUNCTION public.omie_sync_identity_snapshot(text) IS
  'PR-1/A1 + PR-2/A2: identidade doc→user e codigo→user num snapshot atômico. client_to_user = prova positiva (source=document, evidence viva/única/consistente, frescor 7d). Só service_role.';
```

**prove-sql (`db/test-omie-identidade-snapshot.sh` estendido):**
- ZONA 1: criar stub `public.omie_customer_account_map` (colunas usadas: `omie_codigo_cliente bigint, user_id uuid, account text, source text, updated_at timestamptz`) SEM `evidence_document_normalized` (a migration prova o ALTER).
- ZONA 3 seed (p_account='oben'): 1001 doc-único→mapeia · 1002 doc-ambíguo→fora · 1003 evidence NULL→fora · 1004 source='code'→fora · 1005 conta='colacor'→fora p/ oben, dentro p/ colacor · 1006 evidence de OUTRO user (cenário A2)→fora · 1007 stale (>7d)→fora.
- ZONA 4 asserts B1–B8 (positivo + fail-closeds + count=1 p/ oben; 1005 dentro p/ colacor).
- ZONA 5 falsificação: (F1) remover `da.n_users=1` → 1002 ambíguo vaza → B2 vermelho; (F3) remover `da.user_id=m.user_id` → 1006 doc-de-outro-user vaza → B6 vermelho; restaurar → verde. Manter A7 (PR-1 dizia client_to_user vazio) → **atualizar** para o novo comportamento.
- Gate: `bash db/test-omie-identidade-snapshot.sh > /tmp/t.log 2>&1; echo $?` == 0.

## Task 3 — Edges: MIRROR sincronizado + writer + consumo + canária

**Files:** Modify `supabase/functions/omie-analytics-sync/index.ts`, `supabase/functions/omie-vendas-sync/index.ts`.

- **3a MIRROR (ambos edges):** copiar o `parseIdentitySnapshot` estendido (bloco MIRROR) verbatim de src/. Paridade 3-way no CI (Task 4).
- **3b Writer (analytics `syncCustomers` ~:396):** no `accountMapByUser.set(userIdByDoc, {...})` adicionar `evidence_document_normalized: doc,` (o `doc` normalizado já em mãos) + campo no tipo do Map. Backfill = política (linha antiga NULL cai no fallback; próximo run reescreve).
- **3c Consumo (vendas `syncPedidos` ~:904/918-951):** desestruturar `clientToUserMap` do `parseIdentitySnapshot`; **remover** o pré-load da view fresca (`omie_customer_account_map_fresco`, :918-951) e montar `clientCache` do `clientToUserMap` (`Number(codigo)` guard >0); log novo `Client cache from identity snapshot (client_to_user)`. `pgSize`/`hasMore` seguem (o productMap os usa) — ajustar comentário :907.
- **3d Canária `identidade_snapshot_probe` (vendas):** expor `clientes_mapeados: clientToUserMap.size` (prova o client_to_user DEPLOYADO).
- Gate: `bun run typecheck` + `bun run lint`.

## Task 4 — Invariante 3-way + consumo (vitest)

**Files:** Modify `src/__tests__/edge-money-path-invariants.test.ts`.

- Paridade MIRROR `omie identity-snapshot-parse` idêntica em src × vendas × analytics (estender o describe do PR-1).
- Sentinela de consumo: vendas usa `clientToUserMap` e o clientCache NÃO lê mais `omie_customer_account_map_fresco` (anti-reversão do Lovable); analytics writer grava `evidence_document_normalized`.
- Guard: `codeBelongsToWrongAccount` (FORA desta PR) segue lendo `omie_clientes` todas as contas.
- Gate: `bun run test src/__tests__/edge-money-path-invariants.test.ts` verde.

## Task 5 — Gates finais

- `bun run typecheck` · `bun run lint` · `heavy bun run test` (suite completa) verdes.
- **/codex challenge xhigh** do diff via `scripts/codex-async.sh` (background) — apresentar parecer CRU + calibração separada.
- **lovable-db-operator**: handoff SQL Editor numerado (ordem PR-1→PR-2) + NOTIFY pgrst + query de validação psql-ro (pós-apply: `client_to_user` populado num run real).
- PR **draft** + `pr-watch.sh` em background.

## Self-review (spec coverage)

§4.1 client_to_user conjunção → Task 2 SQL ✅ · §4.2 coluna+writer+backfill → Task 2 (coluna) + Task 3b (writer) + política NULL ✅ · §4.4 clientCache←client_to_user + parse estendido → Task 1 + Task 3c ✅ · §7 gate (prove-sql falsifica evidence, vitest, canária RPC real, paridade, codex) → Tasks 2/4/5 ✅ · §8 deploy ordem → Task 5 ✅. Fora de escopo (A3/tabela pendente, manual/code) — respeitado.
