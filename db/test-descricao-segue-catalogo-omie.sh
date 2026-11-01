#!/usr/bin/env bash
# Teste PG17 da migration 20261101014150 (descrição do SKU segue o catálogo do Omie).
# Semeia nomes divergentes (cadastro de reposição, view de vendas e alertas), roda os corpos ANTIGOS do
# snapshot como CONTROLE (o bug tem de aparecer), aplica a migration e afirma cada caso.
# A view v_sku_parametros_sugeridos é trocada por uma tabela controlada (molde de db/seed-param-auto.sql).
# Base: db/test-detectar-skus-sem-grupo-fornecedor-atual.sh. Pré-req: brew install postgresql@17 pgvector.
# MIG_OVERRIDE=<arquivo> roda o teste contra outra versão da migration (falsificação).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO_ROOT/supabase/migrations/20261101014150_descricao_segue_catalogo_omie.sql}"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5442
DATA="$(mktemp -d /tmp/pgtest-descricao.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-descricao.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres descricao_verify
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d descricao_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-descricao.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ semeia os casos…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- View de sugestões controlada: a descrição dela é o max() alfabético das linhas de venda em prod.
DROP VIEW IF EXISTS public.v_sku_parametros_sugeridos CASCADE;
CREATE TABLE public._param_sug_test (
  empresa text NOT NULL, sku_codigo_omie bigint NOT NULL, sku_descricao text, fornecedor_nome text,
  estoque_minimo_sugerido numeric, ponto_pedido_sugerido numeric, estoque_maximo_sugerido numeric,
  estoque_seguranca_sugerido numeric, cobertura_alvo_dias integer, demanda_media_diaria numeric,
  demanda_sigma_diario numeric, coef_variacao_ordem numeric, num_ordens integer, valor_total_90d numeric,
  lead_time_medio numeric, lead_time_desvio numeric, lt_p95_dias numeric, fonte_leadtime text,
  z_aplicado numeric, classe_consolidada text, PRIMARY KEY (empresa, sku_codigo_omie));
CREATE VIEW public.v_sku_parametros_sugeridos AS SELECT * FROM public._param_sug_test;

-- catálogo: 1 e 2 ativos · 3 inativo no Omie · 2 também na COLACOR com outro nome
INSERT INTO omie_products (omie_codigo_produto, codigo, descricao, account, ativo) VALUES
  (1, 'C1', 'NOME OMIE 1', 'oben', true), (2, 'C2', 'NOME OMIE 2', 'oben', true),
  (3, 'C3', 'NOME OMIE 3', 'oben', false), (2, 'C2', 'NOME COLACOR 2', 'colacor', true);
-- cadastro: 1 já com o nome do Omie · 2 nome velho · 3 velho (Omie inativo: o cadastro não segue)
-- 5 sem nome e fora do catálogo · 6 com parâmetro a aplicar
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, ponto_pedido, estoque_minimo,
  estoque_maximo, estoque_seguranca, cobertura_alvo_dias, habilitado_reposicao_automatica, tipo_reposicao, ativo) VALUES
  ('OBEN', 1, 'NOME OMIE 1', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 2, 'NOME VELHO 2', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 3, 'VELHO 3', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 5, NULL, 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 6, 'SKU 6', 50, 20, 120, 15, 30, true, 'automatica', true);
INSERT INTO _param_sug_test (empresa, sku_codigo_omie, sku_descricao, estoque_minimo_sugerido, ponto_pedido_sugerido,
  estoque_maximo_sugerido, estoque_seguranca_sugerido, cobertura_alvo_dias) VALUES
  ('OBEN', 1, 'ZZ NOME DE VENDA 1', NULL, NULL, NULL, NULL, NULL),
  ('OBEN', 5, 'NOME DE VENDA 5', NULL, NULL, NULL, NULL, NULL),
  ('OBEN', 6, 'ZZ NOME DE VENDA 6', 20, 60, 140, 15, 30);
-- alertas: 201 pendente nome velho · 202 pendente de SKU inativo no Omie · 203 decidido · 204 fora do
-- catálogo · 205 de outra empresa
INSERT INTO eventos_outlier (id, empresa, sku_codigo_omie, sku_descricao, tipo, severidade, data_evento, status) VALUES
  (201, 'OBEN', '2', 'OLD 2', 'venda_atipica', 'atencao', DATE '2026-05-01', 'pendente'),
  (202, 'OBEN', '3', 'OLD 3', 'sku_inativado_omie', 'atencao', DATE '2026-05-01', 'pendente'),
  (203, 'OBEN', '2', 'OLD 2', 'venda_atipica', 'atencao', DATE '2026-05-01', 'excluido'),
  (204, 'OBEN', '99', 'X', 'venda_atipica', 'atencao', DATE '2026-05-01', 'pendente'),
  (205, 'COLACOR', '2', 'OLD C', 'venda_atipica', 'atencao', DATE '2026-05-01', 'pendente');
