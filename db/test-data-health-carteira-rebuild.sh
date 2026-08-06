#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260729160000_data_health_carteira_rebuild.sql                 ║
# ║  bash db/test-data-health-carteira-rebuild.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                                ║
# ║  NÃO precisa de `heavy`: pico de RSS MEDIDO = 18 MB (vitest/tsc passam de      ║
# ║  1000 MB). Um PG17 descartável com tabelas vazias não é comando pesado —       ║
# ║  enfileirá-lo no semáforo custou ~30min de espera à toa numa sessão. Se        ║
# ║  rodar junto com outro harness, mude a porta: PGPORT_TEST=5478 bash ...        ║
# ║                                                                                ║
# ║  O QUE PROVA: o Sentinela passa a enxergar o FRESCOR DO REBUILD da carteira.  ║
# ║  O incidente de 2026-07-28 (carteira 24h congelada, Sentinela VERDE porque o  ║
# ║  único check da família media o SCORING) vira um assert executável: A6.       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="carteira-rebuild-health"
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 - esperado [$3], veio [$2]"; fi; }
# Usado na falsificação: exige que o valor NÃO seja o esperado-correto (o assert tem de virar vermelho).
ne()  { if [ "$2" != "$3" ]; then ok "$1 (virou [$2], deixou de ser [$3])"; else bad "$1 - SABOTAGEM NAO DETECTADA: seguiu [$3]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: snapshot real (traz as 15 tabelas dos checks vizinhos
#          E a _data_health_compute ANTIGA — assim o CREATE OR REPLACE da migration
#          roda sobre a versão existente, igual à produção).
# ══════════════════════════════════════════════════════════════════════════════
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
[ -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" ] && P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -q -f "$RR" >/dev/null 2>&1 || {
  echo "!! snapshot falhou por completo — abortando (sem schema não há prova)"; exit 1; }
rm -f "$RR"

# O snapshot cria as matviews WITH NO DATA; a _data_health_compute lê customer_metrics_mv e
# uma matview não-populada ERRA em vez de devolver 0 linhas. Popula todas (tabelas vazias => rápido).
P -q <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, matviewname FROM pg_matviews WHERE NOT ispopulated LOOP
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW %I.%I', r.schemaname, r.matviewname);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'matview % nao refreshou: %', r.matviewname, SQLERRM;
    END;
  END LOOP;
END $$;
SQL

BASE_CHECKS=$(Pq -c "SELECT count(*) FROM public._data_health_compute();" 2>/dev/null || echo "ERRO")
echo "snapshot aplicado; checks ANTES da migration: $BASE_CHECKS"
[ "$BASE_CHECKS" = "ERRO" ] && { echo "!! _data_health_compute não existe/não roda no snapshot"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260729160000_data_health_carteira_rebuild.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS. Cada cenário limpa e re-semeia carteira_assignments.
# ══════════════════════════════════════════════════════════════════════════════
# carteira_assignments tem FK (customer_user_id, owner_user_id) -> auth.users: semeia os
# dois usuários UMA vez e reusa, senão cada INSERT com uuid aleatório viola a FK.
CLIENTE='11111111-1111-1111-1111-111111111111'
VENDEDOR='22222222-2222-2222-2222-222222222222'
P -q -c "INSERT INTO auth.users(id) VALUES ('$CLIENTE'),('$VENDEDOR') ON CONFLICT DO NOTHING;"

semear_carteira() {  # $1 = expressão SQL do last_synced_at
  P -q -c "TRUNCATE public.carteira_assignments CASCADE;"
  P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, last_synced_at)
           VALUES ('$CLIENTE', '$VENDEDOR', 'omie', $1);"
}
status_carteira_rebuild() { Pq -c "SELECT status FROM public._data_health_compute() WHERE source='carteira_rebuild';"; }
status_carteira_scores()  { Pq -c "SELECT status FROM public._data_health_compute() WHERE source='carteira_scores';"; }

echo "-- asserts --"

# ── A1: rebuild recente => ok
semear_carteira "now()"
eq "A1 rebuild de agora => ok" "$(status_carteira_rebuild)" "ok"

# ── A2: rebuild de 31h atrás => stale (o cron é diário; 31h já passou da janela)
semear_carteira "now() - interval '31 hours'"
eq "A2 rebuild de 31h => stale" "$(status_carteira_rebuild)" "stale"

# ── A3: 29h ainda é ok — prova o CORTE exato em 30h (não um 'stale' preguiçoso)
semear_carteira "now() - interval '29 hours'"
eq "A3 rebuild de 29h => ok (corte em 30h)" "$(status_carteira_rebuild)" "ok"

# ── A4: tabela vazia => broken (max NULL), não 'ok' por omissão
P -q -c "TRUNCATE public.carteira_assignments CASCADE;"
eq "A4 carteira vazia => broken" "$(status_carteira_rebuild)" "broken"

# ── A5: não-regressão — a migration ACRESCENTA um check, não substitui nenhum
DEPOIS=$(Pq -c "SELECT count(*) FROM public._data_health_compute();")
eq "A5 nao-regressao: +1 check" "$DEPOIS" "$((BASE_CHECKS+1))"
AUSENTES=$(Pq -c "SELECT count(*) FROM (
  SELECT 'saldo_bancario' s UNION ALL SELECT 'contas_pagar' UNION ALL SELECT 'contas_receber'
  UNION ALL SELECT 'carteira_scores' UNION ALL SELECT 'custos_produtos' UNION ALL SELECT 'estoque_reposicao'
) t WHERE NOT EXISTS (SELECT 1 FROM public._data_health_compute() d WHERE d.source = t.s);")
eq "A5b checks vizinhos preservados" "$AUSENTES" "0"

# ── A6: O INCIDENTE DE 28/07, como assert executável.
#    Scoring FRESCO + rebuild VELHO: antes desta migration o Sentinela ficava todo verde.
#    Agora carteira_scores segue 'ok' (ele mede o scoring, e o scoring está mesmo fresco)
#    e carteira_rebuild acusa 'stale'. É a prova de que os dois writers têm frescor próprio.
semear_carteira "now() - interval '31 hours'"
P -q -c "TRUNCATE public.farmer_client_scores CASCADE;"
P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, calculated_at)
         VALUES (gen_random_uuid(), gen_random_uuid(), now());"
