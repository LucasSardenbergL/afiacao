#!/usr/bin/env bash
# PG17: valida a fundação SQL do Roteirizador-prospects (sub-PR A).
# Aplica a migration REAL sobre stubs e exercita as 2 RPCs com falsificação dos
# caminhos negativos (gate, validações, REVOKE) — teste negativo captura a SQLSTATE
# esperada e RE-LANÇA o resto (não é WHEN OTHERS THEN 'OK' teatro).
set -euo pipefail
export LC_ALL=C LANG=C

MIG="supabase/migrations/20260613230000_roteirizador_prospects.sql"
[ -f "$MIG" ] || { echo "❌ migration não encontrada: $MIG (rode do root do repo)"; exit 1; }

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55473
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

echo "=== setup (stubs + tabela pré-migration) ==="
"${P[@]}" <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
-- auth.uid() e o gate leem GUCs de sessão → asserts ligam/desligam o gestor.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(current_setting('test.gestor', true), 't') = 't' $$;

CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY,
  razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_codigo text, municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text,
  data_abertura date,
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  updated_at timestamptz NOT NULL DEFAULT now()
);
SQL

echo "=== aplica a migration REAL ==="
"${P[@]}" -f "$MIG" >/dev/null

echo "=== seed (cidade TOM123 com mix de status + TOM999 p/ isolamento) ==="
"${P[@]}" <<'SQL'
INSERT INTO public.radar_empresas
  (cnpj, razao_social, logradouro, numero, municipio_codigo, municipio_nome, uf, data_abertura, ja_cliente, prospeccao_status) VALUES
  ('00000000000001','A NOVA',   'Rua A','10','TOM123','BETIM','MG','2025-01-10', false, 'a_contatar'),
  ('00000000000002','B NOVA',   'Rua B','20','TOM123','BETIM','MG','2024-06-01', false, 'a_contatar'),
  ('00000000000003','C NOVA',   'Rua C','30','TOM123','BETIM','MG','2023-03-15', false, 'a_contatar'),
  ('00000000000004','D CONVERSA','Rua D','40','TOM123','BETIM','MG','2022-01-01', false, 'em_conversa'),
  ('00000000000005','E SEMRESP', 'Rua E','50','TOM123','BETIM','MG','2021-01-01', false, 'contatado_sem_resposta'),
  ('00000000000006','F DESCART', 'Rua F','60','TOM123','BETIM','MG','2020-01-01', false, 'descartado'),
  ('00000000000007','G VIROU',   'Rua G','70','TOM123','BETIM','MG','2019-01-01', false, 'virou_cliente'),
  ('00000000000008','H JACLI',   'Rua H','80','TOM123','BETIM','MG','2018-01-01', true,  'a_contatar'),
  ('00000000000099','Z OUTRA',   'Rua Z','99','TOM999','CONTAGEM','MG','2025-01-01', false, 'a_contatar');
SQL

echo ""; echo "############ ASSERTS ############"
"${P[@]}" <<'SQL'
SET test.uid = '00000000-0000-0000-0000-0000000000a1';
SET test.gestor = 't';

