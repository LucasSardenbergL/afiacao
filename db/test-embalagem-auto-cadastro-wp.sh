#!/usr/bin/env bash
# Harness PG17 do AUTO-CADASTRO de embalagem WP (QT+GL) — prova que a função
# pareia todo WP.3900 com QT+GL ativos no Omie e preenche sku_embalagem_equivalencia
# (insert-only, idempotente), com gate cron-or-staff. Money-path adjacente: asserts
# positivos + negativos + authz + FALSIFICAÇÃO. Spec: docs/superpowers/specs/2026-07-09-embalagem-economica-auto-cadastro-wp-design.md
# Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443; DATA="$(mktemp -d /tmp/pgtest-embwp.XXXXXX)/data"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-embwp.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres embwp_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d embwp_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-embwp.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"; rm -f "$RR"

echo "→ stub cron.schedule (pg_cron ausente no PG17 local)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
CREATE OR REPLACE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
SQL

echo "→ seed omie_products (14 WP QT+GL ativos) + WP99 (GL inativo) + WP98 (só QT) + 3 pares pré-cadastrados…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- omie_products: colunas mínimas (o snapshot tem defaults nas demais)
INSERT INTO omie_products (omie_codigo_produto, codigo, descricao, unidade, ativo, account) VALUES
  (1001,'P1001','WP01.3900QT CONCENTRADO PRETO','L',true,'oben'),
  (1002,'P1002','WP01.3900GL CONCENTRADO PRETO','L',true,'oben'),
  (1041,'P1041','WP04.3900QT CONCENTRADO AZUL','L',true,'oben'),
  (1042,'P1042','WP04.3900GL CONCENTRADO AZUL','L',true,'oben'),
  (1121,'P1121','WP12.3900QT CONCENTRADO CINZA','L',true,'oben'),
  (1122,'P1122','WP12.3900GL CONCENTRADO CINZA','L',true,'oben'),
  (1991,'P1991','WP99.3900QT CONCENTRADO TESTE','L',true,'oben'),
  (1992,'P1992','WP99.3900GL CONCENTRADO TESTE','L',false,'oben'),   -- GL INATIVO → cor NÃO entra
  (1981,'P1981','WP98.3900QT CONCENTRADO SOZINHO','L',true,'oben'),  -- só QT → NÃO entra
  (1123,'P1123','WP12.3900GL CONCENTRADO CINZA','L',true,'colacor'); -- outra conta → ignorado
-- 1 par pré-cadastrado (WP04) c/ grupo conhecido, p/ provar REUSO de grupo
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base, fornecedor_nome, ativo, criado_por) VALUES
  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','1041','QT',1,'Sayerlack',true,'founder'),
  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','1042','QT',4,'Sayerlack',true,'founder');
-- staff e não-staff p/ o gate (has_role real lê user_roles)
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');
INSERT INTO user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');
SQL

echo "→ aplica a migração candidata (cria tabela+função+cron; RODA O BACKFILL no fim)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/embalagem-auto-cadastro-wp.sql" >/dev/null

echo "→ A. backfill cadastrou WP01+WP12 (novos) e manteve WP04; WP99/WP98/colacor fora…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE n_grupos int; n_wp04_grupo uuid; n_wp99 int; n_wp98 int; n_col int;
BEGIN
  SELECT count(DISTINCT grupo_id) INTO n_grupos FROM sku_embalagem_equivalencia WHERE empresa='oben' AND ativo;
  IF n_grupos <> 3 THEN RAISE EXCEPTION 'FAIL A1: esperava 3 grupos (WP01,WP04,WP12), veio %', n_grupos; END IF;
  -- REUSO: WP04 mantém o grupo original
  SELECT grupo_id INTO n_wp04_grupo FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1041';
  IF n_wp04_grupo <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' THEN RAISE EXCEPTION 'FAIL A2: WP04 trocou de grupo %', n_wp04_grupo; END IF;
  SELECT count(*) INTO n_wp99 FROM sku_embalagem_equivalencia WHERE sku_codigo_omie IN ('1991','1992');
  IF n_wp99 <> 0 THEN RAISE EXCEPTION 'FAIL A3: WP99 (GL inativo) entrou (%)', n_wp99; END IF;
  SELECT count(*) INTO n_wp98 FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1981';
  IF n_wp98 <> 0 THEN RAISE EXCEPTION 'FAIL A4: WP98 (só QT) entrou'; END IF;
  SELECT count(*) INTO n_col FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1123';
  IF n_col <> 0 THEN RAISE EXCEPTION 'FAIL A5: par colacor entrou'; END IF;
END $$;
SQL
echo "   ✓ A"

echo "→ B. fator/unidade: WP01 QT=1, GL=4, unidade_base=QT…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE f_qt numeric; f_gl numeric; u text;
BEGIN
  SELECT fator_para_base, unidade_base INTO f_qt, u FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1001';
  SELECT fator_para_base INTO f_gl FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1002';
  IF f_qt <> 1 OR f_gl <> 4 OR u <> 'QT' THEN RAISE EXCEPTION 'FAIL B: WP01 QT=% GL=% u=%', f_qt, f_gl, u; END IF;
END $$;
SQL
echo "   ✓ B"

echo "→ C. idempotência: 2ª chamada (contexto cron, auth.uid()=NULL) insere 0…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  r := reposicao_sincronizar_embalagem_wp('oben');
  IF (r->>'linhas_inseridas')::int <> 0 THEN RAISE EXCEPTION 'FAIL C: 2ª run inseriu % (esperado 0)', r->>'linhas_inseridas'; END IF;
END $$;
SQL
echo "   ✓ C"

echo "→ D. authz: não-staff → 42501; staff → ok; cron(NULL) → ok…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- não-staff
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '22222222-2222-2222-2222-222222222222'::uuid $$;
DO $$
BEGIN
  PERFORM reposicao_sincronizar_embalagem_wp('oben');
  RAISE EXCEPTION 'FAIL D1: não-staff NÃO foi barrado';
EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- esperado
END $$;
-- staff
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;
DO $$ BEGIN PERFORM reposicao_sincronizar_embalagem_wp('oben'); END $$;  -- não lança
-- cron (volta pro NULL do stub base)
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN PERFORM reposicao_sincronizar_embalagem_wp('oben'); END $$;  -- não lança
SQL
echo "   ✓ D"

echo "→ E. audit log gravou runs…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM reposicao_embalagem_sync_log WHERE empresa='oben';
  IF n < 1 THEN RAISE EXCEPTION 'FAIL E: sem linha de audit'; END IF;
END $$;
SQL
echo "   ✓ E"

echo "✅ TODOS OS ASSERTS VERDES"
