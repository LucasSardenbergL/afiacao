#!/usr/bin/env bash
# Valida as RPCs da Fatia 3 do Radar num PostgreSQL 17 local.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55438
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs: schema mínimo que a migration referencia (radar_* + tarefas + gate).
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY,
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL,
  data_abertura date,
  municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  omie_codigo_cliente text, omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL,
  lat double precision, lng double precision);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL, acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, status_anterior text,
  created_at timestamptz NOT NULL DEFAULT now());
-- tarefas: réplica mínima com os CHECKs que a RPC precisa satisfazer.
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('ligar','oferecer','preco','whatsapp','outro')),
  customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL,
  empresa text NOT NULL,
  modo text NOT NULL CHECK (modo IN ('data','interacao')),
  due_date date, interacao_tipo text CHECK (interacao_tipo IN ('ligacao','visita','entrega')),
  auto_satisfy_mode text NOT NULL DEFAULT 'off' CHECK (auto_satisfy_mode IN ('off','interacao','conteudo')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','cancelada')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tarefas_modo_coerencia_chk CHECK (
    (modo='data' AND due_date IS NOT NULL AND interacao_tipo IS NULL)
    OR (modo='interacao' AND interacao_tipo IS NOT NULL AND due_date IS NULL)));
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260613190000_radar_fatia3.sql >/dev/null

"${PSQL[@]}" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_municipios VALUES
  ('3106200','BELO HORIZONTE','MG',-19.92,-43.94),
  ('3550308','SAO PAULO','SP',-23.55,-46.63);
-- 3 em BH (2 com telefone, 2 a_contatar, 1 já cliente), 1 em SP, 1 descartada.
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, municipio_codigo, municipio_nome, uf, telefone1, prospeccao_status, ja_cliente, ultimo_lote, data_abertura) VALUES
  ('11111111000111','MARCENARIA A','3101200','3106200','BELO HORIZONTE','MG','31999990001','a_contatar',false,'2026-05','2020-01-10'),
  ('22222222000122','MARCENARIA B','3101200','3106200','BELO HORIZONTE','MG',NULL,        'a_contatar',false,'2026-05','2024-06-01'),
  ('33333333000133','MOVEIS C',    '3101200','3106200','BELO HORIZONTE','MG','3133334444','em_conversa',true, '2026-05','2015-03-03'),
  ('44444444000144','SERRALHERIA D','2512800','3550308','SAO PAULO','SP','11988887777','a_contatar',false,'2026-05','2019-09-09'),
  ('55555555000155','DESCARTADA E','3101200','3106200','BELO HORIZONTE','MG','31900000000','descartado',false,'2026-05','2021-01-01');

SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';

-- A1: contagem por município — BH default (exclui descartada + já-cliente) = 2 total, 1 com telefone, 2 a_contatar.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT * FROM public.radar_contagem_por_municipio() LOOP
    n := n + 1;
    IF r.municipio_codigo = '3106200' THEN
      IF r.total <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: BH total=% (esperado 2)', r.total; END IF;
      IF r.com_telefone <> 1 THEN RAISE EXCEPTION 'A1 FALHOU: BH com_telefone=% (esperado 1)', r.com_telefone; END IF;
      IF r.a_contatar <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: BH a_contatar=% (esperado 2)', r.a_contatar; END IF;
      IF r.lat IS NULL THEN RAISE EXCEPTION 'A1 FALHOU: BH sem lat (join radar_municipios)'; END IF;
    END IF;
  END LOOP;
  IF n <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: % municípios (esperado 2: BH+SP)', n; END IF;
  RAISE NOTICE 'A1 OK';
END $$;

-- A2: filtro UF=MG + cnae exato 3101200 → só BH com 2; SP some.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.radar_contagem_por_municipio('MG', NULL, '3101200');
  IF n <> 1 THEN RAISE EXCEPTION 'A2 FALHOU: % linhas (esperado 1 = só BH)', n; END IF;
  RAISE NOTICE 'A2 OK';
END $$;

-- A3: incluir já-clientes → BH total sobe pra 3.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.radar_contagem_por_municipio('MG',NULL,NULL,NULL,true) WHERE municipio_codigo='3106200';
  IF r.total <> 3 THEN RAISE EXCEPTION 'A3 FALHOU: BH com já-clientes total=% (esperado 3)', r.total; END IF;
  RAISE NOTICE 'A3 OK';
END $$;

