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
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid  LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
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
