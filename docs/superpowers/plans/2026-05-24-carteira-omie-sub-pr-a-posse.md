# Carteira-Omie — Sub-PR A (Fase 1: Posse) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estabelecer o modelo de **posse da carteira** vindo do Omie — 3 tabelas, lógica de rebuild idempotente, RLS, helper de visibilidade e RPC — de forma que a carteira de cada vendedor seja consultável (consumo pela UI vem no Sub-PR B).

**Architecture:** Uma tabela `carteira_assignments` (1 dono primário por cliente) é o contrato único de posse, reconstruída a partir de `omie_clientes` × `omie_vendedor_map` (a ponte código-Omie→vendedor). Cliente sem vendedor mapeado vai pro Hunter. `carteira_coverage` modela cobertura no nível do dono (visibilidade, não posse). A regra de visibilidade (próprio / cobertura ativa / master) vive num único helper `SECURITY DEFINER`. A lógica de derivação é um helper puro testável (`computeCarteira`), espelhado na edge function `carteira-rebuild`.

**Tech Stack:** Supabase Postgres (migration manual via Lovable SQL Editor), Deno edge function (deploy via chat Lovable), TypeScript + Vitest (`bun run test`).

**Spec:** `docs/superpowers/specs/2026-05-23-carteira-omie-fonte-verdade-design.md`
**Branch:** `feat/carteira-omie-fonte-verdade`

---

## Pré-requisitos operacionais (LER ANTES)

- **DB só via Lovable.** Migrations custom NÃO são aplicadas automaticamente no merge. O SQL desta fase é entregue inline na conversa (1 bloco por mensagem, terminando em `SELECT '... OK' AS status`), o founder cola no **🟣 Lovable → SQL Editor → Run**.
- **Edge function** é deployada pelo **chat do Lovable** (instruir a ler `supabase/functions/carteira-rebuild/index.ts` verbatim do repo). NÃO sugerir `supabase functions deploy`.
- **Teste canônico:** `bun run test` (vitest). `bun test` (runner nativo) é só fast-path local.
- Tipos gerados do Supabase ainda não conhecem as tabelas novas → no front/edge usar cast `(supabase as any).from('carteira_assignments')` até regenerar os tipos (padrão já usado no `call_log`).

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/types/carteira.ts` (criar) | Interfaces TS: `CarteiraAssignment`, `CarteiraCoverage`, `OmieVendedorMap`, source enum. |
| `src/lib/carteira/rebuild-helpers.ts` (criar) | Helper PURO `computeCarteira(clientes, vendedorMap, hunterUserId)` → assignments + conflicts + orphanCount. Sem I/O. |
| `src/lib/carteira/__tests__/rebuild-helpers.test.ts` (criar) | Testes vitest do helper puro. |
| `supabase/migrations/20260524120000_carteira_omie_fase1.sql` (criar) | 3 tabelas + índices + RLS + `carteira_visivel_para()` + RPC `minha_carteira()`. |
| `supabase/functions/carteira-rebuild/index.ts` (criar) | Edge function: carrega dados, espelha `computeCarteira`, faz upsert idempotente, loga conflitos/órfãos. |

---

## Task 1: Tipos TS da carteira

**Files:**
- Create: `src/types/carteira.ts`

- [ ] **Step 1: Criar o arquivo de tipos**

```ts
// src/types/carteira.ts
export type CarteiraSource = 'omie' | 'hunter_orphan';

