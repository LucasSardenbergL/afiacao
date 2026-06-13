# Persistência das extrações de boletim (rascunhos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (fresh subagent per task + two-stage review). Steps use `- [ ]`.

**Goal:** A edge `kb-extract-specs` passa a PERSISTIR cada extração num rascunho (`kb_extraction_drafts`), com cache-first + claim atômico, pra o founder nunca re-extrair nem re-pagar a Anthropic.

**Architecture:** Tabela `kb_extraction_drafts` (1 linha/documento, master-only) + RPC SQL `kb_extraction_draft_claim` (claim condicional — o PostgREST não expressa `ON CONFLICT WHERE`). A edge: gate master-only → cache-first → claim → Claude 1× → persist-before-response (compare-and-set por `claim_token`). O front hidrata a fila a partir dos rascunhos `ready` ao abrir; "Extrair pendentes" só dispara os sem rascunho; "Re-extrair" é explícito.

**Tech Stack:** Supabase Postgres + edge Deno (`@anthropic-ai/sdk`) + React (React Query) + vitest + PG17 local (`db/verify-snapshot-replay.sh`).

**Spec:** `docs/superpowers/specs/2026-06-13-kb-persistir-extracoes-design.md`

**Contrato da edge (novo):**
- Request: `{ documentId: string, force?: boolean }`.
- Response `200`:
  - sucesso/cache: `{ specs: KbExtractedSpec, cached?: boolean, usage?: {...} }`.
  - claim perdido (outra aba extraindo): `{ status: "extracting" }` (sem `specs`). ⚠️ É `200`, NÃO 4xx — `invokeFunction` lança em qualquer non-2xx; o front trata `status:"extracting"` como "pulado", não erro.
- non-2xx: erro real (doc não encontrado, Claude falhou, etc.).

---

## File Structure

- `supabase/migrations/20260613160000_kb_extraction_drafts.sql` — **criar**: tabela + trigger + RLS + REVOKE + RPC `kb_extraction_draft_claim`.
- `db/test-kb-extraction-drafts.sh` — **criar**: validação PG17 (claim atômico, RLS, falsificação).
- `supabase/functions/_shared/auth.ts` — **modificar**: + `authorizeMaster`.
- `supabase/functions/kb-extract-specs/index.ts` — **modificar**: gate master + cache-first + claim + persist + force.
- `src/lib/knowledge-base/extraction-drafts.ts` — **criar**: helpers puros (`mesclarResultados`, `docsParaExtrair`).
- `src/lib/knowledge-base/__tests__/extraction-drafts.test.ts` — **criar**: vitest.
- `src/hooks/useExtractionDrafts.ts` — **criar**: query dos rascunhos da fila.
- `src/hooks/useBatchExtract.ts` / `src/hooks/useExtractSpecs.ts` — **modificar**: tratar `{status:"extracting"}`.
- `src/components/knowledge-base/ApprovalQueueSection.tsx` — **modificar**: hidratação + extrair-só-pendentes + re-extrair.
- `src/hooks/useBulkApproveSpecs.ts` — **modificar**: DELETE do rascunho após aprovar.

---

## Task 1: Migration `kb_extraction_drafts` + RPC de claim + PG17

**Files:**
- Create: `supabase/migrations/20260613160000_kb_extraction_drafts.sql`
- Create: `db/test-kb-extraction-drafts.sh`

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260613160000_kb_extraction_drafts.sql
-- Persistência das extrações de boletim (rascunhos): a edge kb-extract-specs salva
-- cada extração aqui → cache-first + claim atômico → founder nunca re-paga a Anthropic.
-- Spec: docs/superpowers/specs/2026-06-13-kb-persistir-extracoes-design.md
-- ⚠️ MANUAL no SQL Editor do Lovable. Idempotente (re-rodável).

