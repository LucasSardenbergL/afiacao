-- =========================================================================
-- SEGURANÇA (Codex retroativo #802-P1) — fecha PRIVILEGE ESCALATION app-wide.
--
-- Furo: a policy "Users can insert own profile" (FOR INSERT TO authenticated
--   WITH CHECK (auth.uid()=user_id AND is_employee=false)) deixa QUALQUER autenticado
--   inserir o próprio profile com `document` ARBITRÁRIO. O trigger auto_assign_user_role
--   (AFTER INSERT) concedia 'master' quando REGEXP_REPLACE(document,'\D','','g') == master_cnpj
--   (o CNPJ da empresa, que é PÚBLICO). O ramo master NÃO checa is_employee → o self-insert
--   (forçado a is_employee=false) ainda dispara. → criar conta + saber o CNPJ = virar master.
--   O guard de 20260612120000 só cobriu prospect_source='omie_import', NÃO o insert manual.
--
-- Fix: o trigger NUNCA concede 'master' automaticamente. Master é provisionado MANUALMENTE:
--   INSERT INTO public.user_roles (user_id, role) VALUES ('<uid>', 'master');
-- O master atual (founder) NÃO é afetado (já tem o role; o trigger é AFTER INSERT em profiles
-- e early-returns quando existing_role IS NOT NULL).
--
-- CREATE OR REPLACE = corpo vivo (20260612120000) MENOS o ramo master. Os ramos
-- employee/customer ficam IDÊNTICOS. O trigger-irmão auto_assign_commercial_super_admin
-- NÃO é vulnerável (exige is_employee=true, que o self-insert proíbe) → não tocado.
--
-- ⚠️ MIGRATION MANUAL (SQL Editor). PRÉ-FLIGHT antes de aplicar:
--   SELECT pg_get_functiondef('public.auto_assign_user_role()'::regprocedure);
--   confirme que o corpo vivo bate com o de baixo (menos o ramo master) antes do REPLACE.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.auto_assign_user_role() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  existing_role app_role;
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT role INTO existing_role FROM public.user_roles WHERE user_id = NEW.user_id LIMIT 1;
  IF existing_role IS NOT NULL THEN RETURN NEW; END IF;

  -- ⛔ REMOVIDO o ramo que concedia 'master' por NEW.document == master_cnpj.
  --    Era privilege escalation: o usuário controla NEW.document (policy de self-insert).
  --    Master agora é manual: INSERT INTO public.user_roles(user_id, role) VALUES (<uid>, 'master');

  IF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.user_id, 'employee')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.user_id, 'customer')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- Validação inline.
SELECT
  'auto_assign_master_escalation_fix OK'                                                              AS status,
  -- o corpo NÃO referencia mais master_cnpj (ramo master removido):
  (position('master_cnpj' in pg_get_functiondef('public.auto_assign_user_role()'::regprocedure)) = 0) AS ramo_master_removido,
  -- mas segue atribuindo employee/customer:
  (position('''employee''' in pg_get_functiondef('public.auto_assign_user_role()'::regprocedure)) > 0) AS atribui_employee,
  (position('''customer''' in pg_get_functiondef('public.auto_assign_user_role()'::regprocedure)) > 0) AS atribui_customer,
  -- masters atuais preservados (o founder continua master):
  (SELECT count(*) FROM public.user_roles WHERE role = 'master')                                       AS masters_atuais;
