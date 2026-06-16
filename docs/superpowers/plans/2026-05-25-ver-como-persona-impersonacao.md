# "Ver como pessoa" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao master uma capacidade read-only de "ver como [pessoa]" — abrir o cockpit de um vendedor (FarmerCalls: positivação, a-positivar, cross-sell, sugestões de visita, scores) com o **layout** e os **dados reais** daquela pessoa, sem trocar senha.

**Architecture:** Overlay client-side `effectiveUserId` (= alvo, ou o próprio master) que SÓ afeta leitura; a sessão Supabase continua a do master (logo todo write é do master = read-only por construção). As RPCs de carteira ganham irmãs master-only `_for(target)` (Pattern B do Codex — privilégio fisicamente isolado, RPCs de vendedor inalteradas em comportamento), via um internal `_..._for_owner` compartilhado. O `useAccess` (do #221) resolve a persona do alvo quando impersonando. Banner persistente + tabela de audit.

**Tech Stack:** React 18 + TypeScript + @tanstack/react-query + Supabase Postgres (RPC SECURITY DEFINER). Migrations aplicadas manualmente via Lovable SQL Editor (§5 do CLAUDE.md). Vitest (`bun run test`). TDD nos puros.

**Spec:** `docs/superpowers/specs/2026-05-25-ver-como-persona-impersonacao-design.md`

> **⚠️ STATUS (2026-05-25, durante execução):** o PR #221 (controle de acesso por persona) foi **fechado, não mergeado** — `useAccess`/`resolve-access`/`access-matrix` não existem na main. Logo **T0 e T9 NÃO foram feitos** e a **camada de MENU está adiada** (vira follow-up quando houver fundação de acesso-por-persona). **v1 entregue = data-only:** impersonar mostra os DADOS reais do alvo (positivação/cross-sell/visit/scores) + banner + read-only; o menu permanece o do master. Os hooks `useImpersonatedAccessProfile` + RPC `get_user_access_profile_for` ficam construídos e prontos pra quando a camada de menu for ligada.

---

## File Structure

**Migrations (aplicar via Lovable SQL Editor):**
- Create `supabase/migrations/20260525210000_viewas_rpcs_for.sql` — internals `_carteira_mixgap_for_owner`/`_carteira_positivacao_for_owner` + refactor das RPCs de vendedor pra delegar + wrappers master-only `get_meu_mixgap_for`/`get_minha_positivacao_for`.
- Create `supabase/migrations/20260525220000_viewas_access_targets.sql` — `get_user_access_profile_for(p_target)` + `list_impersonation_targets()` (ambas master-only).
- Create `supabase/migrations/20260525230000_impersonation_audit.sql` — tabela `impersonation_audit` + RLS + `log_impersonation_start(p_target, p_reason)` + `end_impersonation(p_audit_id)`.

**Client — novos:**
- Create `src/lib/impersonation/types.ts` — `ImpersonationTarget`.
- Create `src/lib/impersonation/effective-user.ts` (+ `__tests__/effective-user.test.ts`) — `resolveEffectiveUserId` + serialização sessionStorage.
- Create `src/contexts/ImpersonationContext.tsx` — provider + `useImpersonation`.
- Create `src/hooks/useImpersonationTargets.ts` — lista de alvos (`list_impersonation_targets`).
- Create `src/hooks/useImpersonatedAccessProfile.ts` — perfil de acesso do alvo (`get_user_access_profile_for`).
- Create `src/components/impersonation/ViewAsPicker.tsx` — card de seleção.
- Create `src/components/impersonation/ImpersonationBanner.tsx` — banner do topbar.
- Create `src/lib/impersonation/__tests__/no-write-leak.test.ts` — guard anti-vazamento de `effectiveUserId` em writes.

**Client — modificados:**
- Modify `src/hooks/useMyPositivacao.ts` — chama `get_minha_positivacao_for` quando impersonando.
- Modify `src/hooks/useMyMixGap.ts` — chama `get_meu_mixgap_for` quando impersonando.
- Modify `src/hooks/useMyVisitSuggestions.ts` — `effectiveUserId`; ignora cobertura do master na impersonação.
- Modify `src/hooks/useMyCarteiraScores.ts` — idem.
- Modify `src/hooks/useAccess.ts` (do #221) — resolve persona do alvo quando impersonando.
- Modify `src/components/dashboard/MasterDashboard.tsx` — monta `ViewAsPicker` (substitui o bullet placeholder).
- Modify `src/App.tsx` — monta `ImpersonationProvider`.
- Modify `src/components/AppShell.tsx` — monta `ImpersonationBanner` no topbar.

---

## Task 0: Mergear o #221 (pré-requisito — operacional, sem TDD)

A camada de menu/persona depende do `useAccess` do #221 (`src/hooks/useAccess.ts`, `src/lib/access/*`), que ainda não está na main.

- [ ] **Step 1: Coordenar.** `gh pr list --state open` + `git worktree list` — confirmar que nenhuma sessão ativa está na branch `claude/controle-acesso-persona`. Se houver, parar e avisar o founder.

- [ ] **Step 2: Atualizar a branch do #221 com a main.** Em worktree isolada:
```bash
bun run wt access-merge claude/controle-acesso-persona
# cd ../afiacao-access-merge && bun install
git merge origin/main
```
Resolver conflitos esperados em `src/App.tsx` (rotas — manter os `<RequireAccess>` do #221 E as rotas novas da main) e `src/components/AppShell.tsx` (menu — manter o filtro `useAccess().can(section)` do #221). Conflito auto-gerado em `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` → resolver com `bun run audit:migrations`.

- [ ] **Step 3: Validar.** `heavy bun run test` (≥595 ✓), `heavy bun run typecheck:strict` (0), `bun lint` (0), `heavy bun build`.

- [ ] **Step 4: Push + merge.** `git push`; aguardar CI `validate` verde; `gh pr merge 221 --squash` (NÃO `--admin`).

- [ ] **Step 5: Rebasear esta feature na nova main.**
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/eloquent-cartwright-b20129
git fetch origin && git rebase origin/main
# confirmar que src/hooks/useAccess.ts e src/lib/access/ existem agora
ls src/hooks/useAccess.ts src/lib/access/
```

> ⚠️ Mergear o #221 **liga as restrições de acesso por persona em prod**. Avisar o founder antes do merge (mudança comportamental — um vendedor pode perder acesso a uma tela se a matriz estiver errada).

---

## Task 1: Migration A — RPCs `_for` (mixgap + positivação) via internal compartilhado

**Files:**
- Create: `supabase/migrations/20260525210000_viewas_rpcs_for.sql`

**Padrão (Codex):** internal `_..._for_owner(p_owner)` faz o trabalho; a RPC de vendedor e a `_for` são wrappers finos com gates distintos. O internal **não** é concedido a `authenticated` (só os wrappers `SECURITY DEFINER` o chamam). Truque anti-erro: copiar o corpo existente da RPC e trocar **só** a linha `uid uuid := auth.uid();` por `uid uuid := p_owner;` — o resto do corpo fica byte-idêntico.

- [ ] **Step 1: Escrever a migration.** Conteúdo:

```sql
-- 20260525210000_viewas_rpcs_for.sql
-- "Ver como pessoa": RPCs irmãs master-only via internal compartilhado (Pattern B).
-- As RPCs de vendedor passam a delegar ao internal (comportamento idêntico, ainda auth.uid()).

-- ===== MIXGAP =====
-- Internal: corpo de get_meu_mixgap escopado a p_owner (sem gate; não exposto a authenticated).
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;   -- única linha trocada vs get_meu_mixgap original
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  WITH eleg AS (
    SELECT customer_user_id FROM public.carteira_assignments
    WHERE owner_user_id = uid AND eligible = true
  ),
  compras AS (
    SELECT DISTINCT oi.customer_user_id, op.id::text AS pid, op.familia
    FROM public.order_items oi
    JOIN eleg e ON e.customer_user_id = oi.customer_user_id
    JOIN public.omie_products op
      ON (oi.product_id = op.id
          OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto))
    WHERE oi.created_at >= now() - interval '12 months'
      AND op.familia IS NOT NULL
  ),
  cliente_produtos AS (
    SELECT customer_user_id, array_agg(DISTINCT pid) AS prods FROM compras GROUP BY customer_user_id
  ),
  cliente_familias AS (
    SELECT customer_user_id, array_agg(DISTINCT familia) AS fams FROM compras GROUP BY customer_user_id
  ),
  regras AS (
    SELECT antecedent_product_ids, consequent_product_ids, confidence, lift
    FROM public.farmer_association_rules
    WHERE confidence >= 0.15 AND lift >= 1.5 AND sample_size >= 30
  ),
  matches AS (
    SELECT cp.customer_user_id, r.consequent_product_ids, r.confidence, r.lift
    FROM cliente_produtos cp JOIN regras r ON r.antecedent_product_ids <@ cp.prods
  ),
  gaps AS (
    SELECT m.customer_user_id, op.familia AS familia_faltante, m.confidence, m.lift
    FROM matches m
    CROSS JOIN LATERAL unnest(m.consequent_product_ids) AS cons(pid)
    JOIN public.omie_products op ON op.id::text = cons.pid
    JOIN cliente_familias cf ON cf.customer_user_id = m.customer_user_id
    WHERE op.familia IS NOT NULL AND NOT (op.familia = ANY (cf.fams))
  ),
  gap_agg AS (
    SELECT customer_user_id, familia_faltante,
           max(confidence) AS confidence, max(lift) AS lift, count(*) AS evidence_count
    FROM gaps GROUP BY customer_user_id, familia_faltante
  ),
  top1 AS (
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count
    FROM gap_agg ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence, 'lift', t.lift, 'evidence_count', t.evidence_count
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid) FROM PUBLIC, authenticated;

-- RPC de vendedor: gate (employee/master) + delega (auth.uid()).
CREATE OR REPLACE FUNCTION public.get_meu_mixgap()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid,'master'::app_role) OR has_role(uid,'employee'::app_role)) THEN RETURN NULL; END IF;
  RETURN public._carteira_mixgap_for_owner(uid);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_meu_mixgap() TO authenticated;