CREATE TABLE IF NOT EXISTS public.kb_extraction_drafts (
  document_id   uuid PRIMARY KEY REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'extracting'
                  CHECK (status IN ('extracting','ready','failed')),
  spec          jsonb,
  claim_token   uuid,
  started_at    timestamptz,
  extracted_at  timestamptz,
  last_error    text,
  model         text,
  usage         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- trigger updated_at (função canônica genérica do projeto)
DROP TRIGGER IF EXISTS trg_kb_extraction_drafts_updated_at ON public.kb_extraction_drafts;
CREATE TRIGGER trg_kb_extraction_drafts_updated_at
  BEFORE UPDATE ON public.kb_extraction_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kb_extraction_drafts ENABLE ROW LEVEL SECURITY;

-- RLS: SELECT/DELETE master (curadoria master-only, = predicado da 0c).
--      INSERT/UPDATE: NENHUMA policy de usuário → só service_role (a edge) escreve.
DROP POLICY IF EXISTS kb_extraction_drafts_select_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_select_master ON public.kb_extraction_drafts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::app_role));

DROP POLICY IF EXISTS kb_extraction_drafts_delete_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_delete_master ON public.kb_extraction_drafts
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::app_role));

REVOKE ALL ON public.kb_extraction_drafts FROM anon;

