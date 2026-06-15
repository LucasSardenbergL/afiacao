-- Fase 2a: política de markup (piso + meta) sobre CMC, resolução conta→família→SKU.
-- Master/financeiro edita; vendedora só consulta (via RPC). Versionável: cada
-- linha tem updated_by/updated_at; mudança = UPDATE (histórico = follow-up se
-- preciso). v1 = 2 parâmetros manuais; break-even por orçamento = v2.

CREATE TABLE IF NOT EXISTS public.markup_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,                 -- 'oben' | 'colacor' | 'colacor_sc' (convenção empresa)
  escopo text NOT NULL CHECK (escopo IN ('conta','familia','sku')),
  familia text,                          -- preenchido sse escopo='familia'
  sku_codigo bigint,                     -- preenchido sse escopo='sku'
  piso_markup numeric NOT NULL CHECK (piso_markup >= 0),
  meta_markup numeric NOT NULL CHECK (meta_markup >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (meta_markup >= piso_markup),
  CHECK (
    (escopo='conta'   AND familia IS NULL AND sku_codigo IS NULL) OR
    (escopo='familia' AND familia IS NOT NULL AND sku_codigo IS NULL) OR
    (escopo='sku'     AND sku_codigo IS NOT NULL)
  )
);

-- 1 linha por (account, escopo, chave) — evita política ambígua.
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_conta  ON public.markup_policy (account) WHERE escopo='conta';
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_fam    ON public.markup_policy (account, familia) WHERE escopo='familia';
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_sku    ON public.markup_policy (account, sku_codigo) WHERE escopo='sku';

ALTER TABLE public.markup_policy ENABLE ROW LEVEL SECURITY;

-- Leitura staff (a RPC é SECURITY DEFINER, mas leitura direta staff é inofensiva: piso/meta não são o CMC).
DROP POLICY IF EXISTS "markup_policy_select_staff" ON public.markup_policy;
CREATE POLICY "markup_policy_select_staff" ON public.markup_policy
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- Escrita só master.
DROP POLICY IF EXISTS "markup_policy_write_master" ON public.markup_policy;
CREATE POLICY "markup_policy_write_master" ON public.markup_policy
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role));

-- Resolução conta→família→SKU (mais específico vence). STABLE; usada pela RPC.
CREATE OR REPLACE FUNCTION public.resolve_markup_policy(p_empresa text, p_codigo bigint, p_familia text)
RETURNS TABLE (piso_markup numeric, meta_markup numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $resolve$
  SELECT piso_markup, meta_markup
  FROM public.markup_policy
  WHERE account = lower(p_empresa)
    AND (
      (escopo='sku'     AND sku_codigo = p_codigo) OR
      (escopo='familia' AND p_familia IS NOT NULL AND familia = p_familia) OR
      (escopo='conta')
    )
  ORDER BY CASE escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END
  LIMIT 1;
$resolve$;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='markup_policy') AS tabela_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='markup_policy') AS policies_2,
  (SELECT count(*) FROM pg_proc WHERE proname='resolve_markup_policy') AS func_1;
-- esperado: 1, 2, 1
