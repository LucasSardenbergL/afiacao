-- Stubs mínimos do ambiente Supabase para o replay LOCAL do snapshot.
-- Substitui o que o Supabase real provê (auth, roles) e o que pg_cron criaria.
-- NÃO é o ambiente real — só o suficiente pra provar ordem/dependência/sintaxe.

-- Roles referenciadas por policies (TO anon/authenticated/service_role) e por GRANTs.
DO $$ BEGIN CREATE ROLE anon;                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated;       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_admin;      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticator;       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_auth_admin; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- `claude_rw` (o envelope de escrita): a policy `db_aplicacoes_rw ... TO claude_rw` está no dump de
-- 2026-10-08 e o replay morria em `role "claude_rw" does not exist` sem ela. SÓ ela: o dump sai com
-- `--no-owner --no-privileges`, então GRANT e owner nunca chegam a ele — só role citada em POLICY.
-- ⚠️ NÃO acrescente `claude_ro` aqui: provas que carregam este arquivo criam a sua própria
-- `claude_ro LOGIN BYPASSRLS` com `EXCEPTION WHEN duplicate_object THEN NULL`, e uma `claude_ro` sem
-- atributos nascida antes transforma esse CREATE em no-op calado (medido: test-claude-ro-reconciliacao
-- ficou vermelha, todo 42501 esperado voltava vazio).
DO $$ BEGIN CREATE ROLE claude_rw;           EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schema auth + funções/tabela que policies e FKs referenciam.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  phone              text,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);
-- auth.refresh_tokens com os tipos do Supabase (GoTrue). Lido pela view de diagnóstico
-- `private.auth_refresh_tokens_diag`, criada em prod depois do snapshot de 2026-09-05: sem este
-- stub o replay do dump novo morre em `relation "auth.refresh_tokens" does not exist` e o
-- `db/refresh-snapshot.sh` recusa instalar (medido 2026-10-08). A coluna `token` existe no real e
-- fica aqui também — a view não a expõe, de propósito, e o stub não decide isso por ela.
-- ⚠️ Mesmo formato (com os DEFAULTs) de `db/test-claude-ro-reconciliacao.sh`, que cria a sua própria com
-- `IF NOT EXISTS` DEPOIS de carregar este arquivo: um stub sem default chegava antes, o dela virava
-- no-op, o INSERT dela gravava created_at NULL e o assert (2b) caía (medido 2026-10-08). Duas
-- definições da mesma tabela no repo têm de concordar — senão quem carrega primeiro decide calado.
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  instance_id uuid,
  id          bigserial PRIMARY KEY,
  token       varchar(255),
  user_id     varchar(255),
  revoked     boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  parent      varchar(255),
  session_id  uuid
);
-- auth.uid() como o do Supabase: o GUC legado request.jwt.claim.sub e, sem ele, o `sub` de
-- request.jwt.claims. Sem nenhum dos dois (o caso de toda prova que não simula sessão) é NULL, como
-- antes. A POS de 20261005150000 simula uma sessão logada por esses GUCs, e o stub que devolvia NULL
-- sempre a fazia falhar em toda prova que aplica a cadeia viva do data-health.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text  LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
CREATE OR REPLACE FUNCTION auth.jwt()  RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;

-- Schema cron + tabelas que as views v_cron_jobs_* leem (pg_cron fica comentado no prelude).
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigint PRIMARY KEY,
  schedule text,
  command  text,
  nodename text,
  nodeport integer,
  database text,
  username text,
  active   boolean,
  jobname  text
);
CREATE TABLE IF NOT EXISTS cron.job_run_details (
  jobid          bigint,
  runid          bigint,
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);
