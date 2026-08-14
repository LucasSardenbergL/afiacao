#!/usr/bin/env bash
# ============================================================================================
# Prova a migration 20260814160441_fu4f_fase3_afinidade_colunas_reaplica.sql num PG17 LOCAL.
#
# Por que existe: a 20260725121000 abortou em prod (23502) porque o autoteste A7 fazia INSERT
# sem as colunas NOT NULL. Este harness prova que a reaplicação (a) roda até o fim, (b) tem
# asserts com DENTE — cada sabotagem deixa a migration VERMELHA.
#
# Uso:  PGPORT_TEST=5881 bash db/test-fu4f-fase3-afinidade-reaplica.sh
# ============================================================================================
set -uo pipefail

# macOS: sem locale fixo o postmaster morre em "became multithreaded during startup".
export LC_ALL=C LANG=C

PORT="${PGPORT_TEST:-5881}"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
[ -x "$PGBIN/initdb" ] || PGBIN="/usr/local/opt/postgresql@17/bin"
[ -x "$PGBIN/initdb" ] || { echo "PG17 não encontrado"; exit 1; }

TMP="$(mktemp -d)"
DATA="$TMP/data"
MIG="supabase/migrations/20260814160441_fu4f_fase3_afinidade_colunas_reaplica.sql"

# shellcheck disable=SC2329  # invocada pelo `trap ... EXIT` abaixo (indireta, o shellcheck não vê)
limpar() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"; }
trap limpar EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --no-sync >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null 2>&1 \
  || { echo "falha ao subir PG17 na porta $PORT"; cat "$TMP/log"; exit 1; }

psql() { "$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

ok=0; fail=0
afirma() { # afirma <rotulo> <esperado: OK|FALHA> <arquivo_sql>
  local rotulo="$1" esperado="$2" arq="$3" saida rc
  saida="$(psql -q -f "$arq" 2>&1)"; rc=$?
  if [ "$esperado" = "OK" ] && [ $rc -eq 0 ]; then
    echo "  OK   [$rotulo] aplicou"; ok=$((ok+1))
  elif [ "$esperado" = "FALHA" ] && [ $rc -ne 0 ]; then
    echo "  OK   [$rotulo] MORDEU (a migration ficou vermelha)"; ok=$((ok+1))
  else
    echo "  FAIL [$rotulo] esperava $esperado, rc=$rc"
    echo "$saida" | tail -3 | sed 's/^/       /'
    fail=$((fail+1))
  fi
}

# ── schema mínimo, fiel ao medido em prod por psql-ro ───────────────────────────────────────
cat > "$TMP/schema.sql" <<'SQL'
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

-- 0 FKs, NOT NULL: farmer_id, customer_user_id (+ bundle_products/bundle_type COM default)
CREATE TABLE public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_products jsonb NOT NULL DEFAULT '[]'::jsonb,
  bundle_type text NOT NULL DEFAULT 'association',
  lie_bundle numeric
);

-- 2 FKs para omie_products, NOT NULL: farmer_id, customer_user_id, recommendation_type
CREATE TABLE public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  recommendation_type text NOT NULL
    CHECK (recommendation_type = ANY (ARRAY['cross_sell'::text,'up_sell'::text])),
  product_id uuid REFERENCES public.omie_products(id),
  current_product_id uuid REFERENCES public.omie_products(id),
  lie numeric
);
SQL

echo "── baseline: a migration corrigida aplica ──"
psql -q -f "$TMP/schema.sql" >/dev/null 2>&1 || { echo "schema falhou"; exit 1; }
afirma "B1 migration corrigida" OK "$MIG"

echo "── idempotência: rodar de novo não quebra ──"
afirma "B2 re-apply" OK "$MIG"

echo "── as colunas existem, numeric, SEM default ──"
n="$(psql -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('affinity_score','affinity_bundle') AND data_type='numeric' AND column_default IS NULL")"
if [ "$n" = "2" ]; then echo "  OK   [B3 2 colunas numeric sem default] (=2)"; ok=$((ok+1)); else echo "  FAIL [B3] veio $n"; fail=$((fail+1)); fi

echo "── NaN e Infinity são REALMENTE recusados (o que o CHECK promete) ──"
for v in NaN Infinity; do
  if psql -q -c "INSERT INTO public.farmer_bundle_recommendations (farmer_id,customer_user_id,affinity_bundle) VALUES (gen_random_uuid(),gen_random_uuid(),'$v'::numeric)" >/dev/null 2>&1; then
    echo "  FAIL [B4-$v aceito pelo CHECK]"; fail=$((fail+1))
  else
    echo "  OK   [B4-$v recusado]"; ok=$((ok+1))
  fi
done

echo "── REGRESSÃO: o bug original (INSERT sem as NOT NULL) dá 23502, não 23514 ──"
err="$(psql -q -c "INSERT INTO public.farmer_bundle_recommendations (bundle_products,affinity_bundle) VALUES ('[]'::jsonb,'NaN'::numeric)" 2>&1 | command grep -oE '23502|null value in column' | head -1)"
if [ -n "$err" ]; then
  echo "  OK   [B5 forma antiga do A7 morre em not_null_violation] (a causa do abort em prod)"; ok=$((ok+1))