export interface CarteiraAssignment {
  id: string;
  customer_user_id: string;
  owner_user_id: string;
  source: CarteiraSource;
  omie_account: string | null;
  omie_codigo_vendedor: number | null;
  eligible: boolean;
  valid_from: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface CarteiraCoverage {
  id: string;
  covering_user_id: string;
  covered_user_id: string;
  valid_from: string;
  valid_until: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
}

export interface OmieVendedorMap {
  id: string;
  omie_account: string;
  omie_codigo_vendedor: number;
  user_id: string;
  nome: string | null;
  created_at: string;
}

/** Linha retornada pelo RPC `minha_carteira(uid)`. coberto_de = dono original quando vem de cobertura; null = próprio. */
export interface MinhaCarteiraRow {
  customer_user_id: string;
  owner_user_id: string;
  coberto_de: string | null;
}
```

- [ ] **Step 2: Verificar compilação**

Run: `bunx tsc --noEmit -p tsconfig.app.json 2>&1 | grep carteira || echo "OK sem erros em carteira"`
Expected: `OK sem erros em carteira`

- [ ] **Step 3: Commit**

```bash
git add src/types/carteira.ts
git commit -m "feat(carteira): tipos TS da carteira (assignments, coverage, vendedor map)"
```

---

## Task 2: Helper puro de rebuild (TDD)

**Files:**
- Create: `src/lib/carteira/rebuild-helpers.ts`
- Test: `src/lib/carteira/__tests__/rebuild-helpers.test.ts`

Regras (do spec):
- Código mapeado para **exatamente 1** vendedor → assignment `source='omie'`.
- Código mapeado para **2+** vendedores distintos → **conflito** (não atribui; aguarda resolução manual).
- Código `null` **ou** não-mapeado → órfão → vai pro Hunter (`source='hunter_orphan'`); se não houver Hunter, conta órfão mas não atribui.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/carteira/__tests__/rebuild-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarteira } from '../rebuild-helpers';

const HUNTER = 'hunter-uid';

describe('computeCarteira', () => {
  it('código mapeado p/ 1 vendedor → assignment source=omie', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c1', omie_codigo_vendedor: 10 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10 },
    ]);
    expect(r.conflicts).toHaveLength(0);
    expect(r.orphanCount).toBe(0);
  });

  it('código null → órfão vai pro Hunter (hunter_orphan)', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c2', omie_codigo_vendedor: null }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c2', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null },
    ]);
    expect(r.orphanCount).toBe(1);
  });

  it('código presente mas NÃO mapeado → órfão vai pro Hunter', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c3', omie_codigo_vendedor: 99 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments[0]).toEqual({
      customer_user_id: 'c3', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: 99,
    });
    expect(r.orphanCount).toBe(1);
  });

  it('código que mapeia p/ 2 vendedores distintos → conflito, sem assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c4', omie_codigo_vendedor: 10 }],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 10, user_id: 'tati' },
      ],
      HUNTER,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.conflicts).toEqual([
      { customer_user_id: 'c4', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
  });

  it('sem Hunter (null) → órfão é contado mas não vira assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c5', omie_codigo_vendedor: null }],
      [],
      null,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.orphanCount).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `bun run test src/lib/carteira/__tests__/rebuild-helpers.test.ts`
Expected: FAIL — `Failed to resolve import "../rebuild-helpers"` (módulo não existe).

- [ ] **Step 3: Implementar o helper**

```ts
// src/lib/carteira/rebuild-helpers.ts
export type CarteiraSource = 'omie' | 'hunter_orphan';

export interface OmieClienteRow {
  customer_user_id: string;
  omie_codigo_vendedor: number | null;
}

export interface VendedorMapRow {
  omie_codigo_vendedor: number;
  user_id: string;
}

export interface ComputedAssignment {
  customer_user_id: string;
  owner_user_id: string;
  source: CarteiraSource;
  omie_codigo_vendedor: number | null;
}

export interface MappingConflict {
  customer_user_id: string;
  omie_codigo_vendedor: number;
  candidate_user_ids: string[];
}

export interface RebuildResult {
  assignments: ComputedAssignment[];
  conflicts: MappingConflict[];
  orphanCount: number;
}

/**
 * Deriva os assignments de carteira a partir do mapeamento Omie (PURO, sem I/O).
 * Fase 1: match por código ignorando a conta (omie_clientes não guarda account).
 * Colisão de código entre vendedores distintos vira conflito (não atribui).
 */
export function computeCarteira(
  clientes: OmieClienteRow[],
  vendedorMap: VendedorMapRow[],
  hunterUserId: string | null,
): RebuildResult {
  const codeToUsers = new Map<number, Set<string>>();
  for (const m of vendedorMap) {
    if (!codeToUsers.has(m.omie_codigo_vendedor)) codeToUsers.set(m.omie_codigo_vendedor, new Set());
    codeToUsers.get(m.omie_codigo_vendedor)!.add(m.user_id);
  }

  const assignments: ComputedAssignment[] = [];
  const conflicts: MappingConflict[] = [];
  let orphanCount = 0;

  for (const c of clientes) {
    const code = c.omie_codigo_vendedor;
    const users = code != null ? codeToUsers.get(code) : undefined;

    if (code != null && users) {
      if (users.size === 1) {
        assignments.push({
          customer_user_id: c.customer_user_id,
          owner_user_id: [...users][0],
          source: 'omie',
          omie_codigo_vendedor: code,
        });
        continue;
      }
      conflicts.push({
        customer_user_id: c.customer_user_id,
        omie_codigo_vendedor: code,
        candidate_user_ids: [...users].sort(),
      });
      continue;
    }

    // código null OU não-mapeado → órfão → Hunter
    orphanCount++;
    if (hunterUserId) {
      assignments.push({
        customer_user_id: c.customer_user_id,
        owner_user_id: hunterUserId,
        source: 'hunter_orphan',
        omie_codigo_vendedor: code ?? null,
      });
    }
  }

  return { assignments, conflicts, orphanCount };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `bun run test src/lib/carteira/__tests__/rebuild-helpers.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/carteira/rebuild-helpers.ts src/lib/carteira/__tests__/rebuild-helpers.test.ts
git commit -m "feat(carteira): helper puro computeCarteira + testes (TDD)"
```

---

## Task 3: Migration — tabelas + RLS + helpers

**Files:**
- Create: `supabase/migrations/20260524120000_carteira_omie_fase1.sql`

> Convenções confirmadas no repo: RLS usa `has_role(auth.uid(),'master'::app_role)` / `'employee'::app_role` (enum `app_role` NÃO tem `admin`). Helpers `SECURITY DEFINER SET search_path = public`.

- [ ] **Step 1: Escrever a migration completa**

```sql
-- supabase/migrations/20260524120000_carteira_omie_fase1.sql
-- Carteira-Omie Fase 1 (Posse): mapa vendedor + assignments + coverage + RLS + visibilidade.

-- 1. Ponte código-Omie → vendedor do app
CREATE TABLE IF NOT EXISTS public.omie_vendedor_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_account text NOT NULL,
  omie_codigo_vendedor bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (omie_account, omie_codigo_vendedor)
);
CREATE INDEX IF NOT EXISTS idx_omie_vendedor_map_codigo ON public.omie_vendedor_map (omie_codigo_vendedor);

-- 2. Dono primário (1 por cliente)
CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('omie','hunter_orphan')),
  omie_account text,
  omie_codigo_vendedor bigint,
  eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  UNIQUE (customer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_carteira_owner ON public.carteira_assignments (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_carteira_owner_eligible ON public.carteira_assignments (owner_user_id) WHERE eligible;

-- 3. Cobertura no nível do dono
CREATE TABLE IF NOT EXISTS public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL,
  covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (covering_user_id <> covered_user_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_covering_active
  ON public.carteira_coverage (covering_user_id) WHERE active;

-- 4. Helper de visibilidade (regra ÚNICA: próprio / cobertura ativa / master)
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR EXISTS (
      SELECT 1 FROM carteira_assignments a
      WHERE a.customer_user_id = _customer_user_id AND a.owner_user_id = _uid
    )
    OR EXISTS (
      SELECT 1 FROM carteira_assignments a
      JOIN carteira_coverage c ON c.covered_user_id = a.owner_user_id
      WHERE a.customer_user_id = _customer_user_id
        AND c.covering_user_id = _uid
        AND c.active
        AND (c.valid_until IS NULL OR c.valid_until > now())
    );
$$;

-- 5. RPC: minha carteira visível (próprios + cobertura ativa).
-- SEM parâmetro de uid (usa auth.uid() internamente): como é SECURITY DEFINER e
-- bypassa RLS, um _uid externo permitiria IDOR (qualquer um leria a carteira alheia).
CREATE OR REPLACE FUNCTION public.minha_carteira()
RETURNS TABLE (customer_user_id uuid, owner_user_id uuid, coberto_de uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.customer_user_id, a.owner_user_id, NULL::uuid AS coberto_de
  FROM carteira_assignments a
  WHERE a.owner_user_id = auth.uid()
  UNION
  SELECT a.customer_user_id, a.owner_user_id, a.owner_user_id AS coberto_de
  FROM carteira_assignments a
  JOIN carteira_coverage c ON c.covered_user_id = a.owner_user_id
  WHERE c.covering_user_id = auth.uid()
    AND c.active
    AND (c.valid_until IS NULL OR c.valid_until > now());
$$;

-- 6. RLS
ALTER TABLE public.omie_vendedor_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff view vendedor map" ON public.omie_vendedor_map;
CREATE POLICY "Staff view vendedor map" ON public.omie_vendedor_map FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
DROP POLICY IF EXISTS "Master manage vendedor map" ON public.omie_vendedor_map;
CREATE POLICY "Master manage vendedor map" ON public.omie_vendedor_map FOR ALL
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View carteira por visibilidade" ON public.carteira_assignments;
CREATE POLICY "View carteira por visibilidade" ON public.carteira_assignments FOR SELECT
  USING (carteira_visivel_para(customer_user_id, auth.uid()));
DROP POLICY IF EXISTS "Master manage carteira" ON public.carteira_assignments;
CREATE POLICY "Master manage carteira" ON public.carteira_assignments FOR ALL
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

ALTER TABLE public.carteira_coverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View coverage envolvido" ON public.carteira_coverage;
CREATE POLICY "View coverage envolvido" ON public.carteira_coverage FOR SELECT
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR covering_user_id = auth.uid()
    OR covered_user_id = auth.uid()
  );
DROP POLICY IF EXISTS "Master ou coberto cria coverage" ON public.carteira_coverage;
CREATE POLICY "Master ou coberto cria coverage" ON public.carteira_coverage FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid());
DROP POLICY IF EXISTS "Master ou coberto edita coverage" ON public.carteira_coverage;
CREATE POLICY "Master ou coberto edita coverage" ON public.carteira_coverage FOR UPDATE
  USING (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid())
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid());

-- Validação
SELECT 'BLOCO CARTEIRA FASE1 OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
     AND table_name IN ('omie_vendedor_map','carteira_assignments','carteira_coverage')) AS tabelas,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('carteira_visivel_para','minha_carteira')) AS funcoes;
```

- [ ] **Step 2: Commit do arquivo de migration**

```bash
git add supabase/migrations/20260524120000_carteira_omie_fase1.sql
git commit -m "feat(carteira): migration fase 1 — tabelas, RLS, visibilidade, RPC"
```

- [ ] **Step 3: Entregar o SQL pro founder colar no Lovable**

Entregar o conteúdo da migration como **um bloco SQL** na conversa (rotular "BLOCO CARTEIRA FASE 1"). Founder cola no 🟣 Lovable → SQL Editor → Run.
Expected (retorno do Run): `BLOCO CARTEIRA FASE1 OK | tabelas=3 | funcoes=2`.

---

## Task 4: Edge function `carteira-rebuild`

**Files:**
- Create: `supabase/functions/carteira-rebuild/index.ts`

> A lógica de `computeCarteira` é **espelhada** aqui (Deno não importa `src/lib`). Mantém-se idêntica ao helper testado na Task 2 — se mudar lá, muda aqui.

- [ ] **Step 1: Escrever a edge function**

```ts
// supabase/functions/carteira-rebuild/index.ts
// Reconstrói carteira_assignments a partir de omie_clientes × omie_vendedor_map.
// Órfão (sem vendedor mapeado) → Hunter. Idempotente (upsert por customer_user_id).
//
// Setup pg_cron (manual pós-merge), roda após o sync do Omie:
//   SELECT cron.schedule('carteira-rebuild-nightly', '30 7 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild',
//       headers := jsonb_build_object('x-cron-secret',
//         (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
//     ); $$);

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

type CarteiraSource = 'omie' | 'hunter_orphan';
interface OmieClienteRow { customer_user_id: string; omie_codigo_vendedor: number | null; }
interface VendedorMapRow { omie_codigo_vendedor: number; user_id: string; }
interface ComputedAssignment {
  customer_user_id: string; owner_user_id: string; source: CarteiraSource; omie_codigo_vendedor: number | null;
}
interface MappingConflict { customer_user_id: string; omie_codigo_vendedor: number; candidate_user_ids: string[]; }

// ESPELHO de src/lib/carteira/rebuild-helpers.ts (manter idêntico)
function computeCarteira(
  clientes: OmieClienteRow[], vendedorMap: VendedorMapRow[], hunterUserId: string | null,
): { assignments: ComputedAssignment[]; conflicts: MappingConflict[]; orphanCount: number } {
  const codeToUsers = new Map<number, Set<string>>();
  for (const m of vendedorMap) {
    if (!codeToUsers.has(m.omie_codigo_vendedor)) codeToUsers.set(m.omie_codigo_vendedor, new Set());
    codeToUsers.get(m.omie_codigo_vendedor)!.add(m.user_id);
  }
  const assignments: ComputedAssignment[] = [];
  const conflicts: MappingConflict[] = [];
  let orphanCount = 0;
  for (const c of clientes) {
    const code = c.omie_codigo_vendedor;
    const users = code != null ? codeToUsers.get(code) : undefined;
    if (code != null && users) {
      if (users.size === 1) {
        assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: [...users][0], source: 'omie', omie_codigo_vendedor: code });
        continue;
      }
      conflicts.push({ customer_user_id: c.customer_user_id, omie_codigo_vendedor: code, candidate_user_ids: [...users].sort() });
      continue;
    }
    orphanCount++;
    if (hunterUserId) {
      assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: code ?? null });
    }
  }
  return { assignments, conflicts, orphanCount };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Carregar mapa + hunter (tabelas pequenas). Hunter via config explícito
  // (company_config.carteira_hunter_user_id) — não depende de commercial_role.
  const [mapRes, hunterRes] = await Promise.all([
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
  ]);
  const vendedorMap = (mapRes.data ?? []) as VendedorMapRow[];
  const rawHunter = (hunterRes.data?.value as string | null | undefined) ?? null;
  const hunterUserId = rawHunter ? (rawHunter.replace(/^"|"$/g, '').trim() || null) : null;

  // omie_clientes: paginar (PostgREST limita SELECT a ~1000/página → senão trunca).
  const clientes: OmieClienteRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('omie_clientes')
      .select('user_id, omie_codigo_vendedor')
      .not('user_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const page = (data ?? []) as Array<{ user_id: string; omie_codigo_vendedor: number | null }>;
    for (const r of page) clientes.push({ customer_user_id: r.user_id, omie_codigo_vendedor: r.omie_codigo_vendedor });
    if (page.length < PAGE) break;
  }

  // 2. Computar (espelho)
  const { assignments, conflicts, orphanCount } = computeCarteira(clientes, vendedorMap, hunterUserId);

  // 3. Upsert idempotente
  const now = new Date().toISOString();
  const rows = assignments.map((a) => ({
    customer_user_id: a.customer_user_id,
    owner_user_id: a.owner_user_id,
    source: a.source,
    omie_codigo_vendedor: a.omie_codigo_vendedor,
    updated_at: now,
    last_synced_at: now,
  }));

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('carteira_assignments')
      .upsert(chunk, { onConflict: 'customer_user_id' });
    if (error) {
      console.error('[carteira-rebuild] upsert error:', error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    upserted += chunk.length;
  }

  if (conflicts.length) console.warn('[carteira-rebuild] conflitos de mapeamento:', JSON.stringify(conflicts));

  return new Response(JSON.stringify({
    ok: true, upserted, orphanCount, conflicts, hunterUserId,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/carteira-rebuild/index.ts
git commit -m "feat(carteira): edge function carteira-rebuild (espelha computeCarteira)"
```

- [ ] **Step 3: Deploy via chat do Lovable**

Montar prompt pro chat do Lovable: "Create a new Supabase edge function named `carteira-rebuild` reading `supabase/functions/carteira-rebuild/index.ts` from the repo verbatim. Do NOT modify the code." Verificar no Cloud → Edge functions se aparece "Active".

---

## Task 5: Seed do `omie_vendedor_map` + primeiro rebuild

**Files:** (nenhum no repo — entrega SQL inline pro Lovable)

- [ ] **Step 1: Entregar query de auditoria (descobrir os códigos)**

Bloco SQL pro founder rodar no Lovable (read-only):

```sql
-- Códigos de vendedor presentes na base + nº de clientes (pra identificar quem é quem)
SELECT omie_codigo_vendedor, count(*) AS clientes
FROM public.omie_clientes
WHERE omie_codigo_vendedor IS NOT NULL
GROUP BY omie_codigo_vendedor
ORDER BY clientes DESC;
```

E os `user_id` dos vendedores (coluna de nome em `profiles` é `name`; `email` está na própria `profiles`):

```sql
SELECT p.user_id, p.name, p.email, cr.commercial_role
FROM public.profiles p
LEFT JOIN public.commercial_roles cr ON cr.user_id = p.user_id
WHERE cr.commercial_role IS NOT NULL
   OR p.email = 'lucascoelhosardenberg@gmail.com'
ORDER BY cr.commercial_role NULLS LAST, p.name;
```

- [ ] **Step 2: Entregar o INSERT do mapa (founder preenche os códigos/ids reais)**

> Os valores entre `<...>` são dados de runtime que o founder substitui pelos resultados da Step 1 — não são placeholders de plano.

```sql
INSERT INTO public.omie_vendedor_map (omie_account, omie_codigo_vendedor, user_id, nome) VALUES
  ('oben', <CODIGO_LUCAS>,  '<USER_ID_LUCAS>',  'Lucas'),
  ('oben', <CODIGO_REGINA>, '<USER_ID_REGINA>', 'Regina'),
  ('oben', <CODIGO_TATI>,   '<USER_ID_TATI>',   'Tati')
ON CONFLICT (omie_account, omie_codigo_vendedor)
  DO UPDATE SET user_id = EXCLUDED.user_id, nome = EXCLUDED.nome;

SELECT 'SEED VENDEDOR MAP OK' AS status, count(*) AS linhas FROM public.omie_vendedor_map;
```

Expected: `SEED VENDEDOR MAP OK | linhas=3`.

- [ ] **Step 3: Disparar o primeiro rebuild**

Pedir ao chat do Lovable pra invocar a function `carteira-rebuild`, OU via SQL no Lovable:

```sql
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild',
  headers := jsonb_build_object('x-cron-secret',
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
);
```

- [ ] **Step 4: Agendar o cron noturno (após o sync do Omie)**

```sql
SELECT cron.schedule('carteira-rebuild-nightly', '30 7 * * *',
  $$ SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild',
    headers := jsonb_build_object('x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
  ); $$);

SELECT 'CRON CARTEIRA OK' AS status FROM cron.job WHERE jobname = 'carteira-rebuild-nightly';
```

---

## Task 6: Validação end-to-end + PR

- [ ] **Step 1: Validar a carteira populada (SQL no Lovable)**

```sql
SELECT 'CARTEIRA POPULADA' AS status,
  count(*) AS total,
  count(*) FILTER (WHERE source='omie') AS omie,
  count(*) FILTER (WHERE source='hunter_orphan') AS orfaos,
  count(DISTINCT owner_user_id) AS donos
FROM public.carteira_assignments;
```
Expected: `total > 0`, `donos` ≈ 3, `omie + orfaos = total`.

- [ ] **Step 2: Validar a regra de visibilidade (smoke)**

```sql
-- Como master, deve ver tudo; como vendedor, só a sua fatia. Testar a função direta:
SELECT public.carteira_visivel_para(
  (SELECT customer_user_id FROM public.carteira_assignments LIMIT 1),
  (SELECT owner_user_id   FROM public.carteira_assignments LIMIT 1)
) AS dono_ve_proprio;  -- esperado: true
```

- [ ] **Step 3: Rodar a suíte de testes e o build**

Run: `bun run test && bun run typecheck:strict`
Expected: testes passam (incluindo os 5 de `rebuild-helpers`); typecheck strict sem regressão.

- [ ] **Step 4: Abrir o PR**

```bash
git push -u origin feat/carteira-omie-fonte-verdade
gh pr create --title "feat(carteira): Sub-PR A — posse vinda do Omie (Fase 1)" --body "$(cat <<'EOF'
## Summary
- Modelo de posse da carteira: `omie_vendedor_map`, `carteira_assignments`, `carteira_coverage`.
- Helper puro `computeCarteira` (TDD) + edge function `carteira-rebuild` (espelho).
- RLS + regra única de visibilidade (`carteira_visivel_para`) + RPC `minha_carteira`.

## ⚠️ Migration manual necessária
Aplicar `20260524120000_carteira_omie_fase1.sql` no 🟣 Lovable → SQL Editor (SQL no body + entregue inline). Deploy da edge function `carteira-rebuild` via chat do Lovable. Seed do `omie_vendedor_map` (3 linhas) + primeiro rebuild + cron.

## Test plan
- [ ] `bun run test` — 5 testes de `rebuild-helpers` passando
- [ ] Migration aplicada (3 tabelas, 2 funções)
- [ ] Seed do mapa (3 linhas) + rebuild populou `carteira_assignments`
- [ ] Visibilidade: dono vê próprio; cobertura ativa concede; master vê tudo

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Roadmap dos próximos sub-PRs (detalhados em writing-plans próprios)

> Cada sub-PR abaixo ganha seu próprio plano detalhado quando chegar a vez — porque o código depende da realidade que esta Fase 1 deixar (assinatura final do RPC, códigos seedados, schema dos scores colapsados).

- **Sub-PR B — Leituras + Cobertura (Fase 2):** virar `useMyVisitSuggestions` e `useMyCarteiraScores` pra ler de `minha_carteira()` (sem arg — usa auth.uid()) → scores por `customer_user_id`; selo "Cobertura — {nome}" na lista; UI mínima de cobertura (master/dono coberto cria grant). Mantém `pickDailyMix` intacto.
- **Sub-PR C — Colapsar scores (Fase 3):** refactor de `customer_visit_scores`/`farmer_client_scores` pra por-cliente (dropa `farmer_id`, `UNIQUE(customer_user_id)`), migração de dados (colapsar duplicatas), ajuste de `visit-score-recalc-batch`/`-client` e `scoring-recalc-*` pra iterar clientes. **Mais delicado — PR isolado.**
- **Sub-PR D — KPIs / Positivação (Fase 4):** `carteira_positivacao_snapshot` + helper puro de positivação/MTD (TDD) + hook de KPIs (estende `useMyKpis`) + revamp do `FarmerCalls` (heros por Farmer/Hunter; atuais rebaixados) + cron mensal de snapshot. "Receita vs Meta" fora (sem meta).

## Notas de implementação / riscos (do spec + codex)

- **Match sem `account`:** Fase 1 resolve por código ignorando conta (`omie_clientes` não tem `account`). Colisão real (código→2+ vendedores) vira conflito logado, sem atribuição. Hardening futuro: adicionar `omie_account` em `omie_clientes` via os syncs.
- **Reconciliação de stale:** o rebuild faz upsert; clientes que perderam mapeamento no Omie mantêm o dono antigo (raro, pois `omie_clientes` não é deletada). Reconciliação ativa fica para quando doer.
- **Espelho helper↔edge:** `computeCarteira` existe 2x (testado em `src/lib`, espelhado no Deno). Qualquer mudança na lógica deve tocar os dois.
