-- ============================================================
-- Remove o trigger que concede `super_admin` sem decisão humana
--
-- O QUE ELE FAZ (medido em prod 2026-08-30): `trg_auto_commercial_super_admin`,
-- AFTER INSERT ON public.profiles, ATIVO (tgenabled='O'). Se o profile inserido tem
-- is_employee=true e document = company_config.master_cpf, ele grava
-- `commercial_roles.commercial_role = 'super_admin'` (com ON CONFLICT DO UPDATE).
--
-- POR QUE SAI. `super_admin` não é um rótulo inerte — hoje ele concede, de uma vez:
--   · SELECT via private.cap_carteira_ler  (23 policies / 23 tabelas)
--   · via private.cap_custo_ler (11 policies / 8 tabelas), inclusive ESCRITA em
--     farmer_algorithm_config (limiares de margem) e ALL em inventory_position
--   · FOR ALL na PRÓPRIA public.commercial_roles (via private.is_super_admin) —
--     auto-perpetuante: quem entra pode se manter e promover terceiros
--   · SELECT em margin_audit_log e call_log
--   · 4 edges de money-path que testam o mesmo trio no servidor:
--     omie-financeiro · fin-valor-cockpit · fin-next-best-action ·
--     disparar-pedidos-aprovados (esta CRIA PEDIDO no Omie)
--
-- POR QUE É SEGURO REMOVER (medido, não suposto):
--   1. Nunca disparou e não é alcançável por usuário logado: a ÚNICA policy de INSERT
--      em `profiles` é "Users can insert own profile", cujo WITH CHECK exige
--      `is_employee = false` — e o trigger exige `true`. Só dispara por service_role /
--      postgres, isto é: restore, reimport ou paste administrativo.
--   2. Não há risco de lockout. A policy "Admins can manage commercial roles"
--      (FOR ALL, has_role(master)) já deixa qualquer master escrever a tabela, e o
--      canal de recuperação real deste repo é o SQL Editor do Lovable, que roda como
--      `postgres` e ignora RLS. A recuperação nunca dependeu deste trigger.
--   3. Ele tampouco recuperaria um master perdido: escreve `commercial_roles`, não
--      `user_roles` — a tabela que `has_role(master)` de fato consulta.
--
-- NÃO decide o vocabulário do enum e NÃO altera nenhuma capability.
-- ============================================================

-- `profiles` é tabela quente: não fique preso esperando lock.
SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_auto_commercial_super_admin ON public.profiles;

DROP FUNCTION IF EXISTS public.auto_assign_commercial_super_admin();

RESET lock_timeout;
