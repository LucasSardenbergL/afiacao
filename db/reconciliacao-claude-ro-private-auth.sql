-- ============================================================
-- claude_ro — reconciliação pós-fecho (2026-09-06)
--
-- ✅ APLICADO EM PROD em 2026-09-06 20:45 BRT (fzvklzpomgnyikkfkzai).
--    Re-medido pelo próprio claude_ro via ~/.config/afiacao/psql-ro:
--      · USAGE private = t · vault = f · auth = f · pg_read_all_data = f
--      · private.customer_metrics_mv → 5.665 linhas LIDAS (evidência positiva;
--        mv_oportunidade_badge devolve 0 porque está populada e vazia hoje,
--        relispopulated=t, 40 kB — não é falta de privilégio)
--      · a ponte nasceu com reloptions `security_invoker=on`, projetando
--        7 colunas; `token`/`parent` continuam SEM ACL próprio em
--        auth.refresh_tokens (a 2ª barreira está de pé)
--      · vault.decrypted_secrets → 42501 · auth.refresh_tokens → 42501
--        · token na ponte → 42703 (coluna ausente)
--    Não re-aplicar: o guard de entrada aborta se pg_read_all_data voltar,
--    mas o CREATE OR REPLACE VIEW é idempotente e passaria em silêncio.
--
-- CONTEXTO: o fecho do `pg_read_all_data` foi aplicado em 2026-08-25
-- (docs/historico/revoke-que-nao-revoga.md). Ele atingiu o objetivo — o
-- vault e o schema `auth` ficaram fora do alcance do claude_ro — mas
-- deixou DUAS pontas soltas, medidas em 2026-09-06 19:34 BRT:
--
--   1. `private` foi perdido junto e NÃO está catalogado nas perdas.
--      São 3 MVs, incluindo `mv_oportunidade_badge`, cuja validação o
--      database.md §4 documenta ("a validação pós-apply exige MV > 0").
--      Esse diagnóstico está morto hoje, sem registro.
--
--   2. O `GRANT SELECT (7 colunas) ON auth.refresh_tokens` pousou INERTE:
--      o catálogo registra as 7 colunas, mas sem USAGE no schema `auth`
--      o acesso não existe ("gaveta trancada dentro de sala trancada").
--      O doc concluiu "morreu em definitivo" porque
--      `GRANT USAGE ON SCHEMA auth` é no-op (postgres tem U sem `*`).
--      ⇒ Correto sobre AQUELA via. Mas o diagnóstico "morreu" estava
--      errado: o USAGE de schema só é exigido no caminho DIRETO (parser
--      resolvendo `auth.refresh_tokens`); quando o rewriter EXPANDE uma
--      view, ele não re-checa USAGE — só o ACL de relação/coluna. Logo
--      uma VIEW em `private` (schema que o postgres possui) reativa o
--      GRANT por coluna que já está no catálogo, sem tocar em `auth`.
--
-- ⚠️ A ponte projeta APENAS as 7 colunas de telemetria. `token` e `parent`
--    — os valores trocáveis por sessão de master, que são a razão do fecho —
--    ficam DE FORA. O fecho de credencial NÃO é revertido; só a telemetria
--    volta. Os guards abaixo provam as duas coisas.
--
-- Sem migration versionada, por decisão registrada: nenhuma migration do
-- repo gerencia o papel `claude_ro` (nasceu ad-hoc) e um ALTER/GRANT em
-- supabase/migrations/ quebraria ambiente reconstruído do zero.
--
-- Prova: db/test-claude-ro-reconciliacao.sh (PG17 + falsificação).
-- Idempotente: GRANT / CREATE OR REPLACE / ALTER DEFAULT PRIVILEGES.
-- ============================================================

BEGIN;

DO $guard_in$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    RAISE EXCEPTION 'ABORTA: role claude_ro não existe — bloco é específico de prod';
  END IF;
  -- não rodar isto num banco onde o fecho ainda não aconteceu
  IF pg_has_role('claude_ro','pg_read_all_data','USAGE') THEN
    RAISE EXCEPTION 'ABORTA: claude_ro ainda é membro de pg_read_all_data — aplique o fecho primeiro';
  END IF;
END
$guard_in$;

-- ── 1. `private`: devolve o diagnóstico das 3 MVs ─────────────────────────
-- Sem segredo: schema fora do PostgREST, owner postgres. `ON ALL TABLES`
-- alcança MATVIEW (relkind 'm') — provado no harness, não presumido.
GRANT USAGE ON SCHEMA private TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA private TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
  GRANT SELECT ON TABLES TO claude_ro;

