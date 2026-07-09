-- Self-service do comprador B2B — Fase 0 · PR0.1 — Allowlist + gate de elegibilidade (fail-closed).
--
-- Monta a fronteira de autorização do comprador de produto, 100% no servidor:
--   • allowlist (cliente, conta) com `enabled DEFAULT false` — linha criada por bug/seed nasce
--     DESLIGADA (Codex P1#4). Cliente NÃO tem IUD nem SELECT direto (só enxerga o próprio status
--     via o gate — não vê notes/enabled_by internos, Codex PR0.1#2). Quem liga é gestor
--     (pode_ver_carteira_completa) ou service_role. Trigger anti-forje CONGELA enabled_by/at:
--     carimba na transição→true e preserva o autor original em qualquer UPDATE de linha já-true
--     (Codex PR0.1#4 — sem isto, um 2º gestor reescreveria o autor).
--   • gate `selfservice_conta_atual()` (SECDEF, fail-closed): habilitado = flag global ∧ is_approved
--     ∧ NÃO-staff ∧ tem linha enabled. NÃO-staff é checado por has_role (fonte canônica, Codex
--     PR0.1#1) E por is_employee (reforço) — se qualquer fonte disser staff, barra. Todo ramo
--     COALESCE→false: ausência degrada para negado, nunca abre.
--   • flag global `company_config['selfservice_produto_enabled']` nasce 'false'.
--
-- Âncora: `customer_user_id = (SELECT auth.uid())` — nunca documento/CNPJ (dado público). O
-- `account` autorizado vem da allowlist (não se deriva de omie_clientes.empresa_omie, 100% colacor).
-- InitPlan-wrapped (`(SELECT …)`) em toda policy/gate — avalia 1×/query, não por linha.
--
-- Consumido por PR0.2 (views-gate) e PR0.3 (smoke). Interface estável:
--   selfservice_conta_atual() → TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
--
-- Prova: db/test-selfservice-pr01-gate.sh (PG17, SET ROLE + GUC + falsificação).
-- ⚠️ Migração MANUAL — não auto-aplica no Lovable. Aplicar via SQL Editor (lovable-db-operator).

BEGIN;

-- 1) Allowlist (cliente, conta) — enabled DEFAULT FALSE (fail-closed).
CREATE TABLE IF NOT EXISTS public.selfservice_cliente_allowlist (
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account text NOT NULL CHECK (account IN ('oben','colacor','colacor_sc')),
  enabled boolean NOT NULL DEFAULT false,
  enabled_by uuid REFERENCES auth.users(id),
  enabled_at timestamptz,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_user_id, account)
);
CREATE INDEX IF NOT EXISTS idx_ss_allowlist_customer
  ON public.selfservice_cliente_allowlist(customer_user_id);

-- 2) Anti-forje: carimba enabled_by/at na transição→true; CONGELA o original em UPDATE de linha já-true.
CREATE OR REPLACE FUNCTION public.ss_allowlist_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.enabled IS TRUE AND (TG_OP='INSERT' OR OLD.enabled IS DISTINCT FROM true) THEN
    -- transição para LIGADO: carimba autor/data (auth.uid() se houver sessão; service_role
    -- sem uid pode gravar enabled_by explícito).
    IF auth.uid() IS NOT NULL THEN NEW.enabled_by := auth.uid(); END IF;
    NEW.enabled_at := now();
  ELSIF TG_OP='UPDATE' AND OLD.enabled IS TRUE AND NEW.enabled IS TRUE THEN
    -- linha SEGUE ligada: congela autor/data originais (anti-forje via UPDATE — Codex PR0.1#4).
    NEW.enabled_by := OLD.enabled_by;
    NEW.enabled_at := OLD.enabled_at;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_ss_allowlist_autor ON public.selfservice_cliente_allowlist;
CREATE TRIGGER trg_ss_allowlist_autor BEFORE INSERT OR UPDATE ON public.selfservice_cliente_allowlist
  FOR EACH ROW EXECUTE FUNCTION public.ss_allowlist_forca_autor();

-- 3) RLS: cliente NÃO lê a tabela crua (usa só o gate); staff lê; gestor gerencia (IUD); service bypass.
ALTER TABLE public.selfservice_cliente_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.selfservice_cliente_allowlist FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.selfservice_cliente_allowlist TO authenticated;  -- a RLS é a barreira

-- (sem policy de SELECT p/ o cliente comum — enabled_by/notes são internos; o cliente vê o
--  próprio status só via selfservice_conta_atual(). Codex PR0.1#2.)
DROP POLICY IF EXISTS ss_allowlist_customer_select ON public.selfservice_cliente_allowlist;

DROP POLICY IF EXISTS ss_allowlist_staff_select ON public.selfservice_cliente_allowlist;
CREATE POLICY ss_allowlist_staff_select ON public.selfservice_cliente_allowlist
  FOR SELECT TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'employee'::app_role) OR has_role((SELECT auth.uid()),'master'::app_role))));

DROP POLICY IF EXISTS ss_allowlist_gestor_iud ON public.selfservice_cliente_allowlist;
CREATE POLICY ss_allowlist_gestor_iud ON public.selfservice_cliente_allowlist
  FOR ALL TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS ss_allowlist_service ON public.selfservice_cliente_allowlist;
CREATE POLICY ss_allowlist_service ON public.selfservice_cliente_allowlist
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4) Gate canônico: fail-closed. NÃO-staff por has_role (canônico) E is_employee (reforço) — Codex PR0.1#1/#2.
CREATE OR REPLACE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account)
              FROM public.selfservice_cliente_allowlist a
              WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE), '{}'::text[]),
    ( COALESCE((SELECT (value)::boolean FROM public.company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND COALESCE((SELECT p.is_employee IS FALSE FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND NOT (has_role((SELECT auth.uid()),'employee'::app_role) OR has_role((SELECT auth.uid()),'master'::app_role))
      AND EXISTS (SELECT 1 FROM public.selfservice_cliente_allowlist a
                  WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE) );
$$;
REVOKE ALL ON FUNCTION public.selfservice_conta_atual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.selfservice_conta_atual() TO authenticated;

-- 5) Flag global nasce DESLIGADA (fail-closed). company_config.key é UNIQUE (pré-voo confirmou).
INSERT INTO public.company_config(key, value) VALUES ('selfservice_produto_enabled','false')
  ON CONFLICT (key) DO NOTHING;

COMMIT;
