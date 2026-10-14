#!/usr/bin/env bash
# test-defasagem-desconto-valor.sh — prova PG17 da migration 20261014211500_defasagem_desconto_valor.sql
# ================================================================================================
# get_defasagem_cliente passa a ler order_items.desconto_valor (R$ da linha; NULL = não apurado) no
# guard `desconto_nao_provado`, no lugar da coluna legada order_items.discount (0 em 100% do acervo).
#
# Banco: stubs + schema-snapshot da prod (re-dump 2026-10-08, que já tem o predecessor EXATO — H0
# confere o md5 medido em prod via psql-ro em 2026-10-14) + o ACL de prod da função. A migration
# aplicada é a REAL (cópia; a sabotagem age na cópia — supabase/migrations/ é DR e não se toca).
#
# Cenário-base: âncora a 60 dias, p_last 100, c_last 60 (snapshot na data), c_now 80 fresco, carrinho
# a 100 → `defasado`. Cada produto muda SÓ o desconto das linhas da âncora:
#   DV1  desconto_valor > 0                    → neutro/desconto_nao_provado
#   DV2  desconto_valor NULL (não apurado)     → neutro/desconto_nao_provado
#   DV3  desconto_valor = 0 (Omie informou 0)  → defasado (o zero NÃO é engolido pelo guard)
#   DV4  mesmo dia: uma linha 0 + uma NULL     → neutro/desconto_nao_provado (basta uma)
#   DV5  desconto_valor negativo (lixo)        → neutro/desconto_nao_provado
#   DV6  desconto_valor 'NaN'                  → neutro/desconto_nao_provado (sem sabotagem própria: no PG
#        NaN > 0 é TRUE, então até a régua antiga `COALESCE(…,0) > 0` o pega — 1ª falsificação mostrou)
#   DV7  legado discount > 0, desconto_valor 0 → defasado (a coluna legada não é mais lida)
#   DV8  desconto só numa compra ANTERIOR       → defasado (só o dia da âncora conta)
#   G1   não-staff                             → 42501 (gate intacto)
#   MIG  a migration aplica com a POS verde; MIG2 re-colar é seguro; H1 ACL/config preservados
#
# Uso:  bash db/test-defasagem-desconto-valor.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       bash db/test-defasagem-desconto-valor.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# O --falsificar roda PRIMEIRO o controle (sem sabotagem, exige verde e o total) e só então cada
# sabotagem, exigindo VERMELHO exatamente nos asserts listados e VERDE nos de controle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5771}"
SLUG="defasagem-desconto-valor"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261014211500_defasagem_desconto_valor.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=13

# ── Falsificação ─────────────────────────────────────────────────────────────────────────────
# nome:vermelhos:verdes. Sabotagem de CORPO desliga a POS (RAISE EXCEPTION 'POS → RAISE NOTICE 'POS)
# para o corpo sabotado chegar ao banco: o dente provado é o do ASSERT. As "_pos" mantêm a POS e
# provam o dente DELA (MIG vermelho).
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="legado:DV1,DV2,DV4,DV7:DV3,DV8,G1
              null_vira_zero:DV2,DV4,DV5:DV1,DV3,DV6,DV7
              zero_conta:DV3,DV7,DV8:DV1,G1
              sem_gate:G1:DV1,DV3
              pos_legado:MIG:
              pos_null_vira_zero:MIG:
              pre_volatil:MIG:"
  falhas=0
  echo "═══ CONTROLE (sem sabotagem) ═══"
  if ! PGPORT_TEST="$PORT" bash "$0" > "/tmp/falsif-${SLUG}-controle.log" 2>&1; then
    echo "❌ CONTROLE VERMELHO — sem linha de base, a falsificação não prova nada"; tail -20 "/tmp/falsif-${SLUG}-controle.log"; exit 1
  fi
  n=$(grep -c '  ✅ ' "/tmp/falsif-${SLUG}-controle.log" || true)
  [ "$n" = "$TOTAL_ESPERADO" ] || { echo "❌ CONTROLE rodou $n asserts, esperado $TOTAL_ESPERADO"; exit 1; }
  echo "  ✅ controle verde ($n asserts)"
  i=0
  for linha in $SABOTAGENS; do
    i=$((i+1))
    nome="${linha%%:*}"; resto="${linha#*:}"; reds="${resto%%:*}"; greens="${resto#*:}"
    log="/tmp/falsif-${SLUG}-${nome}.log"
    if SABOTAGEM="$nome" PGPORT_TEST="$((PORT+i))" bash "$0" > "$log" 2>&1; then
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); continue
    fi
    antes=$falhas
    for a in ${reds//,/ }; do
      grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); }
    done
    for a in ${greens//,/ }; do
      [ -n "$a" ] || continue
      grep -q "^  ✅ $a " "$log" || { echo "❌ $nome: $a (controle) devia seguir VERDE"; falhas=$((falhas+1)); }
    done
    [ "$falhas" = "$antes" ] || continue
    echo "  ✅ $nome → vermelho em [$reds]${greens:+, verde em [$greens]}"
  done
  [ "$falhas" = 0 ] || { echo "❌ FALSIFICAÇÃO FALHOU ($falhas)"; exit 1; }
  echo "✅ FALSIFICAÇÃO OK — todas as sabotagens ficaram vermelhas onde deviam"
  exit 0
fi

# ── arranque PG17 descartável ────────────────────────────────────────────────────────────────
# shellcheck source=db/lib/pg-harness.sh
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c TimeZone=UTC" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1 $2 (=$3)"; else bad "$1 $2 — esperado [$4], veio [$3]"; fi; }