-- Wrapper master-only: RAISE no forbidden (não RETURN NULL).
CREATE OR REPLACE FUNCTION public.get_meu_mixgap_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_mixgap_for_owner(p_target);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_meu_mixgap_for(uuid) TO authenticated;

-- ===== POSITIVAÇÃO =====
-- Internal: copiar o corpo INTEIRO de get_minha_positivacao (de
-- supabase/migrations/20260525120000_positivacao_kpis.sql), trocando SÓ a 1ª
-- linha `uid uuid := auth.uid();` por `uid uuid := p_owner;`. Manter o nome da
-- variável `uid` pra o resto do corpo ficar idêntico.
CREATE OR REPLACE FUNCTION public._carteira_positivacao_for_owner(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := p_owner;   -- <<< trocar SÓ esta linha vs original; colar o resto do corpo verbatim
  -- ... (resto das DECLAREs + BEGIN ... END do get_minha_positivacao original) ...
BEGIN
  RAISE EXCEPTION 'PLACEHOLDER: colar corpo de get_minha_positivacao aqui';
END; $$;
REVOKE ALL ON FUNCTION public._carteira_positivacao_for_owner(uuid) FROM PUBLIC, authenticated;

CREATE OR REPLACE FUNCTION public.get_minha_positivacao()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid,'master'::app_role) OR has_role(uid,'employee'::app_role)) THEN RETURN NULL; END IF;
  RETURN public._carteira_positivacao_for_owner(uid);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_minha_positivacao() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_minha_positivacao_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_positivacao_for_owner(p_target);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_minha_positivacao_for(uuid) TO authenticated;

