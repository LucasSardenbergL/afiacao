#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260622130000_tint_promote_nome_cor_fallback.sql               ║
# ║  Invariante: a promoção NUNCA aborta um run por nome_cor vazio. Cor            ║
# ║  personalizada sem nome (conector não resolveu) entra com nome_cor=cor_id      ║
# ║  (stub). Falsificação: SEM o COALESCE, o INSERT viola NOT NULL (23502).        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5460}"
SLUG="tint-nome"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
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

echo "═══ setup PG17 :$PORT ═══"
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
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
for m in 20260609150000_tint_sync_promote 20260611190000_tint_sync_codex_fixes \
         20260615140000_tint_promote_indices_timeout 20260615160000_tint_promote_set_based; do
  P0 -q -f "$REPO_ROOT/supabase/migrations/${m}.sql" >>/tmp/mig-apply.log 2>&1 || true
done
echo "snapshot + cadeia aplicados"

# ── ZONA 2: a migration REAL sob teste ──
P -q -f "$REPO_ROOT/supabase/migrations/20260622130000_tint_promote_nome_cor_fallback.sql"
echo "migration aplicada: 20260622130000_tint_promote_nome_cor_fallback.sql"

# ── ZONA 3: seed — catálogo + 1 fórmula PERSONALIZADA com nome_cor NULL ──
P -q <<'SQL'
INSERT INTO tint_produtos (id, account, cod_produto, descricao) VALUES ('a0000000-0000-0000-0000-000000000001','colacor','P1','Produto 1');
INSERT INTO tint_bases (id, account, id_base_sayersystem, descricao) VALUES ('b0000000-0000-0000-0000-000000000001','colacor','B1','Base 1');
INSERT INTO tint_embalagens (id, account, id_embalagem_sayersystem, volume_ml) VALUES ('c0000000-0000-0000-0000-000000000001','colacor','E1',900);
INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml) VALUES ('d0000000-0000-0000-0000-000000000001','colacor','C1','Corante 1',1000);
INSERT INTO tint_skus (id, account, produto_id, base_id, embalagem_id) VALUES ('e0000000-0000-0000-0000-000000000001','colacor','a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001');
INSERT INTO tint_integration_settings (id, account, store_code) VALUES ('10000000-0000-0000-0000-000000000001','colacor','M01');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','P1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','B1','Base 1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, volume_ml) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','E1',900);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','C1','Corante 1',NULL,1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','P1','B1','E1');
-- a cor PERSONALIZADA: cor_id='PERS1', nome_cor NULL (conector não resolveu)
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','colacor','M01','PERS1',NULL,'P1','B1','E1',900,NULL,true);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C1',10,1);
SQL
echo "seed pronto (fórmula personalizada PERS1 com nome_cor NULL)"

# ── COM o fix: a promoção NÃO quebra; a cor entra com nome_cor = cor_id ──
RES=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-000000000001'))->>'ok';" 2>&1)
eq "promoção NÃO aborta com nome_cor NULL (ok=true)" "$RES" "true"
NOME=$(Pq -c "SELECT coalesce(nome_cor,'<NULL>') FROM tint_formulas WHERE account='colacor' AND cor_id='PERS1';" 2>&1)
eq "cor personalizada entrou com nome_cor = cor_id (stub)" "$NOME" "PERS1"

# ── FALSIFICAÇÃO: aplica a 130000 (E4, SEM o COALESCE de nome_cor) → INSERT viola NOT NULL (23502) ──
echo "── falsificação: aplica a versão SEM o fallback e re-roda (deve estourar 23502) ──"
P -q -f "$REPO_ROOT/supabase/migrations/20260618130000_tint_promote_e4_so_com_custo.sql" >/dev/null
# nova run com a mesma fórmula NULL (a anterior já promoveu; precisa de chave nova p/ forçar o INSERT)
P -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-0000000000ff','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-0000000000ff','20000000-0000-0000-0000-0000000000ff','colacor','M01','PERS2',NULL,'P1','B1','E1',900,NULL,true);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-0000000000ff','50000000-0000-0000-0000-0000000000ff','C1',10,1);
SQL
FALSO=$(P0 -tA -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-0000000000ff');" 2>&1 || true)
if echo "$FALSO" | grep -qiE "23502|null value in column .nome_cor."; then
  ok "falsificação tem dente: SEM o fallback, a promoção estoura 23502 (nome_cor NOT NULL)"
else
  bad "falsificação FRACA: esperava erro 23502, veio [$FALSO]"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
