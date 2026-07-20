-- Revoga o grant `master` da conta-alias-fiscal do Omie `omie_3545140089@placeholder.local`
-- ("COLACOR S.C LTDA", user_id 5bd80ea4-6e01-4ada-bd7e-964e47053da3).
--
-- CONTEXTO (medido em prod via psql-ro, 2026-07-20):
--   O levantamento de "quem enxerga dado pessoal de cliente" achou 4 grants staff, mas só 3 PESSOAS.
--   A 4ª é um alias fiscal do Omie (`is_placeholder: true`, `omie_codigo_cliente: 3545140089`) que
--   recebeu `master` em 2026-05-12 02:04 UTC — três meses depois de ser criado (2026-03-02) — e
--   NUNCA logou (`last_sign_in_at IS NULL`).
--
-- POR QUE NÃO É INCIDENTE (o vetor de login está fechado, verificado):
--   - Os 7.302 placeholders têm `encrypted_password` = hash bcrypt ALEATÓRIO — artefato do
--     `auth.admin.createUser()` sem `password` (supabase/functions/omie-cliente/index.ts:830,1006).
--     Não há senha conhecida.
--   - `recovery_sent_at IS NULL` (ninguém pediu reset) e `.local` é reservado a mDNS, não é um TLD
--     registrável ⇒ e-mail de recuperação é inentregável por construção.
--   ⇒ O risco é o grant órfão em si (um `master` sem dono humano), não um login iminente.
--
-- POR QUE REVOGAR É SEGURO (impacto medido — o role não sustenta nada):
--   carteira_assignments(owner_user_id) = 0   <- NÃO é dona de carteira
--   carteira_assignments(customer_user_id) = 1 <- é apenas CLIENTE
--   sales_orders(customer_user_id) = 0
--   commercial_roles = 0                       <- sem papel comercial
--   profiles = 1                               <- o cadastro segue intacto
--   Nenhuma referência hardcoded ao uuid nem ao código 3545140089 em src/, supabase/ ou migrations.
--   ⇒ Some o `master`; o alias fiscal continua existindo como cliente, sem efeito no ERP nem na carteira.
--
-- NÃO vira migration: é ato administrativo sobre DADO (`user_roles`), não mudança de schema.
-- Provisionamento de master já é MANUAL por decisão anterior (§4, trigger de auto-atribuição removido
-- em 2026-06-13 após o achado de privilege-escalation) — este DELETE é a operação inversa, no mesmo canal.
--
-- COMO RODAR: cole no SQL Editor do Lovable. Os três blocos de uma vez.

-- ── 1. ANTES: evidência do estado (esperado: 1 linha, role=master) ─────────────────
SELECT ur.role, u.email, ur.created_at AS grant_criado_em, u.last_sign_in_at
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
 WHERE ur.user_id = '5bd80ea4-6e01-4ada-bd7e-964e47053da3';

-- ── 2. REVOGA (predicado duplo: uuid + role — não toca mais nada) ─────────────────
DELETE FROM public.user_roles
 WHERE user_id = '5bd80ea4-6e01-4ada-bd7e-964e47053da3'
   AND role    = 'master';
-- esperado: DELETE 1

-- ── 3. DEPOIS: o quadro de staff deve ficar com 3 linhas, todas de PESSOAS ────────
SELECT ur.role, u.email, u.last_sign_in_at
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
 WHERE ur.role IN ('employee','master')
 ORDER BY ur.role, u.email;
-- esperado: 3 linhas — lucascoelhosardenberg@gmail.com (master),
--           atendimentocolacor@gmail.com e tatyanamartins2002@icloud.com (employee).
-- Se aparecer QUALQUER conta @placeholder.local aqui, PARE: o Omie criou outro alias com role.

-- ── REVERTER (se algo depender disso que a medição não pegou) ─────────────────────
-- INSERT INTO public.user_roles (user_id, role)
-- VALUES ('5bd80ea4-6e01-4ada-bd7e-964e47053da3', 'master');
