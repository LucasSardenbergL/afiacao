#!/usr/bin/env bash
# Teste PG17 da migration 20261031191127 (detectar_skus_sem_grupo segue o cadastro ATUAL do SKU).
# Semeia os casos de prod (fornecedor trocado, SKU inativo, fornecedor desatualizado), roda o corpo
# ANTIGO do snapshot como CONTROLE (o bug tem de aparecer), aplica a migration e afirma cada caso.
# Base: db/test-alerta-pedido-minimo.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261031191127_detectar_skus_sem_grupo_fornecedor_atual.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441
DATA="$(mktemp -d /tmp/pgtest-semgrupo.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-semgrupo.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres semgrupo_verify
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d semgrupo_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-semgrupo.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ semeia os casos…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- ACL de PROD (psql-ro 2026-10-31: postgres/service_role/sandbox_exec). O snapshot não traz o REVOKE
-- da 20260818121919, e a PÓS da migration exige a função fechada.
REVOKE EXECUTE ON FUNCTION public.detectar_skus_sem_grupo(text) FROM PUBLIC, anon, authenticated;
INSERT INTO fornecedor_grupo_producao (id, empresa, fornecedor_nome, grupo_codigo, lt_producao_dias)
VALUES (1, 'OBEN', 'SAY', 'G1', 10);
-- sp: 1 ativo SAY · 2 trocou p/ DOV (sem grupo) · 3 inativo SAY · 4 SAY com grupo · 5 SAY com alerta
-- desatualizado · 6 inativo SAY sem alerta · 7 SAY ativo NULL sem alerta · (8 sem linha em sp)
INSERT INTO sku_parametros (empresa, sku_codigo_omie, fornecedor_nome, ativo) VALUES
  ('OBEN', 1, 'SAY', true), ('OBEN', 2, 'DOV', true), ('OBEN', 3, 'SAY', false),
  ('OBEN', 4, 'SAY', true), ('OBEN', 5, 'SAY', true), ('OBEN', 6, 'SAY', false), ('OBEN', 7, 'SAY', NULL);
INSERT INTO sku_grupo_producao (empresa, sku_codigo_omie, grupo_codigo) VALUES ('OBEN', '4', 'G1');
INSERT INTO eventos_outlier (id, empresa, sku_codigo_omie, tipo, severidade, data_evento, detalhes, status) VALUES
  (101, 'OBEN', '1', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente'),
  (102, 'OBEN', '2', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente'),
  (103, 'OBEN', '3', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente'),
  (104, 'OBEN', '4', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente'),
  (105, 'OBEN', '5', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"VELHO"}', 'pendente'),
  (108, 'OBEN', '8', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente'),
  (109, 'COLACOR', '2', 'sku_sem_grupo', 'atencao', CURRENT_DATE - 170, '{"fornecedor":"SAY"}', 'pendente');
SQL

echo "→ CONTROLE: corpo antigo (snapshot) deixa 102/103/108 pendurados e cria alerta p/ o inativo 6…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SELECT public.detectar_skus_sem_grupo('OBEN');
DO $$
BEGIN
  IF (SELECT count(*) FROM eventos_outlier WHERE id IN (102,103,108) AND status='pendente') IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o corpo antigo já fecharia os alertas — o teste não reproduz o bug';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eventos_outlier WHERE sku_codigo_omie='6' AND status='pendente') THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o corpo antigo não cria alerta p/ SKU inativo — o teste não reproduz o bug';
  END IF;
  RAISE NOTICE 'OK CONTROLE — o corpo antigo reproduz o bug';
END $$;
ROLLBACK;
SQL

echo "→ aplica a migration (como o db:aplicar: numa transação)…"
P -v ON_ERROR_STOP=1 -q --single-transaction -f "$MIG" >/dev/null

echo "→ asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r record; n int;
BEGIN
  SELECT status, detalhes->>'fornecedor' AS f INTO r FROM eventos_outlier WHERE id=101;
  IF r.status IS DISTINCT FROM 'pendente' OR r.f IS DISTINCT FROM 'SAY' THEN RAISE EXCEPTION 'A1 FALHOU: SKU ativo de fornecedor com grupo saiu da fila (%/%)', r.status, r.f; END IF;

  SELECT status, justificativa_decisao AS j INTO r FROM eventos_outlier WHERE id=102;
  IF r.status IS DISTINCT FROM 'excluido' OR COALESCE(r.j, '') NOT LIKE 'O fornecedor atual do SKU%' THEN RAISE EXCEPTION 'A2 FALHOU: fornecedor trocado p/ um sem grupo (%/%)', r.status, r.j; END IF;

  SELECT status, justificativa_decisao AS j INTO r FROM eventos_outlier WHERE id=103;
  IF r.status IS DISTINCT FROM 'excluido' OR COALESCE(r.j, '') NOT LIKE 'SKU inativo%' THEN RAISE EXCEPTION 'A3 FALHOU: SKU inativo (%/%)', r.status, r.j; END IF;

  SELECT status, justificativa_decisao AS j INTO r FROM eventos_outlier WHERE id=104;
  IF r.status IS DISTINCT FROM 'excluido' OR r.j IS DISTINCT FROM 'SKU já tem grupo ou é Produto Acabado (04) fabricado — não precisa de grupo.' THEN
    RAISE EXCEPTION 'A4 FALHOU: SKU com grupo (%/%)', r.status, r.j; END IF;

  SELECT status, detalhes->>'fornecedor' AS f INTO r FROM eventos_outlier WHERE id=105;
  IF r.status IS DISTINCT FROM 'pendente' OR r.f IS DISTINCT FROM 'SAY' THEN RAISE EXCEPTION 'A5 FALHOU: fornecedor desatualizado não foi reescrito (%/%)', r.status, r.f; END IF;

  IF EXISTS (SELECT 1 FROM eventos_outlier WHERE sku_codigo_omie='6') THEN RAISE EXCEPTION 'A6 FALHOU: criou alerta p/ SKU inativo'; END IF;

  SELECT count(*) INTO n FROM eventos_outlier WHERE sku_codigo_omie='7' AND empresa='OBEN' AND status='pendente' AND detalhes->>'fornecedor'='SAY';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'A7 FALHOU: SKU com ativo NULL deveria ganhar 1 alerta, tem %', n; END IF;

  IF (SELECT status FROM eventos_outlier WHERE id=108) IS DISTINCT FROM 'excluido' THEN RAISE EXCEPTION 'A8 FALHOU: SKU sem linha em sku_parametros ficou pendente'; END IF;

  IF (SELECT status FROM eventos_outlier WHERE id=109) IS DISTINCT FROM 'pendente' THEN RAISE EXCEPTION 'A9 FALHOU: mexeu em alerta de outra empresa'; END IF;

  -- A10: idempotência — 2ª rodada não cria nem fecha nada.
  SELECT count(*) INTO n FROM eventos_outlier WHERE status='pendente';
  IF public.detectar_skus_sem_grupo('OBEN') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'A10 FALHOU: 2ª rodada inseriu'; END IF;
  IF (SELECT count(*) FROM eventos_outlier WHERE status='pendente') IS DISTINCT FROM n THEN RAISE EXCEPTION 'A10 FALHOU: 2ª rodada mudou a fila'; END IF;
  RAISE NOTICE 'OK A1–A10';
END $$;
SQL

echo "→ re-aplica a migration (idempotência do arquivo: a PRE aceita o corpo novo)…"
P -v ON_ERROR_STOP=1 -q --single-transaction -f "$MIG" >/dev/null

echo "MARCADOR_FIM test-detectar-skus-sem-grupo-fornecedor-atual: OK"
