#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260622210000_tint_promote_dedup_itens_corante.sql              ║
# ║  Invariante: a promoção DEDUPLICA itens por (formula_id, corante_id). Fórmula  ║
# ║  com o MESMO corante em 2 slots NÃO aborta o run; o item fica com a qtd de     ║
# ║  MAIOR ORDEM (idempotente com o oficial CSV-import; NÃO soma, NÃO maior-valor).║
# ║  Falsificação: SEM o DISTINCT ON, o INSERT viola o unique (23505) e derruba o  ║
# ║  run inteiro (= o re-loop que isto conserta).                                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="tint-dedup"
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

# ── ZONA 2: a migration REAL sob teste (CREATE OR REPLACE — corpo completo com o dedup) ──
P -q -f "$REPO_ROOT/supabase/migrations/20260622210000_tint_promote_dedup_itens_corante.sql"
echo "migration aplicada: 20260622210000_tint_promote_dedup_itens_corante.sql"

# ── ZONA 3: seed — catálogo + 1 fórmula PADRÃO com corante REPETIDO ──
# vol_formulacao = vol_embalagem = 900 → fator = 1 → qtd expandida = qtd da formulação (asserts diretos).
# C1 repetido DISTINTO: ordem 1 = 40.0, ordem 3 = 1.5  → maior-ordem(3)=1.5; soma=41.5; maior-valor=40.0
# C3 repetido IDÊNTICO: ordem 4 = 0.77, ordem 5 = 0.77 → dedup=0.77; soma=1.54 (duplicação ⇒ não somar)
# C2 normal: ordem 2 = 7.5 (controle: corante não-repetido fica intacto)
P -q <<'SQL'
INSERT INTO tint_produtos (id, account, cod_produto, descricao) VALUES ('a0000000-0000-0000-0000-000000000001','colacor','P1','Produto 1');
INSERT INTO tint_bases (id, account, id_base_sayersystem, descricao) VALUES ('b0000000-0000-0000-0000-000000000001','colacor','B1','Base 1');
INSERT INTO tint_embalagens (id, account, id_embalagem_sayersystem, volume_ml) VALUES ('c0000000-0000-0000-0000-000000000001','colacor','E1',900);
INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml) VALUES
 ('d0000000-0000-0000-0000-000000000001','colacor','C1','Corante 1',1000),
 ('d0000000-0000-0000-0000-000000000002','colacor','C2','Corante 2',1000),
 ('d0000000-0000-0000-0000-000000000003','colacor','C3','Corante 3',1000);
INSERT INTO tint_skus (id, account, produto_id, base_id, embalagem_id) VALUES ('e0000000-0000-0000-0000-000000000001','colacor','a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001');
INSERT INTO tint_integration_settings (id, account, store_code) VALUES ('10000000-0000-0000-0000-000000000001','colacor','M01');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','P1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','B1','Base 1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, volume_ml) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','E1',900);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','C1','Corante 1',NULL,1000),
 ('20000000-0000-0000-0000-000000000001','colacor','M01','C2','Corante 2',NULL,1000),
 ('20000000-0000-0000-0000-000000000001','colacor','M01','C3','Corante 3',NULL,1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES ('20000000-0000-0000-0000-000000000001','colacor','M01','P1','B1','E1');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','colacor','M01','344M - BS','Cor Teste','P1','B1','E1',900,NULL,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C1',40.0,1),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C2', 7.5,2),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C1', 1.5,3),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C3',0.77,4),
 ('20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','C3',0.77,5);
SQL
echo "seed pronto (fórmula PADRÃO 344M com C1 repetido distinto 40/1.5 + C3 idêntico 0.77/0.77)"

# ── ZONA 4: ASSERTS ──
echo "── asserts ──"
RES=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-000000000001'))->>'ok';")
eq "A1 promove SEM abortar (corante repetido)" "$RES" "true"

NC1=$(Pq -c "SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='344M - BS' AND co.id_corante_sayersystem='C1';")
eq "A2 dedup: 1 item por (formula, C1) — sem duplicate" "$NC1" "1"

A3=$(Pq -c "SELECT (fi.qtd_ml = 1.5) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='344M - BS' AND co.id_corante_sayersystem='C1';")
eq "A3 C1 = MAIOR ORDEM (1.5; NÃO soma 41.5, NÃO maior-valor 40)" "$A3" "t"

A4=$(Pq -c "SELECT fi.ordem FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='344M - BS' AND co.id_corante_sayersystem='C1';")
eq "A4 ordem armazenada = a do item escolhido (maior ordem = 3)" "$A4" "3"

A5=$(Pq -c "SELECT (fi.qtd_ml = 0.77) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='344M - BS' AND co.id_corante_sayersystem='C3';")
eq "A5 idênticos dedup p/ 0.77 (NÃO soma 1.54)" "$A5" "t"

