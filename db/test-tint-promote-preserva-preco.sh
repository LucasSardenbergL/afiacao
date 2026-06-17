#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260617130000_tint_promote_preserva_preco.sql                  ║
# ║  Invariante: a promoção PRESERVA preco_final_sayersystem quando o recálculo    ║
# ║  dá NULL (precos_base vazio) — COALESCE(novo, atual). Sem isto o flip zeraria  ║
# ║  o piso de ~19k cores. Lei de Ferro: função REAL + assert com dente +          ║
# ║  FALSIFICAÇÃO (aplica a set_based SEM COALESCE → exige vermelho).              ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="tint-preco"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
P0() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "$@"; }   # tolera erro (snapshot não-tint)
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

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1: snapshot (tabelas tint; tolera erro em objetos não-tint) + helpers de prod ──
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" 2>/dev/null || true
P0 -q -f "$RR" >/tmp/snap-apply.log 2>&1 || true
rm -f "$RR"
# snapshot STALE (§database.md): cria o que falta — tint_staging_precos_base (tabela inteira) e
# desativada_em em tint_formulas (coluna). Schema reconstruído de prod via information_schema.
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.tint_staging_precos_base (
  id uuid NOT NULL DEFAULT gen_random_uuid(), sync_run_id uuid, account text NOT NULL, store_code text NOT NULL,
  cod_produto text NOT NULL, id_base text NOT NULL, id_embalagem text NOT NULL,
  custo numeric, imposto_pct numeric, margem_pct numeric, raw_data jsonb, staging_status text,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tint_formulas ADD COLUMN IF NOT EXISTS desativada_em timestamptz;
SQL
# setup-gate: as tabelas tint que a promoção toca PRECISAM existir
for t in tint_produtos tint_bases tint_embalagens tint_corantes tint_skus tint_formulas tint_formula_itens \
         tint_sync_runs tint_integration_settings tint_importacoes tint_staging_formulas tint_staging_formula_itens \
         tint_staging_precos_base tint_staging_skus tint_staging_produtos tint_staging_bases tint_staging_embalagens tint_staging_corantes; do
  EX=$(Pq -c "SELECT to_regclass('public.$t') IS NOT NULL;")
  [ "$EX" = "t" ] || { echo "❌ SETUP: tabela $t não criada pelo snapshot (ver /tmp/snap-apply.log)"; exit 1; }
done
echo "snapshot aplicado; tabelas tint OK"
# Cadeia de migrations da promoção (P0 tolera colisão de objetos já no snapshot). As 4 primeiras
# criam os helpers (tint_calc_preco_final / tint_recalc_preco_oficial / tint_ensure_corante_stub)
# + a promoção v1→v2 (set_based). A minha (v3) é a sob teste (ZONA 2, ON_ERROR_STOP).
for m in 20260609150000_tint_sync_promote 20260611190000_tint_sync_codex_fixes \
         20260615140000_tint_promote_indices_timeout 20260615160000_tint_promote_set_based; do
  P0 -q -f "$REPO_ROOT/supabase/migrations/${m}.sql" >>/tmp/mig-apply.log 2>&1 || true
done
for fn in tint_calc_preco_final tint_recalc_preco_oficial tint_ensure_corante_stub; do
  EX=$(Pq -c "SELECT count(*)>0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn';")
  [ "$EX" = "t" ] || { echo "❌ SETUP: helper $fn não criado (ver /tmp/mig-apply.log)"; exit 1; }
done
echo "helpers + promoção (cadeia de migrations) aplicados"

# ── ZONA 2: a migration REAL sob teste (ON_ERROR_STOP — tem que aplicar limpo) ──
P -q -f "$REPO_ROOT/supabase/migrations/20260617130000_tint_promote_preserva_preco.sql"
echo "migration aplicada: 20260617130000_tint_promote_preserva_preco.sql"

# ── ZONA 3: seed ──
# OFICIAL pré-existente: COR1/P1/B1/E1 com preço 100 (para provar a PRESERVAÇÃO).
# Catálogo p/ 2 pares vendáveis: (P1,B1,E1) e (P2,B2,E1). Corante C1 com custo (p/ recálculo).
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
-- fórmula oficial JÁ EXISTENTE (preço 100) — o piso a preservar
INSERT INTO tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, sku_id, volume_final_ml, preco_final_sayersystem) VALUES
 ('f0000000-0000-0000-0000-000000000001','colacor','COR1','Cor 1',
  'a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001',900,100.00);