SELECT 'BLOCO VIEWAS-A OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('_carteira_mixgap_for_owner','get_meu_mixgap','get_meu_mixgap_for',
     '_carteira_positivacao_for_owner','get_minha_positivacao','get_minha_positivacao_for')) AS fns;
```

> ⚠️ O bloco da positivação tem um `PLACEHOLDER`. Antes de entregar ao founder, **abrir `supabase/migrations/20260525120000_positivacao_kpis.sql`, copiar o corpo de `get_minha_positivacao` (das DECLAREs após `uid` até o `END;`) verbatim** pra dentro de `_carteira_positivacao_for_owner`, trocando só `uid uuid := auth.uid();` → `uid uuid := p_owner;` e removendo o gate inline (vai pros wrappers). Rodar uma busca por `PLACEHOLDER` no arquivo final pra garantir que sumiu.

- [ ] **Step 2: Remover o gate duplicado do corpo da positivação.** O corpo original de `get_minha_positivacao` tem o gate `IF NOT (has_role...) RETURN NULL` lá dentro — ao colar no internal, **remover** esse gate (o internal não faz gate; os wrappers fazem). Conferir que o internal só calcula.

- [ ] **Step 3: Entregar ao founder (Lovable SQL Editor).** Mensagem com 1 bloco `\`\`\`sql … \`\`\`` (BLOCO VIEWAS-A), fence de fechamento em linha sozinha, terminando no `SELECT 'BLOCO VIEWAS-A OK'`. Esperado: `fns = 6`.

- [ ] **Step 4: Validar que a RPC de vendedor NÃO mudou de output.** Entregar query read-only que compara: para a carteira da Regina, `_carteira_mixgap_for_owner(<regina_id>)` deve bater com os 23 que medimos no bake. Idem positivação. Confirmar com o founder.

- [ ] **Step 5: Commit.**
```bash
git add supabase/migrations/20260525210000_viewas_rpcs_for.sql
git commit -m "feat(viewas): RPCs _for master-only (mixgap+positivação) via internal compartilhado"
```

---

## Task 2: Migration B — perfil de acesso do alvo + lista de alvos

**Files:**
- Create: `supabase/migrations/20260525220000_viewas_access_targets.sql`

- [ ] **Step 1: Escrever a migration.**

```sql
-- 20260525220000_viewas_access_targets.sql
-- "Ver como pessoa": insumos de persona do alvo + lista de alvos. Master-only.

-- Perfil de acesso do alvo (alimenta resolveAccessPersona do #221).
CREATE OR REPLACE FUNCTION public.get_user_access_profile_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  SELECT jsonb_build_object(
    'app_role', (SELECT role::text FROM public.user_roles WHERE user_id = p_target ORDER BY role LIMIT 1),
    'commercial_role', (SELECT commercial_role FROM public.commercial_roles WHERE user_id = p_target LIMIT 1),
    'department', (SELECT department FROM public.user_departments WHERE user_id = p_target LIMIT 1),
    'is_sales_only', EXISTS (
      SELECT 1 FROM public.company_config cc
      WHERE p_target::text = ANY (COALESCE(cc.sales_only_cpfs, ARRAY[]::text[]))
    )
  ) INTO result;
  RETURN result;
END; $$;
GRANT EXECUTE ON FUNCTION public.get_user_access_profile_for(uuid) TO authenticated;

-- Alvos impersonáveis = donos de carteira.
CREATE OR REPLACE FUNCTION public.list_impersonation_targets()
RETURNS TABLE (user_id uuid, nome text, commercial_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  RETURN QUERY
  SELECT DISTINCT ca.owner_user_id,
         COALESCE(p.name, p.razao_social, ca.owner_user_id::text) AS nome,
         cr.commercial_role
  FROM public.carteira_assignments ca
  LEFT JOIN public.profiles p ON p.user_id = ca.owner_user_id
  LEFT JOIN public.commercial_roles cr ON cr.user_id = ca.owner_user_id
  ORDER BY nome;
END; $$;
GRANT EXECUTE ON FUNCTION public.list_impersonation_targets() TO authenticated;

SELECT 'BLOCO VIEWAS-B OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('get_user_access_profile_for','list_impersonation_targets')) AS fns;
```

