-- ============================================================================
-- authz — fecha o EXECUTE de `anon` em duas RPCs de reposição
--
-- Origem: P0 achado por `bun run authz:funcoes:prod` e corrigido À MÃO em prod
-- em 2026-09-07; o repo seguiu aberto. Esta migration é o conserto de RAIZ —
-- o alvo dela é o ambiente RECONSTRUÍDO DO ZERO (DR, staging, prove local),
-- onde o defeito volta a nascer porque ele está no texto das migrations.
--
-- A ARMADILHA (CLAUDE.md · docs/agent/database.md §4): função criada em `public`
-- recebe EXECUTE para `anon` pelo DEFAULT PRIVILEGE do Supabase, e esse grant é
-- **NOMINAL**. `REVOKE ALL … FROM PUBLIC` NÃO remove grant nominal — só
-- `REVOKE … FROM anon` remove. Fechar uma função só com `FROM PUBLIC` a deixa
-- aberta ao anônimo, e a anon key está no bundle público do front.
--
-- ⚠️ Os dois casos abaixo são a MESMA classe por DOIS caminhos OPOSTOS de ACL.
-- Tratá-los com o mesmo REVOKE fecharia só um deles — por isso cada um leva o
-- seu, e a postcondição mede por `has_function_privilege`, que é o único
-- predicado que enxerga os dois caminhos (ver nota no fim do arquivo).
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. aprovar_pedido_sugerido(bigint, text, jsonb) — grant NOMINAL de `anon`
--
-- A 20260906170000 (linha 523) fechou esta sobrecarga só com `FROM PUBLIC` e
-- deu GRANT a authenticated/service_role. O `anon` nominal do default privilege
-- SOBREVIVEU. O próprio autor sabia da armadilha — escreveu o comentário na
-- linha 549 e aplicou o `REVOKE … FROM anon` na sobrecarga de 2 args (linha
-- 551). Esqueceu nesta, a de 3.
--
-- Por que era EXPLORÁVEL, e não teórico:
--   · o gate interno é `IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(…)`.
--     Para `anon`, `auth.uid()` é NULL ⇒ o AND é falso ⇒ **o gate não dispara**.
--     Esse desenho é deliberado (é o caminho de cron/service_role) e por isso é
--     fail-OPEN para o anônimo — o ACL é a ÚNICA barreira que resta;
--   · é SECURITY DEFINER ⇒ bypassa RLS;
--   · vive em `public` ⇒ o PostgREST a expõe como RPC.
-- Somados: chamada NÃO AUTENTICADA aprovava pedido de compra. É money-path.
--
-- Aqui `FROM anon` BASTA: a 20260906170000 já revogou PUBLIC e o repo mantém
-- esse REVOKE. Medido em prod 2026-09-07 (pós-correção manual), o ACL não tem
-- `=X/postgres`.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text, jsonb) FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. reposicao_pedido_e_portal(text, text) — EXECUTE herdado de PUBLIC
--
-- ⚠️ Caminho INVERSO do de cima, e é por isso que o REVOKE aqui é diferente.
-- Medição de prod em 2026-09-07 via psql-ro:
--     acl = {=X/postgres, postgres=X/postgres, authenticated=X/postgres,
--            service_role=X/postgres, sandbox_exec_*=X/postgres}
--     has_function_privilege('anon', oid, 'EXECUTE') = TRUE
-- O ACL **não lista** `anon=X` — o grant nominal já foi revogado à mão. Mas
-- lista `=X/postgres`, que é o grant a **PUBLIC**, e na semântica do Postgres
-- todo role é membro de PUBLIC. Ou seja: `anon` continua alcançando a função
-- por HERANÇA, e um `REVOKE … FROM anon` isolado seria NO-OP silencioso.
-- Por isso os dois REVOKEs. Este é o único dos dois casos que ainda estava
-- ABERTO em prod no momento desta migration — nesta linha ela NÃO é no-op.
--
-- Severidade honesta, bem menor que a de cima: a função é
-- `LANGUAGE sql IMMUTABLE` e PURA — o corpo é
-- `SELECT p_empresa = 'OBEN' AND p_fornecedor_nome ILIKE '%SAYERLACK%'`.
-- Não lê tabela, não escreve, é INVOKER (não bypassa RLS). Fechar é higiene de
-- SUPERFÍCIE — reduzir o que o anônimo alcança — não estancamento de vazamento.
--
-- Pré-voo de dependências (psql-ro, 2026-09-07): 4 funções a chamam
-- (envio_portal_claim_ids, envio_portal_lock_candidatos, reposicao_selar_pedido,
-- reposicao_conferir_envio) e **as 4 são SECURITY DEFINER** ⇒ executam como o
-- OWNER, que tem EXECUTE nominal (`postgres=X`). Revogar PUBLIC não as quebra.
-- O GRANT abaixo reafirma os caminhos legítimos, que já eram nominais e
-- portanto sobrevivem ao REVOKE — está aqui para que um ambiente do zero não
-- dependa de ordem de aplicação.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.reposicao_pedido_e_portal(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_pedido_e_portal(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_e_portal(text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondição — a migration ABORTA se não pegou.
--
-- Mede com `has_function_privilege`, NÃO com `proacl LIKE '%anon=X%'`. O LIKE é
-- o predicado da varredura que originalmente caçou esta classe, e ele é **CEGO
-- ao caso 2**: procura o grant NOMINAL e não vê o herdado de PUBLIC — foi
-- exatamente por isso que `reposicao_pedido_e_portal` não apareceu naquela
-- varredura apesar de estar aberta. `has_function_privilege` responde a
-- pergunta que importa ("o anônimo consegue executar?") pelos dois caminhos.
--
-- O guard de `pg_roles` existe porque `anon` é role do Supabase: num PG cru
-- (o prove local do db/test-*.sh antes dos stubs) ela pode não existir, e aí
-- `has_function_privilege` levanta em vez de responder.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_abertas text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'role anon ausente — postcondicao pulada (ambiente nao-Supabase)';
    RETURN;
  END IF;

  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO v_abertas
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
          (p.proname = 'aprovar_pedido_sugerido'
             AND pg_get_function_identity_arguments(p.oid) LIKE '%jsonb%')
       OR  p.proname = 'reposicao_pedido_e_portal'
     )
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDICAO FALHOU: anon ainda executa: % — a RPC segue alcancavel sem autenticacao pelo PostgREST',
      v_abertas;
  END IF;

  RAISE NOTICE 'OK: anon nao alcanca aprovar_pedido_sugerido(3 args) nem reposicao_pedido_e_portal';
END
$post$;

COMMIT;