-- RPC de claim atômico: ON CONFLICT ... DO UPDATE ... WHERE (não expressável via PostgREST .upsert).
-- Retorna TRUE se ESTE chamador ganhou o claim; FALSE se há um claim 'extracting' fresco de outro.
-- INVOKER (default): roda com os privilégios do caller; só service_role (a edge) chama → bypassa RLS.
CREATE OR REPLACE FUNCTION public.kb_extraction_draft_claim(
  p_document_id uuid,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_claimed uuid;
BEGIN
  INSERT INTO public.kb_extraction_drafts (document_id, status, claim_token, started_at, updated_at)
  VALUES (p_document_id, 'extracting', p_claim_token, now(), now())
  ON CONFLICT (document_id) DO UPDATE
    SET status      = 'extracting',
        claim_token = p_claim_token,
        started_at  = now(),
        last_error  = NULL,
        updated_at  = now()
    WHERE kb_extraction_drafts.status <> 'extracting'
       OR kb_extraction_drafts.started_at < now() - interval '5 minutes'
  RETURNING claim_token INTO v_claimed;
  -- v_claimed = p_claim_token se inseriu/atualizou (ganhou); NULL se o WHERE bloqueou (claim fresco de outro).
  RETURN v_claimed IS NOT DISTINCT FROM p_claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.kb_extraction_draft_claim(uuid, uuid) FROM anon, authenticated, public;

-- validação inline
SELECT 'kb_extraction_drafts OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename='kb_extraction_drafts') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname='kb_extraction_draft_claim') AS rpc;
```

- [ ] **Step 2: Escrever o teste PG17 `db/test-kb-extraction-drafts.sh`**

Espelhe a estrutura de `db/test-kb-0c-aprovacao.sh` (mesmo harness: PG17 local, schema-snapshot + a migration, `SET ROLE authenticated` + GUC `test.uid` pra exercer a RLS — o psql é superuser e BYPASSA RLS, então sem `SET ROLE` o teste de RLS é teatro). Cubra (cada assert imprime PASS/FAIL e o script sai !=0 em qualquer FAIL):

- **A1 — claim ganha 1×:** `SELECT kb_extraction_draft_claim('<doc>', gen_random_uuid())` → TRUE; a linha existe com `status='extracting'`.
- **A2 — claim fresco bloqueia o 2º:** logo após A1 (started_at = now), outro `kb_extraction_draft_claim('<doc>', <outro token>)` → FALSE (não re-paga).
- **A3 — claim STALE re-claimável:** force `started_at = now() - interval '10 min'` → novo claim → TRUE; `claim_token` mudou.
- **A4 — finalize compare-and-set:** UPDATE status='ready', spec, WHERE document_id E claim_token=<meu> → 1 linha. Com `claim_token` ERRADO → 0 linhas (não pisa claim novo).
- **A5 — RLS SELECT:** `SET ROLE authenticated; SET request.jwt.claim... ` com uid MASTER (semear `user_roles`) → vê a linha; uid EMPLOYEE → 0 linhas; sem role → 0.
- **A6 — RLS INSERT direto barrado:** authenticated (mesmo master) tentando `INSERT INTO kb_extraction_drafts ...` → erro (sem policy de INSERT). Capture a SQLSTATE esperada (42501) e re-lance o resto.
- **A7 — RLS DELETE:** authenticated MASTER `DELETE` → ok; EMPLOYEE → 0 linhas.
- **A8 — RPC barrada p/ authenticated:** `SET ROLE authenticated; SELECT kb_extraction_draft_claim(...)` → erro de permissão (42501).
- **A9 — FALSIFICAÇÃO:** sabote a policy de SELECT (recrie como `USING (true)`), re-rode A5-employee e EXIJA que ele agora ENXERGUE (prova que A5 realmente filtra); depois restaure. A sentinela do erro NÃO pode conter "master"/"forbidden" (senão um ILIKE casaria a própria sentinela — lição do §10).

- [ ] **Step 3: Rodar o PG17**

Run: `bash db/test-kb-extraction-drafts.sh > /tmp/pg17-drafts.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0` e todos os asserts PASS no log. (⚠️ nunca `| tail` — engole o exit.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613160000_kb_extraction_drafts.sql db/test-kb-extraction-drafts.sh
git commit -m "feat(kb): tabela kb_extraction_drafts + RPC de claim atômico (PG17)"
```

---

## Task 2: `authorizeMaster` + reescrita da edge `kb-extract-specs`

**Files:**
- Modify: `supabase/functions/_shared/auth.ts`
- Modify: `supabase/functions/kb-extract-specs/index.ts`

- [ ] **Step 1: Adicionar `authorizeMaster` em `_shared/auth.ts`**

Espelha `authorizeCronOrStaff`, MAS: sem cron (extração é on-demand), `allowed = {master}` (não employee). Mantém o branch `service_role` (chamadas internas).

```ts
/**
 * Master-only gate. Aceita:
 *  - Authorization: Bearer <SERVICE_ROLE_KEY>
 *  - Authorization: Bearer <user JWT> com role 'master'
 * NÃO aceita cron nem employee (a curadoria/custo de IA é só do master — alinha com a 0c).
 */
export async function authorizeMaster(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized() };
  }
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) {
    return { ok: true, via: "service_role" };
  }
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
    });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };

    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    if (roles.some((r) => r.role === "master")) {
      return { ok: true, via: "staff", userId: user.id };
    }
    return { ok: false, response: unauthorized("Forbidden") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}
```

- [ ] **Step 2: Reescrever o handler da edge `kb-extract-specs/index.ts`**

Trocar `authorizeCronOrStaff` → `authorizeMaster`. Após validar o doc (mantém a lógica atual de buscar o doc + checar `ready`), inserir o fluxo cache-first → claim → Claude → persist. Use o `supabase` client (service_role) já criado. Estrutura (preserve o bloco de chamada ao Claude que já existe — só capture `spec` e `usage` em vez de retornar direto):

```ts
const auth = await authorizeMaster(req);
if (!auth.ok) return auth.response;
// ... parse { documentId, force } ; valida doc ready (como hoje) ...

// CACHE-FIRST
const { data: existing } = await supabase
  .from("kb_extraction_drafts")
  .select("status, spec")
  .eq("document_id", documentId)
  .maybeSingle();
if (!force && existing?.status === "ready" && existing.spec) {
  return new Response(JSON.stringify({ specs: existing.spec, cached: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// CLAIM atômico
const claimToken = crypto.randomUUID();
const { data: gotClaim, error: claimErr } = await supabase
  .rpc("kb_extraction_draft_claim", { p_document_id: documentId, p_claim_token: claimToken });
if (claimErr) {
  return new Response(JSON.stringify({ error: `claim falhou: ${claimErr.message}` }), {
    status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
if (gotClaim !== true) {
  // outra aba está extraindo (claim fresco). 200 (não-erro) — o front pula.
  return new Response(JSON.stringify({ status: "extracting" }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// CHAMA O CLAUDE 1× (bloco existente). Em erro, marca failed e devolve non-2xx:
let spec, usage;
try {
  // ... response = await client.messages.create(...) ...
  // ... extrai tool_use input → spec ; usage = response.usage ...
} catch (e) {
  await supabase.from("kb_extraction_drafts")
    .update({ status: "failed", last_error: String(e instanceof Error ? e.message : e) })
    .eq("document_id", documentId).eq("claim_token", claimToken);
  return new Response(JSON.stringify({ error: ... }), { status: 502, ... });
}

// PERSIST-BEFORE-RESPONSE (compare-and-set por claim_token — não pisa claim novo)
await supabase.from("kb_extraction_drafts")
  .update({
    status: "ready", spec, extracted_at: new Date().toISOString(),
    usage, model: "claude-sonnet-4-6", last_error: null,
  })
  .eq("document_id", documentId).eq("claim_token", claimToken);

return new Response(JSON.stringify({ specs: spec, usage }), {
  status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```

⚠️ Preserve EXATAMENTE o bloco de prompt/tool do Claude que já existe (não reescrever o prompt). Só capturar `spec`/`usage` e persistir.

- [ ] **Step 3: typecheck (deno) — best-effort**

A edge Deno não roda no `bun run typecheck` (é Deno). Confirme visualmente que imports (`authorizeMaster`, `crypto.randomUUID`) batem. Não há suite Deno no CI (CLAUDE.md §5 lição b).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/auth.ts supabase/functions/kb-extract-specs/index.ts
git commit -m "feat(kb): edge kb-extract-specs cache-first + claim + persist + gate master-only"
```

---

## Task 3: Front — hidratação da fila + extrair-só-pendentes + re-extrair + DELETE ao aprovar

**Files:**
- Create: `src/lib/knowledge-base/extraction-drafts.ts`
- Create: `src/lib/knowledge-base/__tests__/extraction-drafts.test.ts`
- Create: `src/hooks/useExtractionDrafts.ts`
- Modify: `src/hooks/useBatchExtract.ts`, `src/hooks/useExtractSpecs.ts`
- Modify: `src/components/knowledge-base/ApprovalQueueSection.tsx`
- Modify: `src/hooks/useBulkApproveSpecs.ts`

- [ ] **Step 1: Helpers puros (TDD — escrever o teste primeiro)**

`src/lib/knowledge-base/extraction-drafts.ts`:

```ts
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

/**
 * Mescla os resultados vindos do banco (rascunhos `ready` persistidos) com os da
 * sessão atual em memória. Dedup por documentId; a MEMÓRIA vence (é o mais fresco
 * da sessão — ex.: uma re-extração feita agora). Preserva ordem: memória, depois banco.
 */
export function mesclarResultados(
  banco: ResultadoExtracao[],
  memoria: ResultadoExtracao[],
): ResultadoExtracao[] {
  const vistos = new Set(memoria.map((r) => r.documentId));
  return [...memoria, ...banco.filter((r) => !vistos.has(r.documentId))];
}

/**
 * Decide quais documentos da fila precisam de extração: os que NÃO têm rascunho
 * `ready`. Os demais (com rascunho ready) já estão salvos → não re-extrair.
 * (Docs em claim 'extracting'/failed entram aqui; a EDGE protege o custo via claim/cache.)
 */
export function docsParaExtrair(filaIds: string[], draftsReadyIds: Set<string>): string[] {
  return filaIds.filter((id) => !draftsReadyIds.has(id));
}
```

Teste `__tests__/extraction-drafts.test.ts`: cobre dedup (memória vence sobre banco do mesmo doc), ordem, banco-vazio, memória-vazia; `docsParaExtrair` filtra os ready, mantém os sem-ready, lista vazia.

Run: `bun run test src/lib/knowledge-base/__tests__/extraction-drafts.test.ts` → PASS.

- [ ] **Step 2: Hook `useExtractionDrafts`**

```ts
// src/hooks/useExtractionDrafts.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';

export interface ExtractionDraftsData {
  /** rascunhos prontos (com spec), prontos pra particionar/hidratar */
  ready: ResultadoExtracao[];
  /** ids com claim em extração (status='extracting') */
  extractingIds: Set<string>;
  /** ids que falharam (status='failed') */
  failedIds: Set<string>;
}

/** Carrega os rascunhos de extração dos documentos da fila (master-only via RLS). */
export function useExtractionDrafts(documentIds: string[]) {
  const key = [...documentIds].sort();
  return useQuery({
    queryKey: ['kb-extraction-drafts', key],
    enabled: documentIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<ExtractionDraftsData> => {
      const { data, error } = await supabase
        .from('kb_extraction_drafts')
        .select('document_id, status, spec')
        .in('document_id', documentIds);
      if (error) throw error;
      const ready: ResultadoExtracao[] = [];
      const extractingIds = new Set<string>();
      const failedIds = new Set<string>();
      for (const row of data ?? []) {
        if (row.status === 'ready' && row.spec) {
          ready.push({ documentId: row.document_id, spec: normalizeExtractedSpec(row.spec as KbExtractedSpec) });
        } else if (row.status === 'extracting') extractingIds.add(row.document_id);
        else if (row.status === 'failed') failedIds.add(row.document_id);
      }
      return { ready, extractingIds, failedIds };
    },
  });
}
```

⚠️ Se `kb_extraction_drafts` não estiver no `types.ts` gerado (o Lovable só regenera após a migration aplicar), use cast `as never`/`as any` PONTUAL na chamada `.from('kb_extraction_drafts')` (lição §10 — NÃO adicionar a tabela ao types.ts à mão). Documente com um comentário.

- [ ] **Step 3: `useBatchExtract` / `useExtractSpecs` — tratar `{status:"extracting"}`**

A resposta da edge agora pode ser `{ status: "extracting" }` (sem `specs`). Em `useBatchExtract.worker` e `useExtractSpecs.mutationFn`: se `response.status === "extracting"` (e sem `specs`), NÃO chamar `normalizeExtractedSpec` (quebra com null) e NÃO contar como resultado nem erro — incrementa `feitos` e segue (o doc está em extração por outra aba). Tipar `ExtractResponse` como `{ specs?: KbExtractedSpec; status?: 'extracting'; cached?: boolean; usage?: {...} }`.

- [ ] **Step 4: `ApprovalQueueSection` — hidratação + extrair-só-pendentes + re-extrair**

- `const fila = useApprovalQueue();`
- `const drafts = useExtractionDrafts((fila.data ?? []).map(d => d.id));`
- resultados a particionar = `mesclarResultados(drafts.data?.ready ?? [], extract.resultados)`.
- `particionarResultados(mesclado)` → auto/revisar (igual hoje, mas sobre o mesclado).
- `const pendentes = docsParaExtrair((fila.data??[]).map(d=>d.id), new Set((drafts.data?.ready??[]).map(r=>r.documentId)));`
- "Extrair pendentes (N)" → `N = pendentes.length`; `handleExtrair` chama `extract.run(pendentes)` (não a fila toda); ao terminar, `drafts.refetch()`.
- Cada item (auto e revisar): botão **"Re-extrair"** → `window.confirm`/AlertDialog "Re-extrair gasta saldo da Anthropic de novo. Continuar?" → `extract.run([documentId], )` com `force:true` (propagar `force` no `run`/`invokeFunction` body) → `drafts.refetch()`.
  - `useBatchExtract.run(ids, opts?: {force?:boolean})` passa `{ documentId, force }` no body.
- invalidar/`refetch` `kb-extraction-drafts` após aprovar (o DELETE do Step 6).

- [ ] **Step 5: `useBulkApproveSpecs` + `handleRevisado` — DELETE do rascunho após aprovar**

Em `useBulkApproveSpecs.approve`, após `ok += 1` (save bem-sucedido), DELETE best-effort: `await supabase.from('kb_extraction_drafts').delete().eq('document_id', documentId);` (ignora erro — lixo inofensivo; RLS DELETE master permite). No `ApprovalQueueSection.handleRevisado(documentId)` (revisão manual salva), idem: DELETE best-effort do rascunho daquele doc. Invalidar `['kb-extraction-drafts']` no fim.

- [ ] **Step 6: typecheck + test + lint**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"` (Expected `TC=0`)
Run: `bun run test src/lib/knowledge-base > /tmp/t.log 2>&1; echo "T=$?"` (Expected `T=0`)
Run: `bun lint 2>&1 | grep -c error` (Expected `0`)

- [ ] **Step 7: Commit**

```bash
git add src/lib/knowledge-base/extraction-drafts.ts src/lib/knowledge-base/__tests__/ \
  src/hooks/useExtractionDrafts.ts src/hooks/useBatchExtract.ts src/hooks/useExtractSpecs.ts \
  src/components/knowledge-base/ApprovalQueueSection.tsx src/hooks/useBulkApproveSpecs.ts
git commit -m "feat(kb): front hidrata a fila dos rascunhos + extrair-só-pendentes + re-extrair"
```

---

## Task 4: Codex adversarial + PR

- [ ] **Step 1: Codex adversarial no SQL (migration + RPC) e no diff da edge**

`codex exec` (read-only, `model_reasoning_effort="xhigh"` — money-adjacent: corrida de custo) revisando: (a) a RPC de claim (corrida, ON CONFLICT WHERE, INVOKER+REVOKE), (b) o gate master da edge, (c) o compare-and-set (não pisa claim novo). Incorporar P1/P2.

- [ ] **Step 2: rodar a suite completa**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo $?` · `bun run test > /tmp/t.log 2>&1; echo $?` · `bun lint 2>&1 | grep -c error` · `bash db/test-kb-extraction-drafts.sh > /tmp/pg.log 2>&1; echo $?`

- [ ] **Step 3: regenerar audit + abrir PR**

`bun run audit:migrations` (a migration nova). PR description com: ⚠️ migration MANUAL (colar o BLOCO no SQL Editor) + deploy da edge (chat Lovable, verbatim) + Publish do front. Colar o SQL inline. Auto-merge `--squash --auto`.

---

## Self-Review (preenchido)

- **Cobertura do spec:** tabela (T1) · RLS master (T1) · claim atômico (T1 RPC + T2 edge) · cache-first (T2) · persist-before-response (T2) · gate master (T2) · hidratação (T3) · extrair-só-pendentes (T3) · re-extrair (T3) · DELETE ao aprovar (T3) · PG17 + Codex (T1/T4). ✓
- **Placeholders:** o bloco do Claude na edge é "preserve o existente" (não placeholder — é instrução de não-reescrever o prompt). Os contratos (`ExtractResponse`, RPC, helpers) estão completos.
- **Consistência de tipos:** `ResultadoExtracao {documentId, spec}` (já existe) reusado em `mesclarResultados`/`useExtractionDrafts`. `kb_extraction_draft_claim(uuid,uuid)→boolean` idêntico T1↔T2. Contrato da edge `{specs?|status?}` idêntico T2↔T3.
