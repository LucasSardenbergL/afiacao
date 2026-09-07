-- ============================================================================================
-- cap_carteira_escrever_master_only — a ESCRITA da carteira passa a refletir o acesso EFETIVO.
-- ============================================================================================
--
-- SUPERSEDE `20260828210836_separar_cap_carteira_escrever.sql` (mergeado no #2087 e NUNCA
-- aplicado). Aquela migration removia apenas `estrategico` da lista de `commercial_role`. A 2ª
-- opinião (Codex, xhigh) derrubou a escolha com um argumento que se sustenta: aquilo era
-- TAXONOMIA INFERIDA DO NOME — "estratégico analisa, gerencial opera" é uma política que ninguém
-- escreveu —, e o teste que a protegia apenas congelava o palpite. Se as duas opções são
-- invenção, ganha a que PRESERVA COMPORTAMENTO e falha FECHADO.
--
-- Colar só ESTA. A anterior é inócua se colada antes (idempotente, e esta a sobrescreve), mas
-- não precisa.
--
-- MUDANÇA: `master OR (employee AND commercial_role IN ('gerencial','estrategico','super_admin'))`
--          → `master`. O corpo passa a ser BYTE-A-BYTE o de `private.cap_compras_ler` /
--          `cap_preco_escrever` / `cap_credito_escrever` (o trio de md5 `5faf2a21…` que o contrato
--          de RLS já documenta) — de propósito: um texto equivalente-porém-diferente criaria um
--          quarto md5 para a mesma regra, e md5 distinto para regra idêntica é ruído no eixo 3.
--
-- ⚠️ POR QUE ISTO NÃO MUDA COMPORTAMENTO NENHUM HOJE — medido, não suposto:
--   · `public.commercial_roles` tem 3 linhas em prod: `farmer`×2 e `master`×1. NINGUÉM tem
--     `gerencial`, `estrategico` ou `super_admin`, então o ramo removido nunca concedeu nada.
--     O acesso EFETIVO de escrita hoje já é `master` e só; esta migration passa a DIZER isso.
--   · das 15 tabelas gateadas por esta capability, **0** têm GRANT de INSERT/UPDATE/DELETE para
--     `authenticated` — quem escreve é `service_role` (edge/cron), que BYPASSA RLS.
--
-- ⚠️ O QUE ISTO DESCARTA, e é uma perda real: `20260718190000_authz_capability_matrix_e2.sql`
--    REGISTROU a intenção de que os três papéis comerciais tivessem acesso à carteira. Esta
--    migration descarta uma decisão registrada, não apenas evita inventar uma. A troca é
--    deliberada: em autorização, o dia em que existir um `gerencial` de verdade é um dia melhor
--    para decidir do que hoje — e nesse dia a negação é visível e explícita, não silenciosa.
--    Reabrir é uma linha: devolver o ramo do `commercial_role` com a lista que for decidida.
--
-- ⚠️ O QUE ISTO NÃO TOCA: `private.cap_carteira_ler` fica INTACTA (segue com os três papéis), e
--    o caminho por LINHA dos vendedores — `private.carteira_visivel_para`, que dá acesso à
--    carteira própria e à cobertura ativa — também. Nenhum `farmer` perde nada: eles nunca
--    passaram por esta capability.
--
-- 🔴 `CREATE OR REPLACE`, JAMAIS `DROP FUNCTION` + `CREATE`. O ACL em prod é
--    `postgres=X | authenticated=X | service_role=X` — PUBLIC está REVOGADO. `DROP`+`CREATE`
--    reseta o ACL para o default do Postgres, que é `EXECUTE` para PUBLIC: falha ABERTA, `anon`
--    passaria a executar a capability. Provado executando (cenário F2 do harness).
--
-- Idempotente: pode ser colada quantas vezes for preciso.
-- ============================================================================================

CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;

COMMENT ON FUNCTION private.cap_carteira_escrever(uuid) IS
  'Capability de ESCRITA da carteira: master-only. Reflete o acesso EFETIVO medido em '
  '2026-08-28 (nenhum usuario possui os papeis comerciais que a versao anterior testava) e '
  'falha FECHADO para todo papel ainda nao decidido. Estritamente mais estreita que '
  'private.cap_carteira_ler, que segue com gerencial/estrategico/super_admin.';