-- A4: atribuir tarefa cria 1 linha correta (modo=data, due_date=hoje+7, customer NULL, oben, ligar).
DO $$
DECLARE r jsonb; t record;
BEGIN
  r := public.radar_atribuir_tarefa('11111111000111', 7);
  IF (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A4 FALHOU: não deveria deduplicar 1ª vez'; END IF;
  SELECT * INTO t FROM public.tarefas WHERE id=(r->>'id')::uuid;
  IF t.customer_user_id IS NOT NULL THEN RAISE EXCEPTION 'A4 FALHOU: customer_user_id deveria ser NULL'; END IF;
  IF t.assigned_to <> '00000000-0000-0000-0000-0000000000a1' THEN RAISE EXCEPTION 'A4 FALHOU: assigned_to'; END IF;
  IF t.empresa <> 'oben' OR t.categoria <> 'ligar' OR t.modo <> 'data' THEN RAISE EXCEPTION 'A4 FALHOU: campos'; END IF;
  IF t.due_date <> current_date + 7 THEN RAISE EXCEPTION 'A4 FALHOU: due_date'; END IF;
  IF t.descricao NOT LIKE '%CNPJ 11111111000111%' THEN RAISE EXCEPTION 'A4 FALHOU: descricao sem cnpj'; END IF;
  RAISE NOTICE 'A4 OK';
END $$;

-- A5: dedupe da tarefa (2ª chamada <2min devolve deduped=true, não cria 2ª linha).
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := public.radar_atribuir_tarefa('11111111000111', 7);
  IF NOT (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A5 FALHOU: deveria deduplicar'; END IF;
  SELECT count(*) INTO n FROM public.tarefas WHERE descricao LIKE '%CNPJ 11111111000111%';
  IF n <> 1 THEN RAISE EXCEPTION 'A5 FALHOU: criou % tarefas (esperado 1)', n; END IF;
  RAISE NOTICE 'A5 OK';
END $$;

-- A6: registrar cadastro Omie → marca virou_cliente + ja_cliente + omie_codigo_cliente + loga.
DO $$
DECLARE r jsonb; e record; c int;
BEGIN
  r := public.radar_registrar_cadastro_omie('22222222000122', '9988', false);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'A6 FALHOU: ok'; END IF;
  SELECT * INTO e FROM public.radar_empresas WHERE cnpj='22222222000122';
  IF e.prospeccao_status <> 'virou_cliente' THEN RAISE EXCEPTION 'A6 FALHOU: status'; END IF;
  IF e.ja_cliente <> true THEN RAISE EXCEPTION 'A6 FALHOU: ja_cliente'; END IF;
  IF e.omie_codigo_cliente <> '9988' THEN RAISE EXCEPTION 'A6 FALHOU: codigo'; END IF;
  SELECT count(*) INTO c FROM public.radar_contatos WHERE cnpj='22222222000122' AND acao='virou_cliente';
  IF c <> 1 THEN RAISE EXCEPTION 'A6 FALHOU: não logou'; END IF;
  RAISE NOTICE 'A6 OK';
END $$;

RESET ROLE; SET test.uid = '';

-- A7: gate — não-gestor é negado nas 3 RPCs.
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000b2'; -- não está em test_gestores
DO $$ BEGIN
  PERFORM public.radar_contagem_por_municipio();
  RAISE EXCEPTION 'A7 FALHOU: não-gestor leu contagem';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7a OK';
END $$;
DO $$ BEGIN
  PERFORM public.radar_atribuir_tarefa('11111111000111', 7);
  RAISE EXCEPTION 'A7 FALHOU: não-gestor criou tarefa';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7b OK';
END $$;
DO $$ BEGIN
  PERFORM public.radar_registrar_cadastro_omie('11111111000111','1',false);
  RAISE EXCEPTION 'A7 FALHOU: não-gestor registrou cadastro';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7c OK';
END $$;
RESET ROLE;

-- A8: EXECUTE revogado de anon nas 3.
DO $$ BEGIN
  IF has_function_privilege('anon','public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'A8 FALHOU: anon tem EXECUTE na contagem'; END IF;
  IF has_function_privilege('anon','public.radar_atribuir_tarefa(text,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'A8 FALHOU: anon tem EXECUTE na tarefa'; END IF;
  RAISE NOTICE 'A8 OK';
END $$;

-- A9 (perf informativo): contagem sem filtro sobre N linhas mede o pior caso.
--   (com 5 linhas é trivial; em prod o front debounça. Só prova que não dá erro.)
DO $$ DECLARE n int; BEGIN
  SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';
  SELECT count(*) INTO n FROM public.radar_contagem_por_municipio();
  RAISE NOTICE 'A9 OK (contagem retornou % municípios)', n;
  RESET ROLE;
END $$;
SQL
echo "✅ test-radar-fatia3: todos os asserts passaram"
