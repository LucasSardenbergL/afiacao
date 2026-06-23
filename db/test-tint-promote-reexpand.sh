#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260617150000_tint_promote_reexpand_skus_novos.sql             ║
# ║  Invariante: a re-expansão de fórmulas dispara só p/ pares de skus NOVOS       ║
# ║  (não p/ todo sku tocado). Re-envio de sku existente → carga ZERO (mata o      ║
# ║  lock timeout do incidente 17/06). Sku NOVO ainda re-expande (§11 P1-C).       ║
# ║  Regressão: o COALESCE de preço da 130000 segue preservando o piso.            ║
# ║  Falsificação: aplica a 130000 (usa _tp_sku, SEM o fix) → re-envio re-expande. ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5458}"
SLUG="tint-reexpand"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
P0() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
gt0() { if [ "${2:-0}" -gt 0 ] 2>/dev/null; then ok "$1 (=$2)"; else bad "$1 — esperado >0, veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1: snapshot + stale fixes + cadeia de helpers/promoção ──
RR="$(mktemp "${TMPDIR:-/tmp}/snap-rr.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" 2>/dev/null || true
P0 -q -f "$RR" >/tmp/snap-apply.log 2>&1 || true
rm -f "$RR"
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.tint_staging_precos_base (
  id uuid NOT NULL DEFAULT gen_random_uuid(), sync_run_id uuid, account text NOT NULL, store_code text NOT NULL,
  cod_produto text NOT NULL, id_base text NOT NULL, id_embalagem text NOT NULL,
  custo numeric, imposto_pct numeric, margem_pct numeric, raw_data jsonb, staging_status text,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tint_formulas ADD COLUMN IF NOT EXISTS desativada_em timestamptz;
SQL
for t in tint_produtos tint_bases tint_embalagens tint_corantes tint_skus tint_formulas tint_formula_itens \
         tint_sync_runs tint_integration_settings tint_importacoes tint_staging_formulas tint_staging_formula_itens \
         tint_staging_precos_base tint_staging_skus tint_staging_produtos tint_staging_bases tint_staging_embalagens tint_staging_corantes; do
  EX=$(Pq -c "SELECT to_regclass('public.$t') IS NOT NULL;")
  [ "$EX" = "t" ] || { echo "❌ SETUP: tabela $t não criada (ver /tmp/snap-apply.log)"; exit 1; }
done
for m in 20260609150000_tint_sync_promote 20260611190000_tint_sync_codex_fixes \
         20260615140000_tint_promote_indices_timeout 20260615160000_tint_promote_set_based; do
  P0 -q -f "$REPO_ROOT/supabase/migrations/${m}.sql" >>/tmp/mig-apply.log 2>&1 || true
done
echo "snapshot + cadeia de migrations aplicados"

# ── ZONA 2: a migration REAL sob teste ──
P -q -f "$REPO_ROOT/supabase/migrations/20260617150000_tint_promote_reexpand_skus_novos.sql"
echo "migration aplicada: 20260617150000_tint_promote_reexpand_skus_novos.sql"

# ── ZONA 3: seed ──
# Oficial: COR1/P1/B1/E1 (preço 100). Par (P1,B1) com sku E1. run1 promove COR1/CORNOVA/COR3.
# run2 = re-envio do sku EXISTENTE (P1,B1,E1) — não deve re-expandir.
# run3 = sku NOVO (P1,B1,E2, embalagem E2 nova) — deve re-expandir o par (P1-C).
P -q <<'SQL'
INSERT INTO tint_produtos (id, account, cod_produto, descricao) VALUES
 ('a0000000-0000-0000-0000-000000000001','colacor','P1','Produto 1'),
 ('a0000000-0000-0000-0000-000000000002','colacor','P2','Produto 2');
INSERT INTO tint_bases (id, account, id_base_sayersystem, descricao) VALUES
 ('b0000000-0000-0000-0000-000000000001','colacor','B1','Base 1'),
 ('b0000000-0000-0000-0000-000000000002','colacor','B2','Base 2');
INSERT INTO tint_embalagens (id, account, id_embalagem_sayersystem, volume_ml) VALUES
 ('c0000000-0000-0000-0000-000000000001','colacor','E1',900);
INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml) VALUES
 ('d0000000-0000-0000-0000-000000000001','colacor','C1','Corante 1',1000);
INSERT INTO tint_skus (id, account, produto_id, base_id, embalagem_id) VALUES
 ('e0000000-0000-0000-0000-000000000001','colacor','a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001'),
 ('e0000000-0000-0000-0000-000000000002','colacor','a0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000001');
INSERT INTO tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, sku_id, volume_final_ml, preco_final_sayersystem) VALUES
 ('f0000000-0000-0000-0000-000000000001','colacor','COR1','Cor 1',
  'a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001',900,100.00);

