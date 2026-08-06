-- money-path (autorização RLS de carteira + visibilidade de artefatos de cliente).
-- Fecha o furo: carteira_visivel_para e minha_carteira IGNORAVAM `eligible` → o dono de uma
-- assignment eligible=false (fornecedor excluído / clone escondido / futura identidade ambígua)
-- continuava lendo, via RLS, os artefatos do cliente (scores/visitas/recomendações) e a própria
-- linha de atribuição. `carteira_visivel_para` gateia 8 policies; `minha_carteira` é RPC exposta a
-- `authenticated`. Ver docs/superpowers/specs/2026-07-17-carteira-rls-eligible-visibilidade-design.md.
--
-- Idempotente (CREATE OR REPLACE). Pré-flight pg_get_functiondef prod×repo: idênticos (fase1
-- 20260524120000), sem deriva. Hardening (Codex xhigh): gate TOTAL (nunca-NULL: `_uid IS NOT NULL`
-- + COALESCE(has_role,false)); `eligible IS TRUE` explícito; refs qualificadas (`public.`) neutralizam
-- shadowing de search_path. Equivalência p/ _uid NULL: prod já retornava false → o wrapper não muda
-- comportamento além da máscara `eligible`.

-- ── 1. O GATE (SECURITY DEFINER; 8 policies dependem dele) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _uid IS NOT NULL
    AND (
      COALESCE(public.has_role(_uid, 'master'::app_role), false)
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        WHERE a.customer_user_id = _customer_user_id
          AND a.owner_user_id = _uid
          AND a.eligible IS TRUE
      )
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
        WHERE a.customer_user_id = _customer_user_id
          AND a.eligible IS TRUE
          AND c.covering_user_id = _uid
          AND c.active
          AND (c.valid_until IS NULL OR c.valid_until > now())
      )
    );
$$;

-- ── 2. A RPC "minha carteira" (exposta a authenticated via PostgREST) ─────────────────────────
CREATE OR REPLACE FUNCTION public.minha_carteira()
RETURNS TABLE(customer_user_id uuid, owner_user_id uuid, coberto_de uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.customer_user_id, a.owner_user_id, NULL::uuid AS coberto_de
  FROM public.carteira_assignments a
  WHERE a.owner_user_id = auth.uid()
    AND a.eligible IS TRUE
  UNION
  SELECT a.customer_user_id, a.owner_user_id, a.owner_user_id AS coberto_de
  FROM public.carteira_assignments a
  JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
  WHERE c.covering_user_id = auth.uid()
    AND c.active
    AND (c.valid_until IS NULL OR c.valid_until > now())
    AND a.eligible IS TRUE;
$$;