-- ── 2. Ponte de telemetria de login ───────────────────────────────────────
-- `security_invoker = ON`, e a escolha é o ponto todo (medido em PG17,
-- db/test-claude-ro-reconciliacao.sh F1):
--   • O USAGE de schema NÃO é re-checado quando o rewriter expande a view —
--     só o ACL da relação/coluna é. Por isso o GRANT por coluna de 25/08
--     nunca esteve morto: estava inalcançável apenas pelo caminho DIRETO,
--     onde o parser precisa resolver `auth.refresh_tokens` e exige o USAGE.
--   • Com `on`, a leitura roda como o CALLER ⇒ o ACL de coluna de 25/08
--     continua sendo barreira: se alguém um dia acrescentar `token` a esta
--     view, o claude_ro leva 42501 mesmo assim (medido: H2).
--   • Com `off` a view leria como o OWNER e essa 2ª barreira sumiria —
--     `token` na view passaria a ser legível (medido: H3). Por isso NÃO `off`.
-- ⚠️ Repetir o WITH em todo replace (database.md §4): omitir RESETA para o
--    default `off` e apaga silenciosamente a 2ª barreira.
CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag
  WITH (security_invoker = on) AS
SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id
FROM auth.refresh_tokens;

COMMENT ON VIEW private.auth_refresh_tokens_diag IS
  'Telemetria de login p/ claude_ro (fase-sem-sinal.md). security_invoker=on de proposito: '
  'preserva o ACL por coluna de 2026-08-25 como 2a barreira. NUNCA adicionar token/parent.';

REVOKE ALL ON private.auth_refresh_tokens_diag FROM PUBLIC;
GRANT SELECT ON private.auth_refresh_tokens_diag TO claude_ro;

-- ── 3. Guards de saída (abortam com rollback) ─────────────────────────────
DO $guard_out$
BEGIN
  -- (a) o FECHO não foi revertido — o mais importante deste bloco
  IF has_schema_privilege('claude_ro','vault','USAGE') THEN
    RAISE EXCEPTION 'ABORTA (a): o vault REABRIU para claude_ro';
  END IF;
  IF has_schema_privilege('claude_ro','auth','USAGE') THEN
    RAISE EXCEPTION 'ABORTA (a): o schema auth REABRIU para claude_ro';
  END IF;
  IF has_table_privilege('claude_ro','auth.refresh_tokens','SELECT') THEN
    RAISE EXCEPTION 'ABORTA (a): claude_ro voltou a ler auth.refresh_tokens direto';
  END IF;

  -- (a'') 2ª barreira: o ACL de coluna de 25/08 segue negando token/parent
  IF has_column_privilege('claude_ro','auth.refresh_tokens','token','SELECT')
     OR has_column_privilege('claude_ro','auth.refresh_tokens','parent','SELECT') THEN
    RAISE EXCEPTION 'ABORTA (a''''): claude_ro ganhou SELECT em token/parent — a 2a barreira caiu';
  END IF;

  -- (a') 1ª barreira: a ponte NÃO carrega a credencial
  IF EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid='private.auth_refresh_tokens_diag'::regclass
               AND attname IN ('token','parent') AND attnum>0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ABORTA (a''): a ponte projeta token/parent — isso REABRE a escalada';
  END IF;

  -- (b) o que este bloco promete entregar
  IF NOT has_table_privilege('claude_ro','private.auth_refresh_tokens_diag','SELECT') THEN
    RAISE EXCEPTION 'ABORTA (b): claude_ro não alcança a ponte';
  END IF;
  IF NOT has_schema_privilege('claude_ro','private','USAGE') THEN
    RAISE EXCEPTION 'ABORTA (b): claude_ro não tem USAGE em private';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c
             WHERE c.relnamespace='private'::regnamespace AND c.relkind='m'
               AND NOT has_table_privilege('claude_ro', c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'ABORTA (b): sobrou MV de private fora do alcance (ALL TABLES não pegou matview?)';
  END IF;

  -- (c) nada de escrita
  IF has_table_privilege('claude_ro','private.auth_refresh_tokens_diag','UPDATE')
     OR has_table_privilege('claude_ro','private.auth_refresh_tokens_diag','DELETE') THEN
    RAISE EXCEPTION 'ABORTA (c): claude_ro ganhou escrita na ponte';
  END IF;

  RAISE NOTICE 'OK: private devolvido + telemetria de login restaurada; vault e auth seguem fechados';
END
$guard_out$;

COMMIT;