eq "A6a incidente: scoring fresco => carteira_scores ok" "$(status_carteira_scores)" "ok"
eq "A6b incidente: rebuild velho => carteira_rebuild stale" "$(status_carteira_rebuild)" "stale"

# ── A7: metadados do check (o consumidor lê estes campos)
META=$(Pq -c "SELECT domain||'|'||freshness_basis||'|'||expected_max_age_seconds||'|'||severity
              FROM public._data_health_compute() WHERE source='carteira_rebuild';")
eq "A7 metadados" "$META" "carteira|last_synced_at|108000|warning"

# ── A8: probable_cause aponta a armadilha real (job_run_details só prova o enqueue)
CAUSA=$(Pq -c "SELECT probable_cause LIKE '%ENQUEUE%' FROM public._data_health_compute() WHERE source='carteira_rebuild';")
eq "A8 causa provavel ensina onde olhar" "$CAUSA" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota => exige VERMELHO => restaura.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"

# F1: afrouxa o threshold só do MEU ramo (o padrão 'ca.last_synced_at' é exclusivo dele —
#     um sed global em "interval '30 hours'" atingiria custos_produtos por engano).
SAB1="$(mktemp /tmp/sab1.XXXXXX.sql)"
sed "s/max(ca\.last_synced_at) > interval '30 hours'/max(ca.last_synced_at) > interval '90 hours'/g" "$MIG" > "$SAB1"
grep -q "interval '90 hours'" "$SAB1" || { echo "!! F1 nao sabotou nada (padrao nao casou)"; exit 1; }
P -q -f "$SAB1"
semear_carteira "now() - interval '31 hours'"
ne "F1 threshold frouxo derruba A2" "$(status_carteira_rebuild)" "stale"
P -q -f "$MIG"   # restaura
semear_carteira "now() - interval '31 hours'"
eq "F1r restaurado: A2 volta a stale" "$(status_carteira_rebuild)" "stale"
rm -f "$SAB1"

# F2: remove o ramo inteiro (reintroduz o ponto cego). A5 e A6b têm de ficar vermelhos.
SAB2="$(mktemp /tmp/sab2.XXXXXX.sql)"
python3 - "$MIG" "$SAB2" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
txt = open(src, encoding="utf-8").read()
ini = txt.index("    UNION ALL\n    -- carteira_rebuild: FRESCOR")
fim = txt.index("    FROM public.carteira_assignments ca\n") + len("    FROM public.carteira_assignments ca\n")
open(dst, "w", encoding="utf-8").write(txt[:ini] + txt[fim:])
PY
grep -q "carteira_rebuild'::text" "$SAB2" && { echo "!! F2 nao removeu o ramo"; exit 1; }
P -q -f "$SAB2"
SEM=$(Pq -c "SELECT count(*) FROM public._data_health_compute();")
ne "F2 ramo removido derruba A5" "$SEM" "$((BASE_CHECKS+1))"
semear_carteira "now() - interval '31 hours'"
ne "F2b sem o ramo, o incidente volta a passar mudo" "$(status_carteira_rebuild)" "stale"
P -q -f "$MIG"   # restaura
eq "F2r restaurado: contagem volta" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "$((BASE_CHECKS+1))"
rm -f "$SAB2"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