SQL

echo "→ CONTROLE: corpos antigos (snapshot) — o job troca o nome pelo de venda e o refresh ignora alertas…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SELECT public.atualizar_parametros_numericos_skus('OBEN', NULL) \g /dev/null
SELECT public.atualizar_descricao_sku_parametros('OBEN') \g /dev/null
DO $$
BEGIN
  IF (SELECT sku_descricao FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=6) IS DISTINCT FROM 'ZZ NOME DE VENDA 6' THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o job antigo não troca o nome pelo da view — o teste não reproduz o bug';
  END IF;
  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=201) IS DISTINCT FROM 'OLD 2' THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o refresh antigo já atualiza alertas — o teste não reproduz o bug';
  END IF;
  RAISE NOTICE 'OK CONTROLE — os corpos antigos reproduzem o bug';
END $$;
ROLLBACK;
SQL

echo "→ aplica a migration (como o db:aplicar: numa transação)…"
P -v ON_ERROR_STOP=1 -q --single-transaction -f "$MIG" >/dev/null

echo "→ asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT public.atualizar_parametros_numericos_skus('OBEN', NULL) \g /dev/null
DO $$
DECLARE r record;
BEGIN
  SELECT sku_descricao AS d INTO r FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=2;
  IF r.d IS DISTINCT FROM 'NOME OMIE 2' THEN RAISE EXCEPTION 'B1 FALHOU: o refresh da migration não pôs o nome do Omie no cadastro (%)', r.d; END IF;

  SELECT sku_descricao AS d INTO r FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=1;
  IF r.d IS DISTINCT FROM 'NOME OMIE 1' THEN RAISE EXCEPTION 'B2 FALHOU: o job de parâmetros trocou o nome do Omie pelo de venda (%)', r.d; END IF;

  SELECT sku_descricao AS d INTO r FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=5;
  IF r.d IS DISTINCT FROM 'NOME DE VENDA 5' THEN RAISE EXCEPTION 'B3 FALHOU: o job não preencheu o nome vazio (%)', r.d; END IF;

  SELECT sku_descricao AS d, ponto_pedido AS pp, estoque_maximo AS mx INTO r FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=6;
  IF r.d IS DISTINCT FROM 'SKU 6' OR r.pp IS DISTINCT FROM 60::numeric OR r.mx IS DISTINCT FROM 140::numeric THEN
    RAISE EXCEPTION 'B4 FALHOU: parâmetro não aplicou ou nome mudou (%/%/%)', r.d, r.pp, r.mx; END IF;

  SELECT sku_descricao AS d INTO r FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=3;
  IF r.d IS DISTINCT FROM 'VELHO 3' THEN RAISE EXCEPTION 'B5 FALHOU: cadastro seguiu catálogo de produto inativo no Omie (%)', r.d; END IF;

  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=201) IS DISTINCT FROM 'NOME OMIE 2' THEN RAISE EXCEPTION 'B6 FALHOU: alerta pendente não seguiu o catálogo'; END IF;
  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=202) IS DISTINCT FROM 'NOME OMIE 3' THEN RAISE EXCEPTION 'B7 FALHOU: alerta de SKU inativo no Omie não seguiu o catálogo'; END IF;
  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=203) IS DISTINCT FROM 'OLD 2' THEN RAISE EXCEPTION 'B8 FALHOU: mexeu em alerta já decidido'; END IF;
  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=204) IS DISTINCT FROM 'X' THEN RAISE EXCEPTION 'B9 FALHOU: mexeu em alerta fora do catálogo'; END IF;
  IF (SELECT sku_descricao FROM eventos_outlier WHERE id=205) IS DISTINCT FROM 'OLD C' THEN RAISE EXCEPTION 'B10 FALHOU: mexeu em alerta de outra empresa'; END IF;

  -- B11: retorno continua sendo a contagem do cadastro, e a 2ª rodada é no-op.
  UPDATE sku_parametros SET sku_descricao='NOME VELHO 2' WHERE empresa='OBEN' AND sku_codigo_omie=2;
  IF public.atualizar_descricao_sku_parametros('OBEN') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'B11 FALHOU: retorno não conta o cadastro'; END IF;
  IF public.atualizar_descricao_sku_parametros('OBEN') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'B11 FALHOU: 2ª rodada não é no-op'; END IF;
  RAISE NOTICE 'OK B1–B11';
END $$;
SQL

echo "→ re-aplica a migration (idempotência do arquivo: a PRE aceita o corpo novo)…"
P -v ON_ERROR_STOP=1 -q --single-transaction -f "$MIG" >/dev/null

echo "MARCADOR_FIM test-descricao-segue-catalogo-omie: OK"
