-- ============================================================
-- db_migracoes_adiadas — migration DELIBERADAMENTE não aplicada (status 'adiada')
-- Objetivo: o vigia do Publish (scripts/lovable-vigia.sh) libera sozinho o front quando TODA
-- migration do intervalo ar..main tem recibo `aplicada` em public.db_aplicacoes (o ledger do
-- `db:aplicar`, pelo SHA-256 dos bytes do commit). Uma migration que alguém decidiu NÃO aplicar
-- agora (ex.: fatia futura, dependência externa) travaria o Publish para sempre: esta tabela é a
-- declaração explícita disso — por SHA-256, com motivo e ator, revogável.
-- Incidente (regra de máquina meta): vigia.log 22–26/11/2026 — 36 RETIDO por migration contra
-- 2 liberações manuais, mediana ~5 h retido (docs/historico/lovable-publish-automatico.md).
--
-- Quem lê: o vigia via psql-ro (claude_ro, BYPASSRLS + GRANT SELECT). Quem escreve: claude_rw
-- (scripts/db-adiar.sh). NINGUÉM mais: uma linha forjada aqui faria o vigia publicar front sobre
-- DDL ausente, então o fecho é por ALLOWLIST (como db_aplicacoes, db/claude-rw-bootstrap.sql) —
-- o DEFAULT ACL do schema dá escrita a service_role/sandbox_exec_* (BYPASSRLS) em toda tabela nova.
-- Sem DELETE para ninguém além do dono: desfazer é `revogada_em`.
-- Aplicar: `bun run db:aplicar` (ensaio → apply). Sem BEGIN/COMMIT: a transação é do executor.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.db_migracoes_adiadas (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  arquivo     text NOT NULL CHECK (arquivo ~ '^supabase/migrations/[^/]+\.sql$'),
  motivo      text NOT NULL CHECK (length(btrim(motivo)) >= 10),
  ator        text NOT NULL DEFAULT current_user,
  adiada_em   timestamptz NOT NULL DEFAULT now(),
  revogada_em timestamptz
);

COMMENT ON TABLE public.db_migracoes_adiadas IS
  'Migration deliberadamente NÃO aplicada (status adiada), por SHA-256 dos bytes do commit. '
  'Lida pelo vigia do Publish (psql-ro); escrita só por claude_rw (scripts/db-adiar.sh). '
  'Desfazer = revogada_em. Ver docs/historico/lovable-publish-automatico.md.';

ALTER TABLE public.db_migracoes_adiadas ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.db_migracoes_adiadas FROM PUBLIC;
REVOKE ALL ON public.db_migracoes_adiadas FROM anon;
REVOKE ALL ON public.db_migracoes_adiadas FROM authenticated;

GRANT SELECT ON public.db_migracoes_adiadas TO claude_ro;
GRANT SELECT, INSERT, UPDATE ON public.db_migracoes_adiadas TO claude_rw;

DROP POLICY IF EXISTS db_migracoes_adiadas_rw ON public.db_migracoes_adiadas;
CREATE POLICY db_migracoes_adiadas_rw ON public.db_migracoes_adiadas
  FOR ALL TO claude_rw
  USING (true) WITH CHECK (true);

-- ALLOWLIST: sai todo privilégio que não seja do dono, do claude_rw ou o SELECT do claude_ro
DO $allowlist$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS papel,
           string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privs
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.db_migracoes_adiadas'::regclass
       AND a.grantee <> c.relowner
       AND a.grantee <> 'claude_rw'::regrole
       AND NOT (a.grantee = 'claude_ro'::regrole AND a.privilege_type = 'SELECT')
     GROUP BY 1
  LOOP
    EXECUTE format('REVOKE %s ON public.db_migracoes_adiadas FROM %s', r.privs, r.papel);
  END LOOP;
END
$allowlist$;

-- PÓS-CONDIÇÃO: existe, com RLS, e a ACL é EXATAMENTE a allowlist (existe ≠ vale)
DO $post$
DECLARE
  v_extra text;
BEGIN
  IF to_regclass('public.db_migracoes_adiadas') IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: public.db_migracoes_adiadas não existe — o vigia não tem onde ler o status adiada';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.db_migracoes_adiadas'::regclass) THEN
    RAISE EXCEPTION 'A2 FALHOU: RLS desligada em db_migracoes_adiadas';
  END IF;
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                           a.privilege_type), ', ')
    INTO v_extra
    FROM pg_class c
   CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.db_migracoes_adiadas'::regclass
     AND a.grantee <> c.relowner
     AND NOT (a.grantee = 'claude_rw'::regrole AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE'))
     AND NOT (a.grantee = 'claude_ro'::regrole AND a.privilege_type = 'SELECT');
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'A3 FALHOU: privilégio fora da allowlist em db_migracoes_adiadas (%) — uma linha forjada liberaria o Publish', v_extra;
  END IF;
  IF NOT has_table_privilege('claude_ro', 'public.db_migracoes_adiadas', 'SELECT') THEN
    RAISE EXCEPTION 'A4 FALHOU: claude_ro não lê db_migracoes_adiadas — o vigia leria "desconhecido" para sempre';
  END IF;
  IF has_table_privilege('authenticated', 'public.db_migracoes_adiadas', 'SELECT')
     OR has_table_privilege('anon', 'public.db_migracoes_adiadas', 'SELECT') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon/authenticated leem db_migracoes_adiadas';
  END IF;
END
$post$;
