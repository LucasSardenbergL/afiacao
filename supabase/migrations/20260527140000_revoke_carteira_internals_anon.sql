-- 20260527140000_revoke_carteira_internals_anon.sql
-- ============================================================
-- Fecha IDOR NÃO-AUTENTICADO nos internals SECDEF do view-as de carteira.
-- ============================================================
-- Achado (audit de grants EXECUTE, 2026-05-27 — query do codex sobre pg_proc):
--   `_carteira_mixgap_for_owner(uuid)` e `_carteira_positivacao_for_owner(uuid)`
--   são SECURITY DEFINER e usam `p_owner` DIRETO (uid := p_owner), SEM gate de
--   autorização (só checam NULL). Por design (Pattern B do codex em
--   20260525210000_viewas_rpcs_for.sql) o gate vive nos WRAPPERS
--   (get_meu_mixgap_for / get_minha_positivacao_for, master-only); os internals
--   deviam ficar acessíveis só ao definer/service_role.
--
--   A migration de criação fez `REVOKE ALL ... FROM PUBLIC, authenticated` —
--   mas NÃO de `anon`. No Supabase o `anon` recebe EXECUTE por grant EXPLÍCITO
--   (default privileges), que `REVOKE FROM PUBLIC` não remove. Resultado: os 2
--   internals continuaram EXECUTÁVEIS por `anon`.
--
--   Impacto: um usuário ANÔNIMO (sem login) podia
--     POST /rest/v1/rpc/_carteira_mixgap_for_owner {"p_owner":"<uuid>"}
--   e extrair a inteligência de carteira (clientes elegíveis, famílias
--   compradas, gaps de cross-sell / positivação) de QUALQUER dono, enumerando
--   UUIDs. Cross-carteira, sem autenticação → bypassa toda a RLS via SECDEF.
--
-- Fix: revoga EXECUTE de anon (e re-assere authenticated + PUBLIC). NÃO quebra
-- os wrappers: função SECDEF executa como o OWNER, então o wrapper (definer)
-- segue podendo chamar o internal independente do grant do chamador. service_role
-- bypassa. Idempotente (REVOKE de privilégio não-detido é no-op).

REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid)      FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public._carteira_positivacao_for_owner(uuid) FROM anon, authenticated, PUBLIC;

-- ============================================================
-- Validação — nenhum dos 2 internals pode estar executável por anon/authenticated
-- ============================================================
SELECT
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
      AND p.proname IN ('_carteira_mixgap_for_owner', '_carteira_positivacao_for_owner')
      AND a.privilege_type = 'EXECUTE'
      AND r.rolname IN ('anon', 'authenticated')
  )
  THEN '✅ internals de carteira NÃO executáveis por anon/authenticated (só definer/service_role)'
  ELSE '❌ ainda executável por anon/authenticated — confira os grants' END AS status;