> ⚠️ Conferir os nomes reais das tabelas/colunas no schema antes de entregar: `user_roles(user_id, role)`, `commercial_roles(user_id, commercial_role)`, `user_departments(user_id, department)`, `company_config.sales_only_cpfs`. Se `sales_only_cpfs` guardar CPF (não user_id), ajustar o `is_sales_only` (juntar com `profiles.cpf`). Validar com um `SELECT` exploratório no SQL Editor (entregar ao founder) antes do bloco final.

- [ ] **Step 2: Entregar (BLOCO VIEWAS-B).** Esperado `fns = 2`. Pedir também ao founder: `SELECT * FROM list_impersonation_targets();` — deve listar Regina/Tatyana/Lucas com os grupos.

- [ ] **Step 3: Commit.**
```bash
git add supabase/migrations/20260525220000_viewas_access_targets.sql
git commit -m "feat(viewas): get_user_access_profile_for + list_impersonation_targets (master-only)"
```

---

## Task 3: Migration C — audit

**Files:**
- Create: `supabase/migrations/20260525230000_impersonation_audit.sql`

- [ ] **Step 1: Escrever a migration.**

```sql
-- 20260525230000_impersonation_audit.sql
CREATE TABLE IF NOT EXISTS public.impersonation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reason text,
  source text NOT NULL DEFAULT 'master_dashboard'
);
ALTER TABLE public.impersonation_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "master vê audit de impersonação" ON public.impersonation_audit;
CREATE POLICY "master vê audit de impersonação" ON public.impersonation_audit
  FOR SELECT USING (has_role(auth.uid(),'master'::app_role));

-- Loga o INÍCIO (actor = auth.uid() SEMPRE; nunca client-provided). Retorna o id.
CREATE OR REPLACE FUNCTION public.log_impersonation_start(p_target uuid, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  INSERT INTO public.impersonation_audit (actor_user_id, target_user_id, reason)
  VALUES (auth.uid(), p_target, p_reason)   -- actor do auth.uid(), não do cliente
  RETURNING id INTO new_id;
  RETURN new_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.log_impersonation_start(uuid, text) TO authenticated;

-- Fecha (só o próprio actor pode fechar a sua linha).
CREATE OR REPLACE FUNCTION public.end_impersonation(p_audit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.impersonation_audit
  SET ended_at = now()
  WHERE id = p_audit_id AND actor_user_id = auth.uid() AND ended_at IS NULL;
END; $$;
GRANT EXECUTE ON FUNCTION public.end_impersonation(uuid) TO authenticated;

SELECT 'BLOCO VIEWAS-C OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='impersonation_audit') AS tbl,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('log_impersonation_start','end_impersonation')) AS fns;
```

- [ ] **Step 2: Entregar (BLOCO VIEWAS-C).** Esperado `tbl=1, fns=2`.

- [ ] **Step 3: Commit.**
```bash
git add supabase/migrations/20260525230000_impersonation_audit.sql
git commit -m "feat(viewas): tabela impersonation_audit + log/end RPCs (LGPD)"
```

---

## Task 4: Helper puro `effective-user` (TDD)

**Files:**
- Create: `src/lib/impersonation/types.ts`
- Create: `src/lib/impersonation/effective-user.ts`
- Test: `src/lib/impersonation/__tests__/effective-user.test.ts`

- [ ] **Step 1: Tipos.**
```ts
// src/lib/impersonation/types.ts
export interface ImpersonationTarget {
  id: string;
  nome: string;
  grupo: 'hunter' | 'farmer' | 'closer' | null;
}
```

- [ ] **Step 2: Escrever o teste (falha).**
```ts
// src/lib/impersonation/__tests__/effective-user.test.ts
import { describe, it, expect } from 'vitest';
import { resolveEffectiveUserId } from '../effective-user';

describe('resolveEffectiveUserId', () => {
  it('retorna o id do master quando não há alvo', () => {
    expect(resolveEffectiveUserId('master-1', null)).toBe('master-1');
  });
  it('retorna o id do alvo quando impersonando', () => {
    expect(resolveEffectiveUserId('master-1', { id: 'regina-9', nome: 'Regina', grupo: 'farmer' })).toBe('regina-9');
  });
  it('cai pro master se realId é null e não há alvo', () => {
    expect(resolveEffectiveUserId(null, null)).toBeNull();
  });
});
```

- [ ] **Step 3: Rodar (falha).** `heavy bun run test src/lib/impersonation` → FAIL (módulo não existe).

- [ ] **Step 4: Implementar.**
```ts
// src/lib/impersonation/effective-user.ts
import type { ImpersonationTarget } from './types';

export function resolveEffectiveUserId(realUserId: string | null, target: ImpersonationTarget | null): string | null {
  return target?.id ?? realUserId;
}

const KEY = 'impersonation.target';
export function loadPersistedTarget(): ImpersonationTarget | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ImpersonationTarget) : null;
  } catch { return null; }
}
export function persistTarget(t: ImpersonationTarget | null): void {
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch { /* sessionStorage indisponível: degrada pra in-memory */ }
}
```

