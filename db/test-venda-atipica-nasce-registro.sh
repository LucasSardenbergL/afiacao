#!/usr/bin/env bash
# Teste PG17 da migration 20261120180001 (venda atípica nasce status='registrado', não 'pendente').
# Semeia um SKU com pico de venda + estoque pendente de prod, roda o corpo ANTIGO do snapshot como
# CONTROLE (o pico tem de nascer 'pendente'), aplica a migration e afirma: nasce registrado, sem
# decisão fabricada, backfill só da venda_atipica pendente, aceito/lt_atipico/sku_sem_grupo/Omie
# intocados, dedup por NF segue valendo, re-aplicação idempotente.
# Base: db/test-detectar-skus-sem-grupo-fornecedor-atual.sh. Pré-req: brew install postgresql@17 pgvector.
# MIG_OVERRIDE=<arquivo> roda o teste contra uma cópia (falsificação).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO_ROOT/supabase/migrations/20261120180001_venda_atipica_nasce_registro.sql}"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PORT_OVERRIDE:-5447}"
DATA="$(mktemp -d /tmp/pgtest-vendareg.XXXXXX)/data"
export LC_ALL="${LC_ALL_OVERRIDE:-C}" LANG="${LC_ALL_OVERRIDE:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-vendareg-$PORT.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres vendareg_verify
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d vendareg_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-vendareg.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ semeia os casos…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- SKU 10 (OBEN): 39 vendas de 10-12 un + 1 pico de 100 un. Com o pico na própria amostra, z máximo
-- possível é (n-1)/sqrt(n): n=40 dá ~6, o bastante para 'critico' (z > 5).
INSERT INTO venda_items_history (empresa, data_emissao, sku_codigo_omie, quantidade, nfe_chave_acesso, sku_descricao)
SELECT 'OBEN', CURRENT_DATE - (g * 4), 10, 10 + (g % 3), 'NF-N' || g, 'SKU DEZ'
  FROM generate_series(1, 39) g;
INSERT INTO venda_items_history (empresa, data_emissao, sku_codigo_omie, quantidade, nfe_chave_acesso, sku_descricao)
VALUES ('OBEN', CURRENT_DATE - 1, 10, 100, 'NF-PICO', 'SKU DEZ');

-- Estoque de prod: venda pendente (vira registro), venda aceita por humano (intocada),
-- e os tipos que NÃO são desta migration (todos pendentes, todos intocados).
INSERT INTO eventos_outlier (id, empresa, sku_codigo_omie, tipo, severidade, data_evento, detalhes, status,
                             decidido_em, decidido_por, justificativa_decisao) VALUES
  (201, 'OBEN',    '20', 'venda_atipica',      'critico', CURRENT_DATE - 90, '{"nfe":"NF-A"}', 'pendente', NULL, NULL, NULL),
  (202, 'COLACOR', '21', 'venda_atipica',      'info',    CURRENT_DATE - 30, '{"nfe":"NF-B"}', 'pendente', NULL, NULL, NULL),
  (203, 'OBEN',    '22', 'venda_atipica',      'atencao', CURRENT_DATE - 60, '{"nfe":"NF-C"}', 'aceito',
        '2026-05-22 10:00+00', 'lucas@x', 'Vendas normais'),
  (204, 'OBEN',    '23', 'lt_atipico',         'critico', CURRENT_DATE - 10, '{"dedup_key":"K"}', 'pendente', NULL, NULL, NULL),
  (205, 'OBEN',    '24', 'sku_sem_grupo',      'atencao', CURRENT_DATE - 10, '{"fornecedor":"SAY"}', 'pendente', NULL, NULL, NULL),
  (206, 'OBEN',    '25', 'sku_inativado_omie', 'info',    CURRENT_DATE - 10, NULL, 'pendente', NULL, NULL, NULL),
  (207, 'OBEN',    '26', 'sku_reativado_omie', 'info',    CURRENT_DATE - 10, NULL, 'pendente', NULL, NULL, NULL);
SQL