INSERT INTO tint_integration_settings (id, account, store_code) VALUES
 ('10000000-0000-0000-0000-000000000001','colacor','M01');

-- RUN 1 (catalogs+formulas): promove COR1/CORNOVA/COR3
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P1'),('20000000-0000-0000-0000-000000000001','colacor','M01','P2');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','B1','Base 1'),('20000000-0000-0000-0000-000000000001','colacor','M01','B2','Base 2');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','E1',900);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','C1','Corante 1',2.0,1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P1','B1','E1'),('20000000-0000-0000-0000-000000000001','colacor','M01','P2','B2','E1');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','colacor','M01','COR1','Cor 1','P1','B1','E1',900,NULL,false),
 ('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','colacor','M01','CORNOVA','Cor Nova','P1','B1','E1',900,NULL,false),
 ('50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','colacor','M01','COR3','Cor 3','P2','B2','E1',900,NULL,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C1',10,1),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','C1',10,1),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','C1',10,1);
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P2','B2','E1',50.0,0,0);

-- RUN 2 (catalogs): re-envio do sku EXISTENTE (P1,B1,E1), SEM fórmulas
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','colacor','M01','catalogs','running');
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES
 ('20000000-0000-0000-0000-000000000002','colacor','M01','P1','B1','E1');

-- RUN 3 (catalogs): sku NOVO (P1,B1,E2) + embalagem E2 nova, SEM fórmulas
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','colacor','M01','catalogs','running');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000003','colacor','M01','E2',405);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES
 ('20000000-0000-0000-0000-000000000003','colacor','M01','P1','B1','E2');
SQL
echo "seed pronto"

# ── RUN 1: promove ──
R1RES=$(Pq -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-000000000001');")
echo "run1 (promove): $R1RES"

echo "── asserts ──"
# Regressão do PREÇO (a 150000 inclui o COALESCE da 130000)
PRECO=$(Pq -c "SELECT coalesce(preco_final_sayersystem::text,'NULL') FROM tint_formulas WHERE account='colacor' AND cor_id='COR1' AND embalagem_id='c0000000-0000-0000-0000-000000000001';")
eq "regressão: preço de COR1 preservado (COALESCE)" "$PRECO" "100.00"
CAT=$(Pq -c "SELECT count(*) FROM tint_formulas WHERE account='colacor' AND cor_id IN ('CORNOVA','COR3');")
eq "regressão: catálogo promovido (cores novas)" "$CAT" "2"

# R1 — re-envio de sku EXISTENTE não re-expande (a CORREÇÃO da carga)
R2RES=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-000000000002'))->>'promovidas';")
eq "R1 re-envio de sku EXISTENTE → carga ZERO (não re-expande)" "$R2RES" "0"

# R2 — sku NOVO re-expande o par (P1-C preservado)
R3RES=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-000000000003'))->>'promovidas';")
gt0 "R2 sku NOVO (embalagem E2) re-expande o par" "$R3RES"
COR1EMB=$(Pq -c "SELECT count(DISTINCT embalagem_id) FROM tint_formulas WHERE account='colacor' AND cor_id='COR1';")
eq "R2b COR1 ganhou a embalagem nova (E1→E1+E2)" "$COR1EMB" "2"

# ── FALSIFICAÇÃO: aplica a 130000 (usa _tp_sku, SEM o fix de carga) → re-envio re-expande ──
echo "── falsificação: aplica a versão SEM o fix (_tp_sku) e re-roda o run de re-envio ──"
P -q -f "$REPO_ROOT/supabase/migrations/20260617130000_tint_promote_preserva_preco.sql" >/dev/null
FALSO=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-000000000002'))->>'promovidas';")
# SEM o fix, o sku existente entra em _pares (via _tp_sku) → re-expande o par (P1,B1) → promovidas>0
if [ "${FALSO:-0}" -gt 0 ] 2>/dev/null; then
  ok "falsificação tem dente: SEM o fix, re-envio de sku existente re-expande (promovidas=$FALSO)"
else
  bad "falsificação FRACA: sem o fix o re-envio deveria re-expandir, veio promovidas=[$FALSO]"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