- [ ] **Step 5: Rodar (passa).** `heavy bun run test src/lib/impersonation` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/impersonation/
git commit -m "feat(viewas): helper puro resolveEffectiveUserId + persistência sessionStorage (TDD)"
```

---

## Task 5: `ImpersonationContext` + provider

**Files:**
- Create: `src/contexts/ImpersonationContext.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Escrever o contexto.**
```tsx
// src/contexts/ImpersonationContext.tsx
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { resolveEffectiveUserId, loadPersistedTarget, persistTarget } from '@/lib/impersonation/effective-user';
import type { ImpersonationTarget } from '@/lib/impersonation/types';

interface ImpersonationContextType {
  realUserId: string | null;
  target: ImpersonationTarget | null;
  effectiveUserId: string | null;
  isImpersonating: boolean;
  startImpersonation: (t: ImpersonationTarget, reason?: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const Ctx = createContext<ImpersonationContextType | undefined>(undefined);

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const { user, isMaster } = useAuth();
  // só master pode impersonar; se não for master, target trava em null.
  const [target, setTarget] = useState<ImpersonationTarget | null>(() => (isMaster ? loadPersistedTarget() : null));
  const [auditId, setAuditId] = useState<string | null>(null);

  const realUserId = user?.id ?? null;
  const effectiveUserId = resolveEffectiveUserId(realUserId, target);

  const startImpersonation = useCallback(async (t: ImpersonationTarget, reason?: string) => {
    if (!isMaster) return;
    const { data } = await (supabase as unknown as {
      rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
    }).rpc('log_impersonation_start', { p_target: t.id, p_reason: reason ?? null });
    setAuditId(typeof data === 'string' ? data : null);
    setTarget(t);
    persistTarget(t);
  }, [isMaster]);

  const stopImpersonation = useCallback(async () => {
    if (auditId) {
      await (supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
      }).rpc('end_impersonation', { p_audit_id: auditId });
    }
    setAuditId(null);
    setTarget(null);
    persistTarget(null);
  }, [auditId]);

  const value = useMemo(() => ({
    realUserId, target, effectiveUserId, isImpersonating: !!target,
    startImpersonation, stopImpersonation,
  }), [realUserId, target, effectiveUserId, startImpersonation, stopImpersonation]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useImpersonation(): ImpersonationContextType {
  const v = useContext(Ctx);
  if (!v) throw new Error('useImpersonation deve estar dentro de ImpersonationProvider');
  return v;
}
```

- [ ] **Step 2: Montar o provider no `App.tsx`.** Localizar a pilha de providers (`AuthProvider` > `CompanyProvider` > …) e envolver as rotas com `<ImpersonationProvider>` **dentro** do `AuthProvider` (precisa de `useAuth`). Import no topo.

- [ ] **Step 3: Verificar build/typecheck.** `heavy bun run typecheck:strict` → 0. `heavy bun build` → OK.

- [ ] **Step 4: Commit.**
```bash
git add src/contexts/ImpersonationContext.tsx src/App.tsx
git commit -m "feat(viewas): ImpersonationContext (master-only, sessionStorage, audit start/end)"
```

---

## Task 6: Hooks de dados do alvo (`useImpersonationTargets`, `useImpersonatedAccessProfile`)

**Files:**
- Create: `src/hooks/useImpersonationTargets.ts`
- Create: `src/hooks/useImpersonatedAccessProfile.ts`

- [ ] **Step 1: Lista de alvos.**
```ts
// src/hooks/useImpersonationTargets.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { ImpersonationTarget } from '@/lib/impersonation/types';

export function useImpersonationTargets() {
  const { isMaster } = useAuth();
  return useQuery({
    queryKey: ['impersonation-targets'],
    enabled: isMaster,
    staleTime: 300_000,
    queryFn: async (): Promise<ImpersonationTarget[]> => {
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('list_impersonation_targets');
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ user_id: string; nome: string; commercial_role: string | null }>;
      const grupo = (cr: string | null): ImpersonationTarget['grupo'] =>
        cr === 'hunter' ? 'hunter' : cr === 'closer' ? 'closer' : cr ? 'farmer' : null;
      return rows.map((r) => ({ id: r.user_id, nome: r.nome, grupo: grupo(r.commercial_role) }));
    },
  });
}
```

- [ ] **Step 2: Perfil de acesso do alvo.**
```ts
// src/hooks/useImpersonatedAccessProfile.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export interface TargetAccessProfile {
  appRole: 'employee' | 'customer' | 'master' | null;
  commercialRole: string | null;
  department: string | null;
  isSalesOnly: boolean;
}

/** Perfil de acesso do ALVO (master-only RPC). null quando não impersonando. */
export function useImpersonatedAccessProfile() {
  const { isImpersonating, target } = useImpersonation();
  return useQuery({
    queryKey: ['impersonated-access-profile', target?.id],
    enabled: isImpersonating && !!target,
    staleTime: 300_000,
    queryFn: async (): Promise<TargetAccessProfile | null> => {
      if (!target) return null;
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_user_access_profile_for', { p_target: target.id });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        appRole: (r.app_role as TargetAccessProfile['appRole']) ?? null,
        commercialRole: (r.commercial_role as string) ?? null,
        department: (r.department as string) ?? null,
        isSalesOnly: !!r.is_sales_only,
      };
    },
  });
}
```

- [ ] **Step 3: Typecheck.** `heavy bun run typecheck:strict` → 0.

- [ ] **Step 4: Commit.**
```bash
git add src/hooks/useImpersonationTargets.ts src/hooks/useImpersonatedAccessProfile.ts
git commit -m "feat(viewas): hooks de alvos + perfil de acesso do alvo"
```

---

## Task 7: `useMyPositivacao` + `useMyMixGap` impersonation-aware

