-- ============================================================================================
-- separar_cap_carteira_escrever — LER e ESCREVER carteira deixam de ser a mesma autorização.
-- ============================================================================================
--
-- ESTADO ANTERIOR (medido em prod 2026-08-28 via psql-ro): `private.cap_carteira_escrever` e
-- `private.cap_carteira_ler` tinham o corpo BYTE-A-BYTE idêntico (mesmo md5 do `prosrc`,
-- 836e8f46f863eefd75b3b46a49eba81a) — quem podia LER a carteira podia ESCREVÊ-LA. Duas
-- capabilities com nomes diferentes e uma autorização só: o nome prometia uma separação que o
-- corpo não entregava. Congelado no contrato de RLS pelo #2084, que é o que tornou isto visível.
--
-- MUDANÇA: a escrita perde `estrategico`. Leitura segue `gerencial + estrategico + super_admin`;
-- escrita passa a `gerencial + super_admin`. O perfil analítico/estratégico lê a carteira e não a
-- opera.
--
-- ⚠️ RAIO DE EXPLOSÃO HOJE: **ZERO**, e isto foi MEDIDO, não suposto —
--   · `public.commercial_roles` tem 3 linhas em prod: `farmer`×2 e `master`×1. NINGUÉM tem
--     `gerencial`, `estrategico` ou `super_admin`, então o ramo inteiro está inerte hoje.
--   · das 15 tabelas gateadas pela ESCRITA, **0** têm GRANT de INSERT/UPDATE/DELETE para
--     `authenticated` — quem escreve é `service_role` (edge/cron), que BYPASSA RLS.
--   O valor desta migration é LATENTE: ela decide, de graça e antes do fato, o que acontece no
--   dia em que um usuário `estrategico` for criado ou um GRANT de escrita for concedido.
--
-- 🔴 `CREATE OR REPLACE`, JAMAIS `DROP FUNCTION` + `CREATE`. O ACL medido em prod é
--    `postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres` — repare que
--    PUBLIC NÃO está na lista: ele foi revogado. `DROP`+`CREATE` reseta o ACL para o DEFAULT do
--    Postgres, que é `EXECUTE` para **PUBLIC** — ou seja, a regressão é uma falha ABERTA: `anon`
--    passaria a executar a capability. (Eu havia escrito aqui que a falha seria FECHADA, por
--    perda do EXECUTE de `authenticated`; o harness provou o oposto ao EXECUTAR — cenário F2 de
--    `db/test-separar-cap-carteira-escrever.sh`, que ancora o assert em `anon` justamente por
--    isso.) `CREATE OR REPLACE` preserva o ACL inteiro.
--
-- Idempotente: `CREATE OR REPLACE` pode ser colado quantas vezes for preciso.
-- ============================================================================================

CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','super_admin')
        )
      )
    ), false);
$function$;

COMMENT ON FUNCTION private.cap_carteira_escrever(uuid) IS
  'Capability de ESCRITA da carteira. Estritamente mais estreita que private.cap_carteira_ler: '
  'exclui `estrategico`, que lê e não opera. Antes de 2026-08-28 as duas tinham corpo idêntico.';