DO $$
DECLARE v int; r record; v_first3 text;
BEGIN
  -- A1: migration criou colunas/funções/check
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_empresas'
      AND column_name IN ('lat','lng','geocoded_em','geocode_status');
  IF v <> 4 THEN RAISE EXCEPTION 'A1 FALHOU: colunas geo = % (esperava 4)', v; END IF;

  -- A2: prospects da cidade — exclui descartado/virou_cliente/ja_cliente
  SELECT count(*) INTO v FROM public.radar_prospects_para_rota('TOM123');
  IF v <> 5 THEN RAISE EXCEPTION 'A2 FALHOU: TOM123 retornou % prospects (esperava 5)', v; END IF;

  -- A2b: a_contatar primeiro (as 3 primeiras linhas)
  SELECT string_agg(prospeccao_status, ',') INTO v_first3 FROM (
    SELECT prospeccao_status FROM public.radar_prospects_para_rota('TOM123') LIMIT 3
  ) t;
  IF v_first3 <> 'a_contatar,a_contatar,a_contatar' THEN
    RAISE EXCEPTION 'A2b FALHOU: ordem das 3 primeiras = % (esperava 3x a_contatar)', v_first3;
  END IF;

  -- A2c: não vaza outra cidade
  SELECT count(*) INTO v FROM public.radar_prospects_para_rota('TOM999');
  IF v <> 1 THEN RAISE EXCEPTION 'A2c FALHOU: TOM999 retornou % (esperava 1)', v; END IF;

  -- A3: salvar geocode ok → grava lat/lng + status
  PERFORM public.radar_salvar_geocode('00000000000001', -19.97, -44.20, 'ok');
  SELECT count(*) INTO v FROM public.radar_empresas
    WHERE cnpj='00000000000001' AND lat=-19.97 AND lng=-44.20
      AND geocode_status='ok' AND geocoded_em IS NOT NULL;
  IF v <> 1 THEN RAISE EXCEPTION 'A3 FALHOU: geocode ok não persistiu'; END IF;

  -- A3b: a RPC devolve o geo cacheado
  SELECT lat INTO v FROM public.radar_prospects_para_rota('TOM123') WHERE cnpj='00000000000001';
  IF v IS NULL THEN RAISE EXCEPTION 'A3b FALHOU: RPC não devolveu lat cacheado'; END IF;

  -- A4: salvar geocode falhou → lat/lng NULL + status falhou
  PERFORM public.radar_salvar_geocode('00000000000002', NULL, NULL, 'falhou');
  SELECT count(*) INTO v FROM public.radar_empresas
    WHERE cnpj='00000000000002' AND lat IS NULL AND lng IS NULL AND geocode_status='falhou';
  IF v <> 1 THEN RAISE EXCEPTION 'A4 FALHOU: geocode falhou não persistiu corretamente'; END IF;

  -- A10: p_limit respeitado
  SELECT count(*) INTO v FROM public.radar_prospects_para_rota('TOM123', 2);
  IF v <> 2 THEN RAISE EXCEPTION 'A10 FALHOU: p_limit=2 retornou % (esperava 2)', v; END IF;

  RAISE NOTICE 'A1..A4, A10 (caminhos felizes) OK';
END $$;

-- A5: gate nega não-gestor (RAISE forbidden, captura específica + re-raise do resto)
SET test.gestor = 'f';
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN PERFORM public.radar_prospects_para_rota('TOM123');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%forbidden%' THEN v_ok := true; ELSE RAISE; END IF; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'A5a FALHOU: prospects_para_rota não barrou não-gestor'; END IF;

  v_ok := false;
  BEGIN PERFORM public.radar_salvar_geocode('00000000000003', -19.9, -44.0, 'ok');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%forbidden%' THEN v_ok := true; ELSE RAISE; END IF; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'A5b FALHOU: salvar_geocode não barrou não-gestor'; END IF;
  RAISE NOTICE 'A5 (gate) OK';
END $$;
SET test.gestor = 't';

-- A6: lat/lng inválidos com status ok
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN PERFORM public.radar_salvar_geocode('00000000000003', 200, -44, 'ok');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%lat/lng inválidos%' THEN v_ok := true; ELSE RAISE; END IF; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'A6 FALHOU: lat=200 não barrou'; END IF;
  RAISE NOTICE 'A6 (lat/lng range) OK';
END $$;

-- A7: cnpj inválido
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN PERFORM public.radar_salvar_geocode('123', -19.9, -44.0, 'ok');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '%cnpj inválido%' THEN v_ok := true; ELSE RAISE; END IF; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'A7 FALHOU: cnpj curto não barrou'; END IF;
  RAISE NOTICE 'A7 (cnpj) OK';
END $$;

-- A8: REVOKE — anon não executa
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.radar_salvar_geocode(text,double precision,double precision,text)','EXECUTE')
  THEN RAISE EXCEPTION 'A8a FALHOU: anon tem EXECUTE em radar_salvar_geocode'; END IF;
  IF has_function_privilege('anon',
       'public.radar_prospects_para_rota(text,integer)','EXECUTE')
  THEN RAISE EXCEPTION 'A8b FALHOU: anon tem EXECUTE em radar_prospects_para_rota'; END IF;
  IF NOT has_function_privilege('authenticated',
       'public.radar_prospects_para_rota(text,integer)','EXECUTE')
  THEN RAISE EXCEPTION 'A8c FALHOU: authenticated NÃO tem EXECUTE (GRANT quebrou)'; END IF;
  RAISE NOTICE 'A8 (REVOKE/GRANT) OK';
END $$;

-- A9: CHECK do geocode_status barra valor fora do domínio
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN UPDATE public.radar_empresas SET geocode_status='lixo' WHERE cnpj='00000000000003';
  EXCEPTION WHEN check_violation THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'A9 FALHOU: CHECK aceitou geocode_status lixo'; END IF;
  RAISE NOTICE 'A9 (CHECK) OK';
END $$;

SELECT '✅ TODOS OS ASSERTS PASSARAM' AS resultado;
SQL
echo ""; echo "✅ test-roteirizador-prospects done"
