# PR-1 — RPC de identidade por snapshot atômico (A1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar a corrida de paginação não-atômica (achado A1) resolvendo `doc→user` num único snapshot MVCC server-side, consumido pelos dois edges de sync.

**Architecture:** Uma função `public.omie_sync_identity_snapshot(p_account text) RETURNS jsonb` (`LANGUAGE sql STABLE`, `SECURITY INVOKER`) retorna `{doc_to_user, ambiguous_docs, client_to_user}`. No PR-1 só `doc_to_user` (docs com `count(distinct user)=1`) e `ambiguous_docs` (2+ users) são preenchidos; `client_to_user` fica `{}` (PR-2). Os edges `omie-vendas-sync` e `omie-analytics-sync` trocam a paginação de `profiles` por uma chamada RPC. A lógica fail-closed sai do TS (`buildDocUserMapFailClosed`) e passa a viver no SQL.

**Tech Stack:** Supabase Postgres 17, edge functions Deno/TS, prove-sql PG17 local (`db/test-*.sh`), vitest, Lovable (deploy manual em 3 camadas).

## Global Constraints

- **money-path:** precisão>recall; prova positiva, nunca ausência; `.rpc()` NÃO lança → checar `{error}` e FAIL-CLOSED (throw). Ref: `docs/agent/money-path.md`.
- **Lovable:** NUNCA editar migrations existentes nem `supabase/schema-snapshot.sql`. Migration NOVA via skill `lovable-db-operator` (gera arquivo + bloco pro SQL Editor + validação pós-apply + regenera audit). Merge na `main` ≠ produção.
- **prove-sql-money-path** obrigatório para a RPC ANTES de entregar a migration (plpgsql/sql late-bound; `BEGIN ATOMIC` pega `42P01`/`42703` no CREATE, mas o comportamento só o PG17 prova).
- **Segurança da RPC:** `SECURITY INVOKER` + `SET search_path=''` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role`.
- **Rollout:** `NOTIFY pgrst,'reload schema'` + 1 chamada real via service_role ANTES do deploy dos edges (evita `PGRST202`).
- **pt-BR** em código/rotas/commits/PRs. `heavy` prefixando test/build/typecheck.
- **Assinatura estável:** a função nasce com `p_account` (não usado no PR-1, reservado p/ `client_to_user` no PR-2) para o PR-2 ser `CREATE OR REPLACE` puro, sem DROP de assinatura.

---

### Task 1: RPC `omie_sync_identity_snapshot` provada no PG17

**Files:**
- Create (via `lovable-db-operator` na Task 5): `supabase/migrations/<ts>_omie_sync_identity_snapshot.sql`
- Create: `db/test-omie-identidade-snapshot.sh`

**Interfaces:**
- Produces: `public.omie_sync_identity_snapshot(p_account text) RETURNS jsonb` — objeto `{doc_to_user: {<doc>:<uuid>}, ambiguous_docs: [<doc>], client_to_user: {}}`.

- [ ] **Step 1: Escrever a migration SQL (fonte da verdade da RPC)**

Salvar este SQL num arquivo de trabalho `scratchpad/pr1-rpc.sql` (a Task 5 o transforma em migration versionada via `lovable-db-operator`):

```sql
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document, '\D', '', 'g') AS doc, p.user_id
    FROM public.profiles p
    WHERE p.document IS NOT NULL
      AND length(regexp_replace(p.document, '\D', '', 'g')) >= 11
  ),
  doc_agg AS (
    SELECT doc,
           count(DISTINCT user_id) AS n_users,
           min(user_id::text)      AS user_id   -- único quando n_users = 1
    FROM doc_valid
    GROUP BY doc
  )
  SELECT jsonb_build_object(
    'doc_to_user',
      coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs',
      coalesce((SELECT jsonb_agg(doc ORDER BY doc)   FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user', '{}'::jsonb   -- PR-2: prova positiva por (account=p_account, evidence_document)
  );
END;

REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;
```

- [ ] **Step 2: Escrever o harness PG17 (asserts positivos, negativos, RLS, falsificação)**

Criar `db/test-omie-identidade-snapshot.sh`. Reusar o boilerplate de arranque PG17 de `db/test-authz-estimar-estoque-omie.sh` (linhas 1–60: `initdb`/`pg_ctl`/`stubs-supabase.sql`/`auth.uid()`/`auth.role()`/helpers `ok`/`bad`/`eq`). Corpo específico:

```bash
# ── schema mínimo: profiles + a RPC real (colada da migration) ──
P -q <<'SQL'
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text);
SQL
P -q -f "$REPO_ROOT/scratchpad/pr1-rpc.sql"

# ── seed: doc único, doc ambíguo, doc<11, doc mascarado ──
P -q <<'SQL'
INSERT INTO public.profiles(user_id, document) VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111111'),      -- único
  ('00000000-0000-0000-0000-000000000002', '222.222.222-22'),   -- ambíguo (mascarado)
  ('00000000-0000-0000-0000-000000000003', '22222222222'),      -- ambíguo (mesmo doc, outro user)
  ('00000000-0000-0000-0000-000000000004', '333.333.333-33'),   -- único, normaliza
  ('00000000-0000-0000-0000-000000000005', '123');              -- doc<11, excluído
SQL

SNAP() { Pq -c "SET ROLE service_role; SELECT public.omie_sync_identity_snapshot('oben');"; }

# ZONA POSITIVA
eq "doc único → doc_to_user" \
   "$(Pq -c "SET ROLE service_role; SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'11111111111';")" \
   "00000000-0000-0000-0000-000000000001"
eq "doc mascarado normaliza → doc_to_user" \
   "$(Pq -c "SET ROLE service_role; SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'33333333333';")" \
   "00000000-0000-0000-0000-000000000004"

# ZONA NEGATIVA (fail-closed)
eq "doc ambíguo FORA de doc_to_user" \
   "$(Pq -c "SET ROLE service_role; SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;")" "t"
eq "doc ambíguo LISTADO em ambiguous_docs" \
   "$(Pq -c "SET ROLE service_role; SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"22222222222\"]';")" "t"