# ZONA 1 — schema de prod: stubs + prelude + snapshot
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
DO $$ BEGIN CREATE ROLE claude_ro; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
# ACL de prod da função (psql-ro, 2026-10-14) — o snapshot vem sem privilégios
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE ALL ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) TO authenticated, service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
SQL
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

# H0 — o predecessor do snapshot é o corpo medido em prod (senão a prova testa outra coisa)
eq H0 "predecessor = md5 medido na prod" \
  "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")" \
  "a03eb600ef0d2a946e550aa55bba415e"
ACL_ANTES="$(Pq -c "SELECT provolatile::text||'|'||prosecdef::text||'|'||coalesce(array_to_string(proconfig,','),'-')||'|'||coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a),'NULL') FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")"

# ZONA 2 — a migration REAL (cópia, onde a sabotagem age)
MIG="$TMPD/mig.sql"
cp "$MIG_ORIG" "$MIG"
sabotar() { # $1 = sed; exige que o sed MUDE o arquivo (sabotagem que não casa = teatro)
  local antes; antes="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  sed -i.bak -E "$1" "$MIG"
  local depois; depois="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  [ "$antes" != "$depois" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
desliga_pos() { sabotar "s/RAISE EXCEPTION 'POS/RAISE NOTICE 'POS/g"; }
case "${SABOTAGEM:-}" in
  "") ;;
  legado)             sabotar 's/oi\.desconto_valor AS disc_item/oi.discount AS disc_item/'; desliga_pos ;;
  null_vira_zero)     sabotar 's/disc_item IS DISTINCT FROM 0 OR/COALESCE(disc_item,0) > 0 OR/'; desliga_pos ;;
  zero_conta)         sabotar 's/disc_item IS DISTINCT FROM 0 OR/disc_item IS NOT NULL OR/'; desliga_pos ;;
  sem_gate)           sabotar 's/IF NOT \(auth\.uid\(\) IS NOT NULL/IF false AND NOT (auth.uid() IS NOT NULL/'; desliga_pos ;;
  pos_legado)         sabotar 's/oi\.desconto_valor AS disc_item/oi.discount AS disc_item/' ;;
  pos_null_vira_zero) sabotar 's/disc_item IS DISTINCT FROM 0 OR/COALESCE(disc_item,0) > 0 OR/' ;;
  # predecessor VOLATILE (mesmo prosrc): o PRE tem de recusar em vez de a trava normalizar em silêncio
  pre_volatil)        P -q -c "ALTER FUNCTION public.get_defasagem_cliente(jsonb,uuid) VOLATILE" ;;
  *) echo "INFRA: sabotagem desconhecida $SABOTAGEM"; exit 2 ;;
esac
# A POS compara md5 do corpo com o desta migration: sabotagem de corpo com POS desligada passa;
# a "_pos" tem de morrer na POS. O PRE aceita também este corpo: re-colar é provado em MIG2.
if P -q -f "$MIG" >"$TMPD/mig.out" 2>&1; then
  ok "MIG migration aplicou (PRE+CREATE+POS)"
else
  bad "MIG migration não aplicou: $(grep -m1 -E 'ERROR' "$TMPD/mig.out" | cut -c1-200)"
  echo "RESULTADO: $PASS ok / $FAIL fail"; exit 1
fi
if P -q -f "$MIG" >"$TMPD/mig2.out" 2>&1; then ok "MIG2 re-colar a migration é seguro (PRE aceita este corpo)"
else bad "MIG2 re-colar falhou: $(grep -m1 ERROR "$TMPD/mig2.out" | cut -c1-200)"; fi
eq H1 "volatilidade/secdef/search_path/ACL preservados" \
  "$(Pq -c "SELECT provolatile::text||'|'||prosecdef::text||'|'||coalesce(array_to_string(proconfig,','),'-')||'|'||coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a),'NULL') FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")" \
  "$ACL_ANTES"

# ZONA 3 — semente (replica: sem gatilhos/FKs; a semente não é o objeto sob prova)
P -q <<'SQL' >/dev/null
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
ALTER TABLE public.order_items  DISABLE TRIGGER ALL;
SET session_replication_role = replica;
DO $seed$
DECLARE
  cli   uuid := md5('dv:cliente')::uuid;
  staff uuid := md5('dv:staff')::uuid;
  d_anc date := current_date - 60;
  d_old date := current_date - 120;
  r record; so uuid; so_old uuid; n bigint := 770000;
