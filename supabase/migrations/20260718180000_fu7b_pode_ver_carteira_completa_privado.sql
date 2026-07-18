-- FU7-b — fecha o oráculo `pode_ver_carteira_completa` (fatia 2)
-- Spec: docs/superpowers/specs/2026-07-17-carteira-rls-eligible-visibilidade-design.md §8-FU7
-- Prova: db/test-fu7b-pode-ver-carteira-wrapper.sh (PG17, com falsificação)
-- Continuação de 20260718150000 (#1421), já aplicada e validada em prod.
-- Revisão adversária: Codex gpt-5.6-sol xhigh (4 correções incorporadas — ver notas abaixo).
--
-- ESTADO MEDIDO (prod, psql-ro 2026-07-18): SECDEF, `search_path=public`, EXECUTE p/ `authenticated`,
-- parâmetro uuid arbitrário ⇒ oráculo via POST /rest/v1/rpc. Dependências: 64 policies · 1 view
-- (`v_cliente_interacoes`, security_invoker) · 4 funções que a chamam sem qualificar · 0 cron ·
-- 4 call-sites de EDGE via service_role.
--
-- ⚠️ ESCOPO HONESTO: isto NÃO "resolve os oráculos de role". `has_role` (389 policies) segue exposto e
-- é o maior resíduo. O ganho específico daqui é o predicado COMPOSTO: para um `employee`,
-- `pode_ver_carteira_completa` revela se o commercial_role ∈ {gerencial,estrategico,super_admin} —
-- um bit que `has_role` sozinho não dá, e que sobreviveu ao fecho de `get_commercial_role` (#1421).
--
-- POR QUE WRAPPER (e não só mover, como no #1421): as 4 edges chamam por RPC PostgREST, que só publica
-- o schema exposto. Mover sem wrapper quebraria as edges — e deploy de edge aqui é manual.
--   · a IMPLEMENTAÇÃO vai p/ `private` (as 64 policies + a view religam por OID, sem reescrita)
--   · um WRAPPER de mesma assinatura fica em `public`, com EXECUTE **só p/ service_role**
--
-- ✅ O WRAPPER TAMBÉM É UM TOMBSTONE (correção do Codex à premissa da 1ª versão desta migration):
-- `CREATE OR REPLACE FUNCTION` **preserva owner e ACL** — não reaplica default privileges. Logo, uma
-- migration antiga re-aplicada por cima restaura o CORPO mas NÃO reabre o EXECUTE p/ `authenticated`.
-- Ocupar a assinatura em `public` é o que garante isso: sem o tombstone (caso do #1421), o mesmo
-- `CREATE OR REPLACE` criaria função NOVA, que nasce aberta pelo default privilege do Supabase.
-- A reabertura real exigiria DROP+CREATE ou um GRANT explícito.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1) IMPLEMENTAÇÃO → private   (guard duplo: idempotente mesmo com o wrapper já em public)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NOT NULL
     AND to_regprocedure('private.pode_ver_carteira_completa(uuid)') IS NULL THEN
    ALTER FUNCTION public.pode_ver_carteira_completa(uuid) SET SCHEMA private;
  END IF;
END $$;

-- As 64 policies e a view (security_invoker) precisam do EXECUTE — elas guardam a expressão já
-- resolvida por OID, então NÃO precisam de USAGE no schema (provado na falsificação F4 do harness).
-- Por isso aqui só se concede EXECUTE, e a `anon` nada. O USAGE que o #1421 concedeu não é ampliado.
GRANT EXECUTE ON FUNCTION private.pode_ver_carteira_completa(uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 2) WRAPPER em public — só p/ service_role (as 4 edges)
--    SECURITY INVOKER (correção do Codex): ele não faz trabalho privilegiado, apenas encaminha para
--    uma função que JÁ é SECDEF. Evita uma 2ª elevação a `postgres` e deixa a autorização explícita —
--    a ACL do wrapper passa a ser a única barreira desse caminho.
--    `search_path=private` + ref qualificada: imune a shadowing (lição FU7).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'private'
AS $function$ SELECT private.pode_ver_carteira_completa(_uid) $function$;

REVOKE EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) FROM authenticated, anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO service_role;

-- wrapper INVOKER ⇒ o caller precisa dos privilégios internos. service_role já tem USAGE (#1421);
-- reafirmar aqui torna a migration autossuficiente se aplicada isolada.
GRANT USAGE ON SCHEMA private TO service_role;

-- ⚠️ NOTA (correção do Codex): NÃO existe bloco tentando "religar" os 4 callers internos por
-- `search_path`. Seria INÓCUO — o PostgreSQL escolhe a função de assinatura idêntica no PRIMEIRO
-- schema do search_path, então `public, private` continua escolhendo o WRAPPER em `public`. Só
-- qualificar `private.` no CORPO os levaria direto, o que exigiria reescrever 4 funções money-path
-- (incl. `get_preco_cockpit`) por ganho de clareza — fora de escopo, precisão > recall.
-- Os 4 atravessam o wrapper e ACERTAM o gate: são SECDEF owned por `postgres`, que tem EXECUTE nele
-- (provado nos asserts A8/A9/A10). ⚠️ Consequência p/ quem vier depois: uma função
-- `SECURITY INVOKER` nova que chame `pode_ver_carteira_completa(...)` sem qualificar pegará o wrapper
-- e dará 42501 p/ `authenticated` — nesses casos, chame `private.pode_ver_carteira_completa(...)`.

-- ════════════════════════════════════════════════════════════════════════════
-- 3) GUARD DE APPLY (não é detector contínuo — só roda nesta migration; a vigilância permanente
--    é a query de validação read-only do handoff)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF has_function_privilege('authenticated','public.pode_ver_carteira_completa(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FU7-b: wrapper em public EXECUTAVEL por authenticated — oraculo aberto'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT has_function_privilege('authenticated','private.pode_ver_carteira_completa(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FU7-b: authenticated SEM execute na implementacao private — as 64 policies vao dar 42501'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;
