-- ============================================================
-- margin_audit_log — o master volta a poder LER o próprio log de auditoria
--
-- ACHADO (medido em prod 2026-08-30 via psql-ro). A única policy de SELECT é
--   (private.is_super_admin(uid) OR (SELECT commercial_role …) = 'estrategico')
-- e NENHUM usuário possui 'super_admin' ou 'estrategico': `commercial_roles` tem 3
-- linhas em prod — farmer×2 e master×1. Resultado: 12.393 linhas acumuladas entre
-- 2026-03-02 e 2026-08-30 que NINGUÉM da aplicação consegue ler. A policy de INSERT
-- já é `master OR employee`, então a tabela é write-only há ~6 meses.
--
-- RAIZ: a migração de vocabulário do enum `commercial_role` parou pela metade
-- (20260518100000, "aditivo — mantém o legado"): o DADO passou a farmer/master e os
-- LEITORES continuaram em gerencial/estrategico/super_admin.
--
-- ESCOPO: devolver a leitura ao master, e NADA MAIS. Não decide o vocabulário e não
-- concede a ninguém que já não tivesse: `master` já passa em todos os outros gates de
-- `commercial_role` (cap_carteira_ler, cap_custo_ler, as 4 edges de money-path) —
-- margin_audit_log era a ÚNICA exceção, e por omissão, não por desenho. Os dois ramos
-- legados são preservados byte-a-byte de propósito: removê-los seria decidir o
-- vocabulário aqui, e essa decisão não é desta migration.
--
-- `TO authenticated` e `PERMISSIVE` reproduzem a policy medida em prod — DROP+CREATE
-- de policy NÃO preserva roles, e omiti-los a abriria para PUBLIC.
-- ============================================================

DROP POLICY IF EXISTS "Strategic+ can view margin audit" ON public.margin_audit_log;

CREATE POLICY "Strategic+ can view margin audit"
  ON public.margin_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'master'::public.app_role)
    OR private.is_super_admin(auth.uid())
    OR ((SELECT cr.commercial_role
           FROM public.commercial_roles cr
          WHERE cr.user_id = auth.uid()) = 'estrategico'::public.commercial_role)
  );