BEGIN
  INSERT INTO public.user_roles (user_id, role) VALUES (staff, 'employee');
  -- produto → descontos das linhas do dia da âncora (array) + legado + desconto de compra anterior
  FOR r IN SELECT * FROM (VALUES
      (9001, ARRAY[5.00]::numeric[],          0::numeric, NULL::numeric),  -- DV1
      (9002, ARRAY[NULL]::numeric[],          0,          NULL),           -- DV2
      (9003, ARRAY[0]::numeric[],             0,          NULL),           -- DV3
      (9004, ARRAY[0, NULL]::numeric[],       0,          NULL),           -- DV4
      (9005, ARRAY[-1]::numeric[],            0,          NULL),           -- DV5
      (9006, ARRAY['NaN']::numeric[],         0,          NULL),           -- DV6
      (9007, ARRAY[0]::numeric[],             7,          NULL),           -- DV7 (legado discount=7)
      (9008, ARRAY[0]::numeric[],             0,          9.00)            -- DV8 (desconto só antes)
    ) AS x(cod, descs, legado, desc_antes)
  LOOP
    INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at)
      VALUES (r.cod, 80, 'oben', now());
    INSERT INTO public.cmc_snapshot (omie_codigo_produto, account, data_posicao, cmc, synced_at)
      VALUES (r.cod, 'oben', d_anc, 60, now()), (r.cod, 'oben', d_old, 60, now());
    -- âncora: um pedido por linha, todos no MESMO dia
    FOR i IN 1..array_length(r.descs, 1) LOOP
      n := n + 1; so := gen_random_uuid();
      INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi,
                                       omie_pedido_id, omie_numero_pedido, total, discount)
        VALUES (so, cli, cli, 'oben', 'faturado', d_anc, n, n::text, 1000, 0);
      INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price,
                                      discount, desconto_valor)
        VALUES (so, cli, r.cod, 10, 100, r.legado, r.descs[i]);
    END LOOP;
    -- compra anterior (fora do dia da âncora)
    n := n + 1; so_old := gen_random_uuid();
    INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi,
                                     omie_pedido_id, omie_numero_pedido, total, discount)
      VALUES (so_old, cli, cli, 'oben', 'faturado', d_old, n, n::text, 900, 0);
    INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price,
                                    discount, desconto_valor)
      VALUES (so_old, cli, r.cod, 10, 90, 0, coalesce(r.desc_antes, 0));
  END LOOP;
END $seed$;
SET session_replication_role = origin;
ALTER TABLE public.sales_orders ENABLE TRIGGER ALL;
ALTER TABLE public.order_items  ENABLE TRIGGER ALL;
SQL

# ZONA 4 — asserts (como staff autenticado, pelo ACL real)
CLI="$(Pq -c "SELECT md5('dv:cliente')::uuid")"
STAFF="$(Pq -c "SELECT md5('dv:staff')::uuid")"
status_de() { # $1 = codigo → "status/motivo" (sentinela '(null)' quando a chave some)
  Pq -c "SET test.uid='$STAFF'; SET ROLE authenticated;
         SELECT coalesce(e->>'status_defasagem','(null)')||'/'||coalesce(e->>'motivo','(null)')
           FROM jsonb_array_elements(public.get_defasagem_cliente('[{\"empresa\":\"oben\",\"codigo\":$1,\"preco\":100}]'::jsonb, '$CLI'::uuid)) e" \
    | grep -v '^SET$' || echo "(erro)"
}
NP="neutro/desconto_nao_provado"
DEF="defasado/custo_subiu_preco_nao_acompanhou"
eq DV1 "desconto > 0 neutraliza"               "$(status_de 9001)" "$NP"
eq DV2 "desconto NULL (não apurado) neutraliza" "$(status_de 9002)" "$NP"
eq DV3 "desconto = 0 segue calculado"          "$(status_de 9003)" "$DEF"
eq DV4 "dia com 0 + NULL neutraliza"           "$(status_de 9004)" "$NP"
eq DV5 "desconto negativo neutraliza"          "$(status_de 9005)" "$NP"
eq DV6 "desconto NaN neutraliza"               "$(status_de 9006)" "$NP"
eq DV7 "coluna legada não é lida"              "$(status_de 9007)" "$DEF"
eq DV8 "desconto fora do dia da âncora ignorado" "$(status_de 9008)" "$DEF"

# G1 — negativo: autenticado sem papel de staff → 42501 (a SQLSTATE esperada; o resto re-lança)
G1="$(Pq -c "SET test.uid='$CLI'; SET ROLE authenticated;
DO \$g\$ BEGIN
  PERFORM public.get_defasagem_cliente('[{\"empresa\":\"oben\",\"codigo\":9003,\"preco\":100}]'::jsonb, '$CLI'::uuid);
  RAISE NOTICE 'G1-PASSOU-SEM-GATE';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'G1-NEGADO-42501';
          WHEN OTHERS THEN RAISE;
END \$g\$;" 2>&1 | grep -oE 'G1-[A-Z0-9-]+' | head -1 || true)"
eq G1 "não-staff é negado com 42501" "$G1" "G1-NEGADO-42501"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
[ "$PASS" = "$TOTAL_ESPERADO" ] || { echo "❌ rodou $PASS asserts, esperado $TOTAL_ESPERADO"; exit 1; }
echo "✅ HARNESS VERDE"
