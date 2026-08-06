-- PR0.0-bis (A de 2) — Cria o canal staff SECDEF de leitura de omie_payload/omie_response.
-- NÃO faz o REVOKE ainda (isso é a migration B).
--
-- ⚠️  Por que DUAS migrations (achado do Codex xhigh, 2026-07-09): o front migrado DEPENDE
--     desta RPC (loadOrder da edição dá throw se ela faltar) E a migration B (REVOKE) quebra o
--     `.select('*')` do front VELHO. Com as duas coisas numa migration só não existe ordem de
--     deploy segura: DB-first quebra o front velho; front-first quebra o staff (RPC ausente).
--     Sequência correta:
--        (1) aplicar ESTA (A) → a RPC passa a existir; o front velho segue intacto (nada revogado)
--        (2) Publish do front migrado → passa a usar a RPC e não faz mais `.select('*')`
--        (3) aplicar a B (REVOKE) → fecha o payload; o front já está pronto para isso.
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT): seguro re-colar no SQL Editor.

BEGIN;

-- Leitura batch de omie_payload/omie_response. SECURITY DEFINER → roda como owner (vai furar o
-- REVOKE de leitura que a migration B aplica). Gate has_role(employee|master) barra o customer
-- autenticado (mesmo role 'authenticated'); 'anon' é barrado no EXECUTE (REVOKE abaixo).
CREATE OR REPLACE FUNCTION public.staff_get_sales_order_payload(p_order_ids uuid[])
RETURNS TABLE(id uuid, omie_payload jsonb, omie_response jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    auth.role() = 'service_role'
    OR public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil de staff (employee/master)'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT so.id, so.omie_payload, so.omie_response
  FROM public.sales_orders so
  WHERE so.id = ANY(p_order_ids);
END;
$$;

-- authenticated tem EXECUTE (o staff É authenticated; o gate interno distingue staff de customer);
-- anon/PUBLIC não executam (defense-in-depth com o gate).
REVOKE EXECUTE ON FUNCTION public.staff_get_sales_order_payload(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_get_sales_order_payload(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.staff_get_sales_order_payload(uuid[]) IS
  'PR0.0-bis: leitura staff-only (SECDEF + gate has_role) de omie_payload/omie_response de sales_orders. '
  'Essas colunas são fechadas ao customer pela migration B (REVOKE SELECT column-level). '
  'Consumido pela edição e impressão de pedido (codigo_parcela/codigo_cliente).';

COMMIT;