echo "→ CONTROLE: corpo antigo (snapshot = prod) faz o pico nascer 'pendente'…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SELECT * FROM public.detectar_outliers_empresa('OBEN');
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.detectar_outliers_empresa(text)'::regprocedure)
       IS DISTINCT FROM '0e1a15546f5212bf873fdaaba7eaabb6' THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o corpo do snapshot não é o da prod (md5 do predecessor)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eventos_outlier WHERE tipo='venda_atipica' AND sku_codigo_omie='10'
                    AND detalhes->>'nfe'='NF-PICO' AND status='pendente') THEN
    RAISE EXCEPTION 'CONTROLE FALHOU: o corpo antigo não gera o pico pendente — o teste não reproduz o bug';
  END IF;
  RAISE NOTICE 'OK CONTROLE — o corpo antigo reproduz o pendente eterno';
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
  -- A1: backfill — as duas pendentes de venda (2 empresas) viraram registro, sem decisão.
  SELECT count(*) INTO n FROM eventos_outlier
   WHERE id IN (201, 202) AND status = 'registrado'
     AND decidido_em IS NULL AND decidido_por IS NULL AND justificativa_decisao IS NULL;
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'A1 FALHOU: backfill de venda pendente (% de 2)', n; END IF;

  -- A2: a aceita por humano segue aceita, com a decisão dela.
  SELECT status, decidido_por AS p INTO r FROM eventos_outlier WHERE id = 203;
  IF r.status IS DISTINCT FROM 'aceito' OR r.p IS DISTINCT FROM 'lucas@x' THEN
    RAISE EXCEPTION 'A2 FALHOU: decisão humana alterada (%/%)', r.status, r.p; END IF;

  -- A3: os outros tipos seguem pendentes.
  SELECT count(*) INTO n FROM eventos_outlier WHERE id BETWEEN 204 AND 207 AND status = 'pendente';
  IF n IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'A3 FALHOU: mexeu em tipo fora do escopo (% de 4 pendentes)', n; END IF;

  -- A4: detecção nova — o pico nasce registrado, sem decisão.
  PERFORM * FROM public.detectar_outliers_empresa('OBEN');
  SELECT status, decidido_em, decidido_por, severidade INTO r FROM eventos_outlier
   WHERE tipo = 'venda_atipica' AND sku_codigo_omie = '10' AND detalhes->>'nfe' = 'NF-PICO';
  IF r.status IS DISTINCT FROM 'registrado' THEN RAISE EXCEPTION 'A4 FALHOU: pico nasceu %', r.status; END IF;
  IF r.decidido_em IS NOT NULL OR r.decidido_por IS NOT NULL THEN RAISE EXCEPTION 'A4 FALHOU: nasceu com decisão'; END IF;
  IF r.severidade IS DISTINCT FROM 'critico' THEN RAISE EXCEPTION 'A4 FALHOU: severidade mudou (%)', r.severidade; END IF;

  -- A5: dedup por NF ignora status — 2ª detecção não duplica o registrado.
  SELECT count(*) INTO n FROM eventos_outlier WHERE tipo = 'venda_atipica';
  IF (SELECT novos_eventos FROM public.detectar_outliers_empresa('OBEN') WHERE tipo = 'venda_atipica') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'A5 FALHOU: 2ª detecção reinseriu venda'; END IF;
  IF (SELECT count(*) FROM eventos_outlier WHERE tipo = 'venda_atipica') IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'A5 FALHOU: contagem de venda mudou'; END IF;

  -- A6: nenhum venda_atipica pendente; nenhum registrado fora de venda_atipica.
  IF EXISTS (SELECT 1 FROM eventos_outlier WHERE tipo = 'venda_atipica' AND status = 'pendente') THEN
    RAISE EXCEPTION 'A6 FALHOU: sobrou venda pendente'; END IF;
  IF EXISTS (SELECT 1 FROM eventos_outlier WHERE status = 'registrado' AND tipo <> 'venda_atipica') THEN
    RAISE EXCEPTION 'A6 FALHOU: registrado vazou de tipo'; END IF;

  -- A7: resolver_outlier segue recusando o que não está pendente (nenhum humano "aceita" registro).
  -- Como staff (a RPC tem gate de perfil): sem isso a recusa seria a do gate, não a do status.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000aa');
  INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000aa', 'master');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', true);
  BEGIN
    PERFORM public.resolver_outlier(201, 'aceitar', 'x', 'y@x');
    RAISE EXCEPTION 'A7 FALHOU: resolver_outlier aceitou evento registrado';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%com status: registrado' THEN RAISE EXCEPTION 'A7 FALHOU: recusa por outro motivo: %', SQLERRM; END IF;
  END;
  RAISE NOTICE 'OK A1-A7';
END $$;
SQL

echo "→ re-aplica a migration (idempotência do arquivo: a PRE aceita o corpo novo)…"
P -v ON_ERROR_STOP=1 -q --single-transaction -f "$MIG" >/dev/null

echo "MARCADOR_FIM test-venda-atipica-nasce-registro: OK"