A6=$(Pq -c "SELECT (fi.qtd_ml = 7.5) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='344M - BS' AND co.id_corante_sayersystem='C2';")
eq "A6 corante normal (C2) intacto = 7.5" "$A6" "t"

# Idempotência: re-rodar a promoção do MESMO run não muda nada (DELETE+INSERT dedup determinístico).
Pq -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-000000000001');" >/dev/null
A7=$(Pq -c "SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='colacor' AND f.cor_id='344M - BS';")
eq "A7 idempotente: 3 itens (C1,C2,C3) após re-promover" "$A7" "3"

# A8 — DEDUP DO _preco (Codex P1): com precos_base + custo, o preço usa MAX-ordem (não soma).
# C1=10/L, C2=20/L, C3=30/L; base custo=100 imp=0 marg=0; fator=1 (vol_form=vol_emb=900).
#   max-ordem: 100 + (10/1000*1.5) + (20/1000*7.5) + (30/1000*0.77) = 100.1881 -> 100.19
#   soma(bug): 100 + (10/1000*41.5) + 0.15 + (30/1000*1.54)         = 100.6112 -> 100.61
P -q <<'SQL'
UPDATE tint_staging_corantes SET custo=10, volume_ml=1000 WHERE sync_run_id='20000000-0000-0000-0000-000000000001' AND id_corante_sayersystem='C1';
UPDATE tint_staging_corantes SET custo=20, volume_ml=1000 WHERE sync_run_id='20000000-0000-0000-0000-000000000001' AND id_corante_sayersystem='C2';
UPDATE tint_staging_corantes SET custo=30, volume_ml=1000 WHERE sync_run_id='20000000-0000-0000-0000-000000000001' AND id_corante_sayersystem='C3';
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct) VALUES
 ('20000000-0000-0000-0000-000000000001','colacor','M01','P1','B1','E1',100,0,0);
SQL
Pq -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-000000000001');" >/dev/null
A8=$(Pq -c "SELECT preco_final_sayersystem FROM tint_formulas WHERE account='colacor' AND cor_id='344M - BS';")
eq "A8 preço usa itens MAX-ordem (100.19; NÃO a soma 100.61)" "$A8" "100.19"

# ── ZONA 5: FALSIFICAÇÃO (Lei #3) ──
echo "── falsificação ──"
# 1) SABOTA: aplica a versão ANTERIOR (20260622130000), que NÃO tem o DISTINCT ON no INSERT de itens.
P -q -f "$REPO_ROOT/supabase/migrations/20260622130000_tint_promote_nome_cor_fallback.sql"
# novo run com OUTRA fórmula de corante repetido (997M, C1 em ordem 2 e 5) no MESMO par P1/B1.
P -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
 ('20000000-0000-0000-0000-0000000000ff','10000000-0000-0000-0000-000000000001','colacor','M01','formulas','running');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, preco_final, personalizada) VALUES
 ('50000000-0000-0000-0000-0000000000ff','20000000-0000-0000-0000-0000000000ff','colacor','M01','997M - BS','Cor Teste 2','P1','B1','E1',900,NULL,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, qtd_ml, ordem) VALUES
 ('20000000-0000-0000-0000-0000000000ff','50000000-0000-0000-0000-0000000000ff','C1',0.385,2),
 ('20000000-0000-0000-0000-0000000000ff','50000000-0000-0000-0000-0000000000ff','C1',14.09,5);
SQL
# 2+3) re-roda e EXIGE o 23505 (duplicate key) — a SQLSTATE real do PG, não uma sentinela inventada.
FALSO=$(P0 -tA -c "SELECT tint_promote_sync_run('20000000-0000-0000-0000-0000000000ff');" 2>&1 || true)
if echo "$FALSO" | grep -qiE "23505|duplicate key value|tint_formula_itens_formula_id_corante_id_key"; then
  ok "F1 falsificação TEM DENTE: sem o dedup, o INSERT estoura 23505 (duplicate key) e derruba o run"
else
  bad "F1 falsificação FRACA: esperava 23505/duplicate key, veio [$FALSO]"
fi
# 4) RESTAURA a versão verdadeira (com dedup) e prova que o run que falhava AGORA promove.
P -q -f "$REPO_ROOT/supabase/migrations/20260622210000_tint_promote_dedup_itens_corante.sql"
RES2=$(Pq -c "SELECT (tint_promote_sync_run('20000000-0000-0000-0000-0000000000ff'))->>'ok';")
eq "F2 com o dedup restaurado, o run que falhava agora promove" "$RES2" "true"
A8=$(Pq -c "SELECT (fi.qtd_ml = 14.09) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes co ON co.id=fi.corante_id WHERE f.account='colacor' AND f.cor_id='997M - BS' AND co.id_corante_sayersystem='C1';")
eq "F3 997M C1 = maior ordem (14.09 = ordem 5; espelha o oficial de prod)" "$A8" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
