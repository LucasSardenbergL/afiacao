-- ╔═══════════════════════════════════════════════════════════════════════════════════════╗
-- ║  claude-rw-bootstrap.sql — a ÚNICA colagem manual que resta                            ║
-- ║  🟣 Lovable → SQL Editor → cole ISTO → Run.  Depois disso: `bun run db:aplicar`.        ║
-- ║                                                                                        ║
-- ║  ⚠️ ANTES DE COLAR: troque TROQUE_ESTA_SENHA por uma senha forte, e guarde-a em         ║
-- ║     ~/.config/afiacao/claude_rw.pgpass (modo 600). NUNCA cole a senha no chat.          ║
-- ║                                                                                        ║
-- ║  Idempotente: re-colar é seguro (não recria papel, não duplica ledger, não reseta       ║
-- ║  a senha de um papel que já existe).                                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 1) O PAPEL — identidade de escrita SEPARADA, com elevação EXPLÍCITA
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Honestidade sobre o poder: o DDL que este repo faz de verdade (CREATE OR REPLACE VIEW,
-- REVOKE nomeando roles, ALTER TABLE) exige OWNERSHIP. Um papel sem dono existe e não
-- consegue trabalhar — o próprio repo registra um REVOKE que voltou sucesso-com-warning
-- sem revogar nada, justamente por falta disso (docs/agent/database.md §4).
--
-- Então `claude_rw` É membro de `postgres`. O ganho NÃO é privilégio menor — é:
--   (a) IDENTIDADE: as escrituras deixam de ser "alguém com a senha do postgres";
--   (b) NOINHERIT: o estado default é BAIXO. O poder só existe dentro de um
--       `SET LOCAL ROLE postgres`, que morre com a transação e aparece no log;
--   (c) REVOGÁVEL sozinho: `DROP ROLE claude_rw` fecha esta porta sem tocar no `postgres`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_rw') THEN
    -- NOINHERIT é o coração do desenho: sem SET ROLE, este papel é quase inerte.
    CREATE ROLE claude_rw LOGIN NOINHERIT PASSWORD 'TROQUE_ESTA_SENHA';
  END IF;
END
$$;

GRANT postgres TO claude_rw;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 2) O LEDGER — o que torna a automação auditável
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Duas metades, e a separação é o ponto (contrato do parecer Codex de 2026-09-08):
--   • a TENTATIVA é gravada FORA da transação da migration → sobrevive ao rollback,
--     então apply que falhou deixa cicatriz em vez de sumir;
--   • o RECIBO é gravado DENTRO da mesma transação → se a migration volta atrás, o
--     recibo volta junto. Nunca existe "aplicada" para algo que não aplicou.
CREATE TABLE IF NOT EXISTS public.db_aplicacoes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  arquivo       text        NOT NULL,
  sha256        text        NOT NULL,
  commit_sha    text,
  estado        text        NOT NULL DEFAULT 'tentativa'
                            CHECK (estado IN ('tentativa', 'aplicada', 'falhou', 'desconhecido')),
  ator          text        NOT NULL DEFAULT current_user,
  iniciado_em   timestamptz NOT NULL DEFAULT now(),
  concluido_em  timestamptz,
  erro          text
);

COMMENT ON TABLE public.db_aplicacoes IS
  'Trilha de aplicação de SQL em produção via `bun run db:aplicar`. Tentativa gravada fora '
  'da transação (sobrevive a rollback); recibo (estado=aplicada) gravado dentro dela.';

-- A trava contra aplicação DUPLA: os mesmos bytes não entram duas vezes com sucesso.
-- Parcial de propósito — tentativa/falha podem repetir; sucesso não.
CREATE UNIQUE INDEX IF NOT EXISTS db_aplicacoes_sha_aplicada_uniq
  ON public.db_aplicacoes (sha256) WHERE estado = 'aplicada';

CREATE INDEX IF NOT EXISTS db_aplicacoes_iniciado_em_idx
  ON public.db_aplicacoes (iniciado_em DESC);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 3) RLS + ACL — tabela nova SEMPRE com RLS (CLAUDE.md)
-- ════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.db_aplicacoes ENABLE ROW LEVEL SECURITY;

-- Fechar exige as DUAS pontas: PUBLIC e anon (docs/agent/database.md).
REVOKE ALL ON public.db_aplicacoes FROM PUBLIC;
REVOKE ALL ON public.db_aplicacoes FROM anon;

-- Staff LÊ (é trilha de auditoria — serve para ser lida).
GRANT SELECT ON public.db_aplicacoes TO authenticated;

DROP POLICY IF EXISTS db_aplicacoes_staff_le ON public.db_aplicacoes;
CREATE POLICY db_aplicacoes_staff_le ON public.db_aplicacoes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('employee', 'master')
    )
  );

-- Ninguém ESCREVE pela API. A escrita é só do `claude_rw`/`postgres`, via psql.
-- (sem policy de INSERT/UPDATE/DELETE para `authenticated` = negado sob RLS)

-- O ledger é a ÚNICA coisa que `claude_rw` escreve SEM elevar para postgres — de propósito:
-- a trilha não pode depender do mesmo poder que ela existe para vigiar. Sem estes dois
-- (GRANT + POLICY), o NOINHERIT deixaria o papel incapaz de gravar a própria tentativa.
GRANT SELECT, INSERT, UPDATE ON public.db_aplicacoes TO claude_rw;

DROP POLICY IF EXISTS db_aplicacoes_rw ON public.db_aplicacoes;
CREATE POLICY db_aplicacoes_rw ON public.db_aplicacoes
  FOR ALL TO claude_rw
  USING (true) WITH CHECK (true);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PÓS-CONDIÇÃO — o marcador positivo. Se você não vir `BOOTSTRAP_OK`, NÃO deu certo.
-- ════════════════════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN (SELECT count(*) FROM pg_roles WHERE rolname = 'claude_rw') = 1
     AND (SELECT NOT rolinherit FROM pg_roles WHERE rolname = 'claude_rw')
     AND pg_has_role('claude_rw', 'postgres', 'MEMBER')
     AND to_regclass('public.db_aplicacoes') IS NOT NULL
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.db_aplicacoes'::regclass)
     AND NOT has_table_privilege('anon', 'public.db_aplicacoes', 'SELECT')
     AND has_table_privilege('claude_rw', 'public.db_aplicacoes', 'INSERT')
    THEN 'BOOTSTRAP_OK'
    ELSE 'BOOTSTRAP_FALHOU — não prossiga; me mande esta linha'
  END AS resultado;
