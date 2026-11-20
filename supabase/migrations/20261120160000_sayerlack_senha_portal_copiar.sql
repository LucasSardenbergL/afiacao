-- ============================================================
-- Botão "Copiar senha do portal" (só master) — lê a senha ATIVA do portal Sayerlack no Vault
--
-- Uso: o founder entra no portal à mão pelo Chrome, cola a senha e o Chrome oferece atualizar a
-- senha salva. Depois da rotação automática (20261120130000) a senha só existe no Vault.
--
-- Regras (fronteira = esta função):
--   - só master (has_role DENTRO da função; EXECUTE só authenticated — anon/PUBLIC revogados);
--   - Vault sem senha ativa ⇒ erro claro (P0002), NUNCA cai no env (o env é bootstrap velho);
--   - rotação aberta (solicitada|em_andamento|ambigua) ⇒ recusa (55000): a senha pode estar mudando;
--   - toda leitura bem-sucedida grava QUEM e QUANDO em `sayerlack_senha_portal_leituras` (sem a
--     senha; escritor único = esta função). A linha e o retorno estão na mesma transação.
-- ============================================================

BEGIN;

-- ---------- auditoria de leitura (NUNCA contém senha) ----------
CREATE TABLE IF NOT EXISTS public.sayerlack_senha_portal_leituras (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  versao text,          -- description do segredo ativo (id da rodada que o provou) — não é a senha
  lido_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sayerlack_senha_portal_leituras_lido
  ON public.sayerlack_senha_portal_leituras (lido_em DESC);

ALTER TABLE public.sayerlack_senha_portal_leituras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sayerlack_senha_portal_leituras_select_master" ON public.sayerlack_senha_portal_leituras;
CREATE POLICY "sayerlack_senha_portal_leituras_select_master"
  ON public.sayerlack_senha_portal_leituras
  FOR SELECT
  USING (public.has_role(auth.uid(), 'master'::public.app_role));

REVOKE ALL ON public.sayerlack_senha_portal_leituras FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sayerlack_senha_portal_leituras TO authenticated;
GRANT ALL ON public.sayerlack_senha_portal_leituras TO service_role;

-- ---------- a RPC do botão ----------
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_copiar()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_senha text;
  v_versao text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'APENAS_MASTER: só o master pode copiar a senha do portal' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status FROM public.sayerlack_senha_rotacao
   WHERE status IN ('solicitada', 'em_andamento', 'ambigua') LIMIT 1;
  IF v_status IS NOT NULL THEN
    RAISE EXCEPTION 'TROCA_EM_ANDAMENTO: a senha do portal está sendo trocada (%) — tente de novo em alguns minutos', v_status
      USING ERRCODE = '55000';
  END IF;

  SELECT valor, rotacao INTO v_senha, v_versao FROM public._sayerlack_vault_ler('sayerlack_portal_pass');
  IF v_senha IS NULL THEN
    RAISE EXCEPTION 'SEM_SENHA_NO_VAULT: a senha ainda não está no Vault' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.sayerlack_senha_portal_leituras (user_id, versao) VALUES (v_uid, v_versao);
  RETURN v_senha;
END
$fn$;

REVOKE ALL ON FUNCTION public.sayerlack_senha_portal_copiar() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sayerlack_senha_portal_copiar() TO authenticated;

-- ---------- postcondição ----------
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sayerlack_senha_portal_leituras' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: sayerlack_senha_portal_leituras ausente ou sem RLS';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_senha_portal_copiar()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon executa sayerlack_senha_portal_copiar — a senha vazaria sem login';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sayerlack_senha_portal_copiar()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated nao executa sayerlack_senha_portal_copiar — o botao do master nao funcionaria';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'sayerlack_senha_portal_copiar' AND p.prosecdef
      AND p.prosrc LIKE '%has_role(v_uid, ''master''::public.app_role)%'
  ) THEN
    RAISE EXCEPTION 'A4 FALHOU: sayerlack_senha_portal_copiar sem SECURITY DEFINER ou sem o gate de master no corpo';
  END IF;
  IF has_function_privilege('authenticated', 'public._sayerlack_vault_ler(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sayerlack_vault_ler(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: helper do Vault exposto a anon/authenticated';
  END IF;
  RAISE NOTICE 'OK: copiar senha do portal instalado (so master, auditado)';
END
$post$;

COMMIT;