eq "doc<11 excluído de tudo" \
   "$(Pq -c "SET ROLE service_role; SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'123') IS NULL;")" "t"
eq "client_to_user vazio no PR-1" \
   "$(Pq -c "SET ROLE service_role; SELECT public.omie_sync_identity_snapshot('oben')->>'client_to_user';")" "{}"

# ZONA RLS / EXECUTE gate (42501)
for R in anon authenticated; do
  if Pq -c "SET ROLE $R; SELECT public.omie_sync_identity_snapshot('oben');" 2>/dev/null; then
    bad "$R NÃO deveria executar a RPC (esperado 42501)"
  else
    ok "$R barrado no EXECUTE (42501)"
  fi
done
```

- [ ] **Step 3: Rodar o harness — deve passar VERDE**

Run: `heavy bash db/test-omie-identidade-snapshot.sh > /tmp/t1.log 2>&1; echo $?`
Expected: exit `0`, todos `✅`, zero `❌` (ver `FAIL=0` no rodapé).

- [ ] **Step 4: FALSIFICAR — provar que os asserts têm dente**

Editar temporariamente `scratchpad/pr1-rpc.sql`: trocar `WHERE n_users = 1` (do `doc_to_user`) por `WHERE true` (deixa o doc ambíguo vazar para `doc_to_user`).
Run: `heavy bash db/test-omie-identidade-snapshot.sh > /tmp/t1-falso.log 2>&1; echo $?`
Expected: exit ≠ `0`, o assert "doc ambíguo FORA de doc_to_user" fica `❌` (vermelho). **Reverter** a edição (`WHERE n_users = 1`) e re-rodar Step 3 → verde de novo.

- [ ] **Step 5: Commit**

```bash
git add db/test-omie-identidade-snapshot.sh scratchpad/pr1-rpc.sql
git commit -m "test(money-path): prova PG17 da RPC omie_sync_identity_snapshot (A1, doc_to_user + ambiguous_docs + RLS 42501 + falsificação)"
```

---

### Task 2: `omie-vendas-sync` consome a RPC (fim da paginação keyset)

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts` (bloco ~890–935 e o MIRROR ~1666–1690)

**Interfaces:**
- Consumes: `omie_sync_identity_snapshot(p_account)` (Task 1).
- Produces: `docToUserMap: Map<string,string>` + `ambiguousDocs: Set<string>` no escopo de `syncPedidos` (nomes que o `resolveClientUserId:1041` e as métricas usam).