**Files:**
- Modify: `src/hooks/useMyPositivacao.ts`
- Modify: `src/hooks/useMyMixGap.ts`

- [ ] **Step 1: `useMyMixGap`.** Trocar o corpo pra usar impersonação. Diff:
```ts
// imports: + import { useImpersonation } from '@/contexts/ImpersonationContext';
export function useMyMixGap() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  return useQuery({
    queryKey: ['my-mixgap', effectiveUserId],          // <- effectiveUserId
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<MixGap | null> => {
      if (!user) return null;
      const rpc = (supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc;
      const { data, error } = isImpersonating && effectiveUserId
        ? await rpc('get_meu_mixgap_for', { p_target: effectiveUserId })
        : await rpc('get_meu_mixgap');
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as MixGapResumo;
      return { totalComGap: r.total_com_gap, lista: rankGaps(r.lista ?? []) };
    },
  });
}
```
> ⚠️ Atenção ao `this` do client: ao desestruturar `.rpc`, chamar como `rpc('x')` perde o `this` do supabase. **Não desestruturar** — manter `(supabase as unknown as {...}).rpc(name, params)` inline nas duas chamadas. Reescrever o passo acima sem o `const rpc =`.

- [ ] **Step 2: `useMyPositivacao`.** Mesmo padrão: `useImpersonation()`, `queryKey` com `effectiveUserId`, e `rpc('get_minha_positivacao_for', { p_target: effectiveUserId })` quando impersonando, senão `rpc('get_minha_positivacao')`. Manter a chamada inline (sem desestruturar).

- [ ] **Step 3: Typecheck + test.** `heavy bun run typecheck:strict` → 0; `heavy bun run test src/lib/positivacao src/lib/mixgap` → PASS (helpers não mudaram).

- [ ] **Step 4: Commit.**
```bash
git add src/hooks/useMyPositivacao.ts src/hooks/useMyMixGap.ts
git commit -m "feat(viewas): positivação + mixgap chamam _for(target) quando impersonando"
```

---

## Task 8: `useMyVisitSuggestions` + `useMyCarteiraScores` impersonation-aware

**Files:**
- Modify: `src/hooks/useMyVisitSuggestions.ts`
- Modify: `src/hooks/useMyCarteiraScores.ts`

Regra: na impersonação, `ownerIds = [effectiveUserId]` (carteira própria do alvo; **ignora a cobertura do master**). Fora da impersonação, comportamento atual (`[user.id, ...coveredIds]`).

- [ ] **Step 1: `useMyCarteiraScores`.** Diff:
```ts
// + import { useImpersonation } from '@/contexts/ImpersonationContext';
export function useMyCarteiraScores() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { data: coverage } = useMyActiveCoverage();
  const coveredIds = (coverage ?? []).map((c) => c.covered_user_id);
  const ownerIds = isImpersonating && effectiveUserId
    ? [effectiveUserId]
    : (user ? [user.id, ...coveredIds] : []);
  const baseId = isImpersonating ? effectiveUserId : user?.id;   // pra coberto_de e queryKey
  return useQuery({
    queryKey: ['my-carteira-scores', isImpersonating ? `as:${effectiveUserId}` : user?.id, coveredIds.sort().join(',')],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraScoreRow[]> => {
      if (!user) return [];
      const { data, error } = await supabase.from('farmer_client_scores')
        .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, last_signal_recalc_at')
        .in('farmer_id', ownerIds)
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<CarteiraScoreRow & { farmer_id: string }>;
      return rows.map(({ farmer_id, ...row }) => ({
        ...row,
        coberto_de: farmer_id !== baseId ? farmer_id : null,
      }));
    },
  });
}
```

- [ ] **Step 2: `useMyVisitSuggestions`.** Mesmo padrão: `useImpersonation()`; `const baseId = isImpersonating ? effectiveUserId : userId;` `const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (userId ? [userId, ...coveredIds] : []);`. Trocar `userId` por `baseId` nos dois `queryKey` (prefixar `as:` quando impersonando), no filtro `.in('farmer_id', ownerIds)` (já usa ownerIds), e nas comparações `s.farmer_id !== userId` → `!== baseId` (selo de cobertura). `enabled` segue `!!userId` (o master está logado).

- [ ] **Step 3: Typecheck.** `heavy bun run typecheck:strict` → 0.

- [ ] **Step 4: Commit.**
```bash
git add src/hooks/useMyVisitSuggestions.ts src/hooks/useMyCarteiraScores.ts
git commit -m "feat(viewas): visit-suggestions + scores escopam à carteira do alvo na impersonação"
```

---

## Task 9: `useAccess` resolve a persona do alvo (pós-#221)

**Files:**
- Modify: `src/hooks/useAccess.ts`