else
  echo "  FAIL [B5] a forma antiga NÃO deu 23502 — o diagnóstico do abort estaria errado"; fail=$((fail+1))
fi

# ── FALSIFICAÇÃO: cada assert tem de MORDER ─────────────────────────────────────────────────
echo "── S: falsificação (sabotar e exigir VERMELHO) ──"

# S1: CHECK frouxo (só x > 0) — NaN > 0 é TRUE em numeric, então o CHECK "óbvio" deixa passar.
psql -q -f "$TMP/schema.sql" >/dev/null 2>&1
psql -q -c "DROP TABLE IF EXISTS public.farmer_recommendations, public.farmer_bundle_recommendations, public.omie_products CASCADE" >/dev/null 2>&1
psql -q -f "$TMP/schema.sql" >/dev/null 2>&1
sed "s/AND affinity_bundle < 'Infinity'::numeric//; s/affinity_bundle <> 'NaN'::numeric/affinity_bundle > -1/" "$MIG" > "$TMP/s1.sql"
afirma "S1 CHECK frouxo aceita NaN → A7 tem de cair" FALHA "$TMP/s1.sql"

# S2: reintroduzir o bug original no A7 — o 23502 volta a abortar a migration.
psql -q -c "DROP TABLE IF EXISTS public.farmer_recommendations, public.farmer_bundle_recommendations, public.omie_products CASCADE" >/dev/null 2>&1
psql -q -f "$TMP/schema.sql" >/dev/null 2>&1
perl -0pe "s/\(farmer_id, customer_user_id, bundle_products, affinity_bundle\)\n    VALUES \(gen_random_uuid\(\), gen_random_uuid\(\), '\[\]'::jsonb, 'NaN'::numeric\)/(bundle_products, affinity_bundle)\n    VALUES ('[]'::jsonb, 'NaN'::numeric)/" "$MIG" > "$TMP/s2.sql"
if ! diff -q "$MIG" "$TMP/s2.sql" >/dev/null; then
  afirma "S2 bug original de volta → aborta (23502)" FALHA "$TMP/s2.sql"
else
  echo "  FAIL [S2] a sabotagem NÃO foi aplicada — o verde não provaria nada"; fail=$((fail+1))
fi

# S3: POR QUE product_id fica fora do A8. Sozinho, um uuid sintético não derruba nada — o CHECK é
# avaliado durante o INSERT e a FK dispara como constraint trigger DEPOIS, então o check_violation
# morde primeiro e o handler o captura (medido; eu supus o contrário antes de testar). O risco real
# aparece COMBINADO: com o CHECK afrouxado, a FK passa a disparar e derruba a migration por
# foreign_key_violation — mascarando o defeito que o A8 existe para gritar.
psql -q -c "DROP TABLE IF EXISTS public.farmer_recommendations, public.farmer_bundle_recommendations, public.omie_products CASCADE" >/dev/null 2>&1
psql -q -f "$TMP/schema.sql" >/dev/null 2>&1
perl -0pe "s/\(farmer_id, customer_user_id, recommendation_type, affinity_score\)\n    VALUES \(gen_random_uuid\(\), gen_random_uuid\(\), 'cross_sell', 'NaN'::numeric\)/(farmer_id, customer_user_id, recommendation_type, product_id, affinity_score)\n    VALUES (gen_random_uuid(), gen_random_uuid(), 'cross_sell', gen_random_uuid(), 'NaN'::numeric)/" "$MIG" \
  | sed "s/AND affinity_score < 'Infinity'::numeric//; s/affinity_score <> 'NaN'::numeric/affinity_score > -1/" > "$TMP/s3.sql"
if diff -q "$MIG" "$TMP/s3.sql" >/dev/null; then
  echo "  FAIL [S3] a sabotagem NÃO foi aplicada — o resultado não provaria nada"; fail=$((fail+1))
else
  saida="$(psql -q -f "$TMP/s3.sql" 2>&1)"
  if echo "$saida" | command grep -q "A8 FALHOU"; then
    echo "  FAIL [S3] caiu por A8 — a FK não mascarou, a justificativa de omitir cai"; fail=$((fail+1))
  elif echo "$saida" | command grep -qE "23503|foreign key|chave estrangeira"; then
    echo "  OK   [S3 CHECK frouxo + product_id → FK MASCARA o defeito (23503, não 'A8 FALHOU')]"; ok=$((ok+1))
  else
    echo "  FAIL [S3] desfecho inesperado"; echo "$saida" | tail -3 | sed 's/^/       /'; fail=$((fail+1))
  fi
fi

echo "──────────────────────────────"
echo "RESULTADO: $ok ok / $fail fail"
if [ "$fail" -eq 0 ]; then echo "HARNESS VERDE"; exit 0; else echo "HARNESS VERMELHO"; exit 1; fi