- [ ] **Step 1: Substituir o bloco de paginação keyset pela chamada RPC**

Remover as linhas ~890–935 (o `while(hasMore)` que pagina `profiles` + `buildDocUserMapFailClosed(profileDocRegistros)` + `docsAmbiguos`) e colocar:

```ts
// ── Snapshot atômico de identidade doc→user (RPC server-side) — fecha a corrida A1 ──
// Antes: paginação keyset de profiles (não-atômica: profile nascendo/mudando entre páginas
// escapava da detecção de doc-ambíguo). Agora: 1 query STABLE = 1 snapshot MVCC. doc ambíguo
// (2+ users distintos) já vem FORA de doc_to_user e listado em ambiguous_docs (métrica separada).
// .rpc() NÃO lança em erro (resolve {error}) → checar e FAIL-CLOSED (throw): mapa parcial silencioso
// causaria atribuição arbitrária no fallback.
const { data: snap, error: snapErr } = await supabase.rpc('omie_sync_identity_snapshot', { p_account: account });
if (snapErr) throw new Error(`identity snapshot (${account}): ${snapErr.message}`);
const docToUserMap = new Map<string, string>(Object.entries((snap?.doc_to_user ?? {}) as Record<string, string>));
const ambiguousDocs = new Set<string>((snap?.ambiguous_docs ?? []) as string[]);
console.log(`[sync_pedidos][${account}] Identity snapshot: ${docToUserMap.size} doc(s) único(s), ${ambiguousDocs.size} ambíguo(s) (fail-closed server-side)`);
```

- [ ] **Step 2: Remover o MIRROR `buildDocUserMapFailClosed` órfão do edge**

Deletar o bloco `// MIRROR-START omie doc-user-fail-closed` … `// MIRROR-END` (~1666–1690) — a lógica agora é SQL, o helper TS não é mais chamado.

- [ ] **Step 3: Rodar typecheck (o edge é Deno, mas o repo TS pega imports quebrados)**

Run: `heavy bun run typecheck > /tmp/tc2.log 2>&1; echo $?`
Expected: exit `0` (sem referência pendente a `buildDocUserMapFailClosed`).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(omie-vendas-sync): docToUserMap via RPC omie_sync_identity_snapshot (fecha corrida de paginação A1)"
```

---

### Task 3: `omie-analytics-sync` consome a RPC (fim do OFFSET P1b)

**Files:**
- Modify: `supabase/functions/omie-analytics-sync/index.ts:251-280` (`fetchProfileDocUserMap`)

**Interfaces:**
- Consumes: `omie_sync_identity_snapshot(p_account)` (Task 1).
- Produces: `Map<string,string>` (mesma assinatura de retorno de `fetchProfileDocUserMap`, consumido em `syncCustomers:310`).

- [ ] **Step 1: Reescrever `fetchProfileDocUserMap` como chamada RPC**

Substituir o corpo inteiro da função (paginação OFFSET + set `ambiguous`) por:

```ts
// Map<documento_normalizado, user_id> não-ambíguo de profiles, via snapshot atômico server-side
// (RPC). Antes: paginação OFFSET (não-atômica). A conta é irrelevante p/ doc_to_user (profiles não
// tem conta); passamos a conta em curso só p/ satisfazer a assinatura. .rpc() não lança → fail-closed.
async function fetchProfileDocUserMap(db: SupabaseClient, account: string): Promise<Map<string, string>> {
  const { data: snap, error } = await db.rpc('omie_sync_identity_snapshot', { p_account: account });
  if (error) throw new Error(`identity snapshot (${account}): ${error.message}`);
  return new Map<string, string>(Object.entries((snap?.doc_to_user ?? {}) as Record<string, string>));
}
```

Atualizar a chamada em `syncCustomers` (~310) para passar `account`: `const userByDoc = await fetchProfileDocUserMap(db, account);`.

- [ ] **Step 2: typecheck**

Run: `heavy bun run typecheck > /tmp/tc3.log 2>&1; echo $?`
Expected: exit `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/omie-analytics-sync/index.ts
git commit -m "feat(omie-analytics-sync): fetchProfileDocUserMap via RPC (fecha corrida OFFSET do P1b, A1)"
```

---

### Task 4: Canário de deploy + sentinela anti-reversão + limpeza do helper órfão

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts` (novo `case "identidade_snapshot_probe"` perto de `identidade_probe:3049`)
- Modify: `src/__tests__/edge-money-path-invariants.test.ts`
- Delete: `src/lib/omie/omie-doc-user-map.ts`, `src/lib/omie/omie-doc-user-map.test.ts`