-- run + settings
INSERT INTO tint_integration_settings (id, account, store_code) VALUES
 ('10000000-0000-0000-0000-000000000001','colacor','M01');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');

-- staging catálogo (re-envio)
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P1'),
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P2');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','B1','Base 1'),
 ('20000000-0000-0000-0000-000000000001','colacor','M01','B2','Base 2');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','E1',900);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','C1','Corante 1',2.0,1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P1','B1','E1'),
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P2','B2','E1');
-- 3 fórmulas: COR1 (existe→preserva) · CORNOVA (nova,sem base→NULL) · COR3 (nova,COM base→positivo)
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','colacor','M01','COR1','Cor 1','P1','B1','E1',900,NULL,false),
 ('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','colacor','M01','CORNOVA','Cor Nova','P1','B1','E1',900,NULL,false),
 ('50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','colacor','M01','COR3','Cor 3','P2','B2','E1',900,NULL,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C1',10,1),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','C1',10,1),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','C1',10,1);
-- precos_base SÓ para (P2,B2,E1) → COR3 recalcula positivo; P1/B1 fica sem base (NULL).
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P2','B2','E1',50.0,0,0);
SQL
echo "seed pronto"

# ── rodar a promoção REAL ──
RES=$(Pq -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-000000000001');")
echo "promoção retornou: $RES"

# ── ZONA 4: asserts ──
echo "── asserts ──"
P1=$(Pq -c "SELECT coalesce(preco_final_sayersystem::text,'NULL') FROM tint_formulas WHERE account='colacor' AND cor_id='COR1' AND embalagem_id='c0000000-0000-0000-0000-000000000001';")
eq "P1 preço preservado (precos_base vazio NÃO zera o piso)" "$P1" "100.00"
P2=$(Pq -c "SELECT coalesce(preco_final_sayersystem::text,'NULL') FROM tint_formulas WHERE account='colacor' AND cor_id='CORNOVA';")
eq "P2 cor nova sem base → NULL honesto (não fabrica)" "$P2" "NULL"
P3=$(Pq -c "SELECT preco_final_sayersystem::text FROM tint_formulas WHERE account='colacor' AND cor_id='COR3';")
eq "P3 recálculo legítimo com precos_base (50 + 0.02 corante)" "$P3" "50.02"
P4=$(Pq -c "SELECT count(*) FROM tint_formulas WHERE account='colacor' AND cor_id IN ('CORNOVA','COR3');")
eq "P4 catálogo promovido (cores novas inseridas)" "$P4" "2"
P4b=$(Pq -c "SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.cor_id='COR3';")
eq "P4b itens expandidos da cor nova" "$P4b" "1"

# ── ZONA 5: FALSIFICAÇÃO (aplica a set_based SEM COALESCE → P1 deve QUEBRAR) ──
echo "── falsificação: aplica a versão furada (set_based, SEM COALESCE) e re-roda ──"
P -q -f "$REPO_ROOT/supabase/migrations/20260615160000_tint_promote_set_based.sql" >/dev/null
Pq -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-000000000001');" >/dev/null
FALSO=$(Pq -c "SELECT coalesce(preco_final_sayersystem::text,'NULO_ZERADO') FROM tint_formulas WHERE account='colacor' AND cor_id='COR1' AND embalagem_id='c0000000-0000-0000-0000-000000000001';")
# sentinela anti-teatro: 'NULO_ZERADO' é texto MEU, não emitido pelo código; só aparece se o preço virou NULL
if [ "$FALSO" = "NULO_ZERADO" ]; then
  ok "falsificação tem dente: SEM o COALESCE o preço de COR1 ZEROU (era 100 → NULL)"
else
  bad "falsificação FRACA: sem o COALESCE o preço deveria zerar, mas veio [$FALSO] — o assert P1 não prova nada"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
