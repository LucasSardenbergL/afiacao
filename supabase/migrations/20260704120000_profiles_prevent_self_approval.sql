-- Fecha o bypass de auto-aprovação de customer (UPDATE e INSERT).
--
-- Contexto: `authenticated` tem UPDATE na coluna `profiles.is_approved`, e as policies
-- "Users can update/insert own profile" só protegem `is_employee` no WITH CHECK — nunca
-- `is_approved`. Um customer não-aprovado podia:
--   (a) UPDATE: `supabase.from('profiles').update({is_approved:true}).eq('user_id', self)`
--   (b) INSERT: cadastrar o próprio profile já com `is_approved:true` (Auth.tsx grava
--       `is_approved: opts.isEmployee || !!opts.omieCliente`, tudo client-driven; a auto-
--       aprovação do "cliente Omie" NÃO é server-verificada — o link em omie_clientes é
--       staff-only e nem chega a ser gravado no cadastro do customer).
-- Nos dois casos ele liberava a área de cliente sem o admin aprovar.
--
-- Fix: trigger mantém `is_approved` sob controle do servidor para end-user autenticado
-- que NÃO seja staff (employee/master) nem tenha commercial_role:
--   - UPDATE → reverte ao valor anterior;
--   - INSERT → força false.
-- Preserva: auto-aprovação de staff/comercial (AuthContext faz UPDATE sob a própria
-- identidade, já com o papel atribuído), aprovação por admin (master), e escrita de
-- backend/service_role (auth.uid() IS NULL).
--
-- MUDANÇA DE COMPORTAMENTO: clientes (inclusive "cliente Omie") passam a nascer NÃO
-- aprovados e dependem de aprovação do admin (AdminApprovals). Auto-aprovar cliente Omie
-- com segurança exige verificar o vínculo no servidor — follow-up separado.

CREATE OR REPLACE FUNCTION public.prevent_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só governa o end-user autenticado comum. auth.uid() NULL = contexto backend
  -- (service_role/superuser) → não interfere.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
    OR EXISTS (SELECT 1 FROM public.commercial_roles WHERE user_id = auth.uid())
  ) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_approved := false;           -- nasce não-aprovado
    ELSE
      NEW.is_approved := OLD.is_approved;  -- reverte alteração (fail-closed)
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_prevent_self_approval_upd
  BEFORE UPDATE OF is_approved ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_approved IS DISTINCT FROM NEW.is_approved)
  EXECUTE FUNCTION public.prevent_self_approval();

CREATE OR REPLACE TRIGGER trg_prevent_self_approval_ins
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.is_approved)
  EXECUTE FUNCTION public.prevent_self_approval();