**Interfaces:**
- Consumes: `omie_sync_identity_snapshot` deployada.

- [ ] **Step 1: Canário comportamental de DEPLOY da RPC**

Adicionar no switch de actions (gated por `authorizeCronOrStaff` como as demais), ao lado de `identidade_probe`:

```ts
case "identidade_snapshot_probe": {
  // CANÁRIA DE DEPLOY da RPC omie_sync_identity_snapshot — read-only, não escreve, não chama Omie.
  // Prova que a RPC subiu no MESMO build (senão PGRST202) e tem a FORMA certa. NÃO prova o fail-closed
  // comportamental (doc-ambíguo=0 em prod → ambiguous_docs=[] hoje); esse é provado no PG17 (semeado).
  // Invariante observável exigido: doc_to_user e ambiguous_docs são DISJUNTOS (nenhum doc de um
  // aparece no outro) — se a RPC regredisse p/ fail-open, um doc ambíguo vazaria p/ doc_to_user.
  const { data: snap, error } = await supabaseAdmin.rpc('omie_sync_identity_snapshot', { p_account: 'oben' });
  const d2u = (snap?.doc_to_user ?? {}) as Record<string, string>;
  const amb = (snap?.ambiguous_docs ?? []) as string[];
  const disjoint = amb.every((doc) => !(doc in d2u));
  const shapeOk = !!snap && typeof d2u === 'object' && Array.isArray(amb) && typeof snap.client_to_user === 'object';
  return json({ canary: true, ok: !error && shapeOk && disjoint, responded: !error, docs_unicos: Object.keys(d2u).length, ambiguos: amb.length, disjoint });
}
```

- [ ] **Step 2: Sentinela textual anti-reversão-Lovable no invariants test**

Adicionar em `src/__tests__/edge-money-path-invariants.test.ts` um `describe` que lê `supabase/functions/omie-vendas-sync/index.ts` e assere:

```ts
describe('guardrail money-path: omie-vendas-sync resolve identidade pela RPC atômica (não pagina profiles)', () => {
  const edge = readFileSync('supabase/functions/omie-vendas-sync/index.ts', 'utf8');
  it('sentinela: leu o edge real', () => { expect(edge.length).toBeGreaterThan(1000); });
  it('CHAMA a RPC omie_sync_identity_snapshot', () => {
    expect(edge).toContain("omie_sync_identity_snapshot");
  });
  it('NÃO reintroduziu paginação de profiles p/ o docToUserMap (reversão do Lovable)', () => {
    expect(edge).not.toContain('buildDocUserMapFailClosed');
  });
});
```

- [ ] **Step 3: Deletar o helper órfão + seu test + o assert de paridade obsoleto**

```bash
git rm src/lib/omie/omie-doc-user-map.ts src/lib/omie/omie-doc-user-map.test.ts
```
Remover de `src/__tests__/edge-money-path-invariants.test.ts` o `describe` antigo que provava a PARIDADE do MIRROR `buildDocUserMapFailClosed` (agora inexistente).

- [ ] **Step 4: Rodar a suíte de invariantes + knip (deadcode)**

