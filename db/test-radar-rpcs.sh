#!/usr/bin/env bash
# Valida as RPCs de contato/KPIs do Radar num PostgreSQL 17 local.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55437
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs: schema mínimo que a migration referencia.
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz,
  descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL, acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL, novos integer);
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260612130000_radar_rpcs_contato.sql >/dev/null

"${PSQL[@]}" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_ingest_state VALUES ('2026-05','complete',1000);
INSERT INTO public.radar_empresas (cnpj, ultimo_lote) VALUES
  ('11111111000111','2026-05'), ('22222222000122','2026-05');

SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';

-- A1: registrar 'em_conversa' muda o status da empresa e loga com status_anterior='a_contatar'
DO $$
DECLARE r jsonb;
BEGIN
  r := public.registrar_contato_radar('11111111000111','em_conversa','falei com o dono');
  IF (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A1 FALHOU: não deveria deduplicar 1ª vez'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='11111111000111') <> 'em_conversa'
    THEN RAISE EXCEPTION 'A1 FALHOU: status não mudou'; END IF;
  IF (SELECT status_anterior FROM public.radar_contatos WHERE id=(r->>'id')::uuid) <> 'a_contatar'
    THEN RAISE EXCEPTION 'A1 FALHOU: status_anterior errado'; END IF;
  RAISE NOTICE 'A1 OK';
END $$;

-- A2: dedupe — mesma ação <2min devolve o mesmo id com deduped=true
DO $$
DECLARE r jsonb;
BEGIN
  r := public.registrar_contato_radar('11111111000111','em_conversa',NULL);
  IF NOT (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A2 FALHOU: deveria deduplicar'; END IF;
  RAISE NOTICE 'A2 OK';
END $$;

-- A3: undo reverte ao status_anterior e apaga a linha
DO $$
DECLARE r jsonb; v_id uuid; u jsonb;
BEGIN
  -- novo contato (descartado) numa empresa limpa, depois desfaz
  r := public.registrar_contato_radar('22222222000122','descartado','não é do ramo');
  v_id := (r->>'id')::uuid;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'descartado'
    THEN RAISE EXCEPTION 'A3 FALHOU: não descartou'; END IF;
  IF (SELECT descarte_motivo FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'não é do ramo'
    THEN RAISE EXCEPTION 'A3 FALHOU: motivo não gravou'; END IF;
  u := public.desfazer_contato_radar(v_id);
  IF NOT (u->>'deleted')::boolean THEN RAISE EXCEPTION 'A3 FALHOU: undo não deletou'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'a_contatar'
    THEN RAISE EXCEPTION 'A3 FALHOU: status não reverteu'; END IF;
  IF EXISTS (SELECT 1 FROM public.radar_contatos WHERE id=v_id)
    THEN RAISE EXCEPTION 'A3 FALHOU: linha não apagou'; END IF;
  RAISE NOTICE 'A3 OK';
END $$;

-- A4: undo anti-regressão — se um contato MAIS NOVO mudou o status, o undo do velho
--     apaga a linha mas NÃO reverte o status (não pisa no contato novo).
DO $$
DECLARE r1 jsonb; r2 jsonb; v_id1 uuid; u jsonb;
BEGIN
  r1 := public.registrar_contato_radar('11111111000111','contatado_sem_resposta',NULL); -- status→contatado_sem_resposta
  v_id1 := (r1->>'id')::uuid;
  r2 := public.registrar_contato_radar('11111111000111','virou_cliente',NULL);         -- status→virou_cliente (mais novo)
  u := public.desfazer_contato_radar(v_id1);  -- desfaz o VELHO
  IF NOT (u->>'deleted')::boolean THEN RAISE EXCEPTION 'A4 FALHOU: deveria apagar a linha velha'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='11111111000111') <> 'virou_cliente'
    THEN RAISE EXCEPTION 'A4 FALHOU: undo do velho pisou no status novo'; END IF;
  RAISE NOTICE 'A4 OK';
END $$;

-- A5: KPIs contam certo (novos lê o state; em_conversa/virou_cliente_mes contam a tabela)
DO $$
DECLARE k jsonb;
BEGIN
  k := public.radar_kpis();
  IF (k->>'lote') <> '2026-05' THEN RAISE EXCEPTION 'A5 FALHOU: lote'; END IF;
  IF (k->>'novos')::int <> 1000 THEN RAISE EXCEPTION 'A5 FALHOU: novos (esperado 1000 do state)'; END IF;
  IF (k->>'virou_cliente_mes')::int <> 1 THEN RAISE EXCEPTION 'A5 FALHOU: virou_cliente_mes (esperado 1)'; END IF;
  RAISE NOTICE 'A5 OK';
END $$;

-- A8: descarte_motivo NÃO fica stale — ao descartar grava o motivo, e ao mudar
--     pra outra ação (em_conversa) o motivo é LIMPO (não vaza pra status não-descartado).
DO $$
BEGIN
  PERFORM public.registrar_contato_radar('22222222000122','descartado','fora do ramo');
  IF (SELECT descarte_motivo FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'fora do ramo'
    THEN RAISE EXCEPTION 'A8 FALHOU: motivo não gravou no descarte'; END IF;
  PERFORM public.registrar_contato_radar('22222222000122','em_conversa',NULL);
  IF (SELECT descarte_motivo FROM public.radar_empresas WHERE cnpj='22222222000122') IS NOT NULL
    THEN RAISE EXCEPTION 'A8 FALHOU: motivo ficou stale ao sair de descartado'; END IF;
  RAISE NOTICE 'A8 OK';
END $$;

RESET ROLE; SET test.uid = '';

-- A6: gate — não-gestor não registra nem lê KPIs (SQLSTATE de RAISE = P0001)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000b2'; -- não está em test_gestores
DO $$
BEGIN
  PERFORM public.registrar_contato_radar('11111111000111','em_conversa',NULL);
  RAISE EXCEPTION 'A6 FALHOU: não-gestor registrou';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A6 FALHOU%' THEN RAISE; END IF;
  RAISE NOTICE 'A6 OK (registrar negado)';
END $$;
DO $$
BEGIN
  PERFORM public.radar_kpis();
  RAISE EXCEPTION 'A6 FALHOU: não-gestor leu KPIs';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A6 FALHOU%' THEN RAISE; END IF;
  RAISE NOTICE 'A6b OK (kpis negado)';
END $$;
RESET ROLE;

-- A7: EXECUTE revogado de anon
DO $$
BEGIN
  IF has_function_privilege('anon','public.registrar_contato_radar(text,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'A7 FALHOU: anon tem EXECUTE'; END IF;
  RAISE NOTICE 'A7 OK';
END $$;
SQL
echo "✅ test-radar-rpcs: todos os asserts passaram"