- [ ] **Step 1: Integrar a impersonação.** Diff (sobre o `useAccess` do #221):
```ts
// + import { useImpersonation } from '@/contexts/ImpersonationContext';
// + import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';
export function useAccess(): UseAccessReturn {
  const { role, loading: authLoading } = useAuth();
  const { commercialRole, loading: crLoading } = useCommercialRole();
  const { department, isLoading: deptLoading } = useUserDepartment();
  const { isSalesOnly, loading: salesOnlyLoading } = useSalesOnlyState();
  const { isImpersonating } = useImpersonation();
  const { data: targetProfile, isLoading: targetLoading } = useImpersonatedAccessProfile();

  const persona = useMemo(() => {
    if (isImpersonating && targetProfile) {
      return resolveAccessPersona({
        appRole: targetProfile.appRole,
        commercialRole: targetProfile.commercialRole,
        department: targetProfile.department,
        isSalesOnly: targetProfile.isSalesOnly,
      });
    }
    return resolveAccessPersona({ appRole: role, commercialRole, department, isSalesOnly });
  }, [isImpersonating, targetProfile, role, commercialRole, department, isSalesOnly]);

  const group = useMemo(
    () => resolveGroupTag(isImpersonating && targetProfile ? targetProfile.commercialRole : commercialRole),
    [isImpersonating, targetProfile, commercialRole],
  );

  return {
    persona, group,
    loading: authLoading || crLoading || deptLoading || salesOnlyLoading || (isImpersonating && targetLoading),
    can: (section) => canAccess(persona, section),
    isReadOnly: (section) => isReadOnly(persona, section),
  };
}
```

- [ ] **Step 2: Typecheck + test.** `heavy bun run typecheck:strict` → 0; `heavy bun run test src/lib/access` → PASS (matriz/resolver intocados).

- [ ] **Step 3: Commit.**
```bash
git add src/hooks/useAccess.ts
git commit -m "feat(viewas): useAccess resolve a persona do alvo quando impersonando"
```

---

## Task 10: `ViewAsPicker` no MasterDashboard

**Files:**
- Create: `src/components/impersonation/ViewAsPicker.tsx`
- Modify: `src/components/dashboard/MasterDashboard.tsx`

- [ ] **Step 1: Escrever o picker.**
```tsx
// src/components/impersonation/ViewAsPicker.tsx
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Eye } from 'lucide-react';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export function ViewAsPicker() {
  const { data: targets = [], isLoading } = useImpersonationTargets();
  const { isImpersonating, target, startImpersonation, stopImpersonation } = useImpersonation();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-base font-medium">Ver como</h2>
        </div>
        <p className="text-2xs text-muted-foreground">
          Entre na visão (layout + dados reais, somente leitura) de um vendedor pra conferir.
        </p>
      </CardHeader>
      <div className="p-3 flex flex-wrap gap-2">
        {isLoading && <span className="text-2xs text-muted-foreground">Carregando…</span>}
        {targets.map((t) => {
          const active = isImpersonating && target?.id === t.id;
          return (
            <Button
              key={t.id}
              size="sm"
              variant={active ? 'default' : 'outline'}
              onClick={() => (active ? stopImpersonation() : startImpersonation(t, 'QA via MasterDashboard'))}
            >
              {t.nome}{t.grupo ? ` · ${t.grupo}` : ''}{active ? ' ✓' : ''}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Montar no MasterDashboard.** Em `src/components/dashboard/MasterDashboard.tsx`: importar `ViewAsPicker`, renderizar logo após `<VisitSuggestionsCard />`, e **remover** o bullet placeholder `<li>Toggle &quot;ver como Farmer/Hunter/Closer&quot;…</li>` do card "Em construção".

- [ ] **Step 3: Typecheck + build.** `heavy bun run typecheck:strict` → 0; `heavy bun build` → OK.

- [ ] **Step 4: Commit.**
```bash
git add src/components/impersonation/ViewAsPicker.tsx src/components/dashboard/MasterDashboard.tsx
git commit -m "feat(viewas): ViewAsPicker no MasterDashboard (substitui placeholder)"
```

---

## Task 11: `ImpersonationBanner` no topbar + read-only

**Files:**
- Create: `src/components/impersonation/ImpersonationBanner.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Banner.**
```tsx
// src/components/impersonation/ImpersonationBanner.tsx
import { Eye, X } from 'lucide-react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';

export function ImpersonationBanner() {
  const { isImpersonating, target, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  if (!isImpersonating || !target) return null;
  return (
    <div className="w-full bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 py-1 px-3">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Vendo como <strong>{target.nome}</strong> · você é {user?.email ?? 'master'} — <strong>somente leitura</strong>
      </span>
      <button onClick={() => stopImpersonation()} className="flex items-center gap-1 underline shrink-0">
        <X className="w-3.5 h-3.5" /> Sair
      </button>
    </div>
  );
}
```
> Conferir o token de cor: usar uma classe `bg-status-*-bold` que exista no `index.css` (Task confirma `bg-status-warning-bold`). Se não existir, usar `bg-status-warning` + `text-status-warning-fg`.

- [ ] **Step 2: Montar no topbar do AppShell.** Em `src/components/AppShell.tsx`, renderizar `<ImpersonationBanner />` **acima** do conteúdo do topbar (full-width, no topo do shell, antes do `<main>`), pra ser impossível ignorar em qualquer tela. Import no topo.

- [ ] **Step 3: Read-only guard.** Expor um helper simples e aplicar onde houver ação de escrita nas telas de carteira. Mínimo viável v1: no `Dialer`/botões de ação do FarmerCalls, desabilitar quando `useImpersonation().isImpersonating`. Adicionar `disabled={isImpersonating}` + `title="Indisponível em modo Ver como"` nos CTAs de mutação visíveis no cockpit (criar pedido, iniciar ligação). (A garantia dura é o write usar o id do master — isto é só UX.)

- [ ] **Step 4: Typecheck + build.** `heavy bun run typecheck:strict` → 0; `heavy bun build` → OK.

- [ ] **Step 5: Commit.**
```bash
git add src/components/impersonation/ImpersonationBanner.tsx src/components/AppShell.tsx
git commit -m "feat(viewas): banner persistente de impersonação + desabilita CTAs de escrita"
```

---

## Task 12: Guard anti-write-leak (CI)

**Files:**
- Create: `src/lib/impersonation/__tests__/no-write-leak.test.ts`

Regra dura do Codex: `effectiveUserId` SÓ pode aparecer numa allowlist de arquivos de LEITURA. Qualquer write que o referencie = bug de misattribution.

- [ ] **Step 1: Escrever o teste.**
```ts
// src/lib/impersonation/__tests__/no-write-leak.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';   // se indisponível, usar fast-glob já presente
import { sync as glob } from 'fast-glob';

// Arquivos AUTORIZADOS a referenciar effectiveUserId (todos de LEITURA).
const ALLOWED = new Set([
  'src/contexts/ImpersonationContext.tsx',
  'src/lib/impersonation/effective-user.ts',
  'src/hooks/useMyPositivacao.ts',
  'src/hooks/useMyMixGap.ts',
  'src/hooks/useMyVisitSuggestions.ts',
  'src/hooks/useMyCarteiraScores.ts',
  'src/hooks/useImpersonatedAccessProfile.ts',
]);

describe('anti write-leak: effectiveUserId só em leitura', () => {
  it('nenhum arquivo fora da allowlist referencia effectiveUserId', () => {
    const files = glob('src/**/*.{ts,tsx}', { ignore: ['**/__tests__/**'] });
    const offenders = files.filter((f) =>
      !ALLOWED.has(f) && readFileSync(f, 'utf8').includes('effectiveUserId'));
    expect(offenders, `effectiveUserId vazou pra: ${offenders.join(', ')}`).toEqual([]);
  });
});
```
> Conferir o import de glob: o repo usa `fast-glob`? Se não, usar `import.meta.glob` (Vite) ou `node:fs` + recursão. Ajustar pro que já existe nas devDeps (`bun pm ls | grep glob`).

- [ ] **Step 2: Rodar (passa).** `heavy bun run test src/lib/impersonation` → PASS (a allowlist cobre exatamente os arquivos das Tasks 4-8).

- [ ] **Step 3: Commit.**
```bash
git add src/lib/impersonation/__tests__/no-write-leak.test.ts
git commit -m "test(viewas): guard de CI anti-vazamento de effectiveUserId em writes"
```

---

## Task 13: Codex review do gate + validação ponta-a-ponta + PR

- [ ] **Step 1: Codex review adversária.** Rodar `codex exec` (read-only) apontando pras 3 migrations + o `ImpersonationContext` + `useAccess`, pedindo: pode um não-master ler dados de outro por qualquer caminho? `effectiveUserId` vaza pra write? `search_path`/grants ok? Corrigir o que ele achar antes do PR (como no #221).

- [ ] **Step 2: Suite completa.** `heavy bun run test` (verde), `heavy bun run typecheck:strict` (0), `bun lint` (0), `heavy bun build`.

- [ ] **Step 3: Regenerar audit de migrations.** `bun run audit:migrations` → `git add docs/migrations-audit.md scripts/audit-custom-migrations.sql`.

- [ ] **Step 4: PR.** `gh pr create` com corpo descrevendo: o que é, Pattern B, os 3 BLOCOS SQL pra colar no Lovable (VIEWAS-A/B/C, um por bloco, fence fechando sozinha), validações esperadas, e a nota "**ATENÇÃO: migrations manuais + #221 deve estar mergeado**". Test plan com checkboxes.

- [ ] **Step 5: Conduzir rollout com o founder.** Entregar BLOCO VIEWAS-A → confirmar `fns=6` + RPC de vendedor inalterada → B (`fns=2` + `list_impersonation_targets` lista os 3) → C (`tbl=1, fns=2`). Depois smoke test: master abre MasterDashboard → "Ver como Regina" → FarmerCalls mostra os números da Regina → banner aparece → "Sair" volta ao master.

- [ ] **Step 6: Merge.** CI `validate` verde → `gh pr merge --squash` (NÃO `--admin`).

---

## Self-Review (preenchido)

**Spec coverage:** ✅ Pattern B `_for` (T1) · access profile + targets (T2) · audit (T3) · effectiveUserId puro (T4) · context (T5) · hooks de alvo (T6) · positivação/mixgap aware (T7) · visit/scores aware (T8) · useAccess override (T9) · picker (T10) · banner + read-only (T11) · anti-write-leak (T12) · Codex + rollout (T13) · #221 prereq (T0).

**Placeholders:** o único `PLACEHOLDER` é o corpo da positivação em T1 — **intencional e com instrução exata** (copiar verbatim do arquivo existente, trocar 1 linha). Step 1 da T1 obriga removê-lo antes de entregar.

**Type consistency:** `ImpersonationTarget {id,nome,grupo}` consistente (T4 define, T6/T10 consomem). `effectiveUserId: string|null` em todo lugar. `useImpersonation()` retorna o mesmo shape em T5 e é consumido em T7-T11. `resolveAccessPersona` recebe `{appRole,commercialRole,department,isSalesOnly}` igual ao #221 (T9).

**Riscos conhecidos:** nomes de tabela/coluna em T2 (`user_roles`/`commercial_roles`/`user_departments`/`company_config.sales_only_cpfs`) e o token de cor em T11 e o glob em T12 têm step de verificação explícito antes de assumir.