Run: `heavy bun run test src/__tests__/edge-money-path-invariants.test.ts > /tmp/t4.log 2>&1; echo $?`
Expected: exit `0` (novos asserts verdes, nenhum assert órfão referenciando o helper deletado).
Run: `heavy bunx knip > /tmp/knip4.log 2>&1; echo $?`
Expected: exit `0` (sem unused export por causa do helper removido).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/omie-vendas-sync/index.ts src/__tests__/edge-money-path-invariants.test.ts
git commit -m "test(money-path): canária identidade_snapshot_probe + sentinela anti-reversão; remove helper doc-user órfão (lógica virou SQL)"
```

---

### Task 5: Empacotar migration + gate final + PR

**Files:**
- Create: `supabase/migrations/<ts>_omie_sync_identity_snapshot.sql` (via skill)

- [ ] **Step 1: Empacotar a migration (skill `lovable-db-operator`)**

Invocar `lovable-db-operator` com o SQL de `scratchpad/pr1-rpc.sql`. A skill: gera o arquivo `supabase/migrations/<ts>_omie_sync_identity_snapshot.sql`, o bloco pronto pro SQL Editor (incluindo `NOTIFY pgrst,'reload schema';` ao final), a query de validação pós-apply (`SELECT pg_get_functiondef('public.omie_sync_identity_snapshot(text)'::regprocedure);` + 1 chamada real via service_role), a nota pro PR e regenera o audit.

- [ ] **Step 2: Gate completo**

Run: `heavy bun run typecheck > /tmp/g.log 2>&1 && heavy bun run test > /tmp/g2.log 2>&1 && heavy bun run lint > /tmp/g3.log 2>&1; echo $?`
Expected: exit `0`.

- [ ] **Step 3: `/codex challenge xhigh` do diff (money-path)**

Rodar via `scripts/codex-async.sh` em background (transporte do projeto), prompt = challenge adversarial do diff do PR-1 (a RPC + os 2 edges + canário). Apresentar o parecer cru + calibração separada. Endereçar P1 antes de sair do draft.

- [ ] **Step 4: Abrir PR (DRAFT até prove-sql + codex verdes; depois ready → auto-merge)**

```bash
git push -u origin claude/infallible-kepler-ac5e97
gh pr create --draft --title "feat(omie): RPC identidade por snapshot atômico — PR-1 (A1, fecha corrida de paginação)" --body "<corpo: link pro spec + plano; pendências de deploy do founder (SQL Editor + NOTIFY pgrst + deploy das 2 edges verbatim + canário verde); parecer codex>"
```
Armar `scripts/pr-watch.sh <nº>` em background. Ao sair do draft, o auto-merge cuida do squash quando o CI `validate` passar.

- [ ] **Step 5: Handoff de deploy ao founder (skill `lovable-deploy-verify`)**

Montar o checklist: (1) colar a migration no SQL Editor + `NOTIFY pgrst`; (2) validar via psql-ro (`pg_get_functiondef` + chamada service_role); (3) deploy das 2 edges pelo chat do Lovable (verbatim); (4) rodar `identidade_snapshot_probe` staff → `ok:true`.

---

## Self-Review

**Spec coverage (§ do design → task):**
- §4.1 RPC (`sql STABLE`/`INVOKER`/`search_path`/`REVOKE PUBLIC`/`GRANT service_role`/`BEGIN ATOMIC`) → Task 1 Step 1. ✓
- §4.1 `doc_to_user` + `ambiguous_docs`; `client_to_user` vazio no PR-1 → Task 1 Step 1 + asserts Task 1 Step 2. ✓
- §4.1 rollout `NOTIFY pgrst` + chamada real → Task 5 Step 1. ✓
- §4.4 edges consomem `doc_to_user` (fim da paginação) → Tasks 2, 3. ✓
- §7 gate: prove-sql (Task 1) + canário comportamental RPC real (Task 4 Step 1) + sentinela textual (Task 4 Step 2) + typecheck/test/lint (Task 5 Step 2) + codex challenge (Task 5 Step 3). ✓
- §8 deploy Lovable 3 camadas → Task 5 Steps 1,4,5. ✓
- A2/A3 (client_to_user, tabela order-level) → **fora do PR-1** (PR-2/PR-3), por design. ✓

**Placeholder scan:** SQL, harness e diffs dos edges têm conteúdo real. O corpo do PR (Task 5 Step 4) é o único texto livre — aceitável (prosa de handoff). ✓

**Type consistency:** `docToUserMap: Map<string,string>` e `ambiguousDocs: Set<string>` (Task 2) batem com o consumo em `resolveClientUserId` (`docToUserMap.get(doc)`). `fetchProfileDocUserMap(db, account)` (Task 3) mantém retorno `Map<string,string>`. A RPC retorna sempre as 3 chaves (`client_to_user` vazio) — os edges leem só `doc_to_user`/`ambiguous_docs`. ✓
