#!/usr/bin/env bash
# test-vendedor-pedido-omie.sh — prova PG17 da migration 20261113120000_vendedor_pedido_omie.sql
# ================================================================================================
# Venda por cliente · rodada 2 · Entrega 2: quem vendeu cada pedido importado do Omie.
#
# Banco: stubs + schema-snapshot da prod + a migration REAL (cópia — a sabotagem age na cópia).
#
#   MIG   a migration aplica com a POS verde; MIG2 re-aplicar é seguro (idempotente)
#   CB1   a RPC viva do sync (criar_pedidos_com_itens) grava importado com created_by NULL
#   V1    lote: código mapeado → vendedor_user_id resolvido
#   V2    código SEM mapa → código gravado, usuário NULL (nunca chute) + listado em codigos_sem_mapa
#   V3    cod_vend null → lido_em preenchido, código NULL ("Omie sem vendedor" ≠ "não lido")
#   V4    pedido fora do banco → contado em fora_do_banco, nada escrito
#   V5    re-ler o MESMO lote → 0 atualizados e updated_at intocado (idempotente)
#   V6    cod_vend null sobre código conhecido → NÃO apaga (ausente ≠ apagar)
#   V7    vendedor mudou no Omie → código e usuário seguem o Omie
#   V8    isolamento: mesma omie_pedido_id em OUTRA conta e a linha do APP não são tocadas
#   V9    mapa ganhou o código depois → re-ler resolve o usuário
#   E1-5  payload inválido / conta inválida / duplicado → 22023 com a marca (não grava)
#   A1    authenticated não executa o escritor (42501)
#   C1    cobertura (master): números por conta e pct
#   C2    cobertura de período vazio → pct NULL (ausente ≠ 0)
#   C3    cobertura não-master → 42501 · C4 service_role passa
#   D1    db/2026-11-13-desfabricar-autor-importado.sql: importados sem autor, app intacto, backup fiel
#
# Uso:  bash db/test-vendedor-pedido-omie.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-vendedor-pedido-omie.sh   (2º locale)
#       bash db/test-vendedor-pedido-omie.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5791}"
SLUG="vendedor-pedido-omie"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261113120000_vendedor_pedido_omie.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=26

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS:VERDES-de-controle   (ID!MARCA = vermelho de execução com a marca)
  SABOTAGENS="sem_drop_not_null:CB1:V1,V2
              chuta_usuario:V2:V1,V3
              apaga_codigo:V6:V1,V5
              reescreve_sempre:V5:V1,V2
              sem_isolamento_conta:V8:V1,V3
              sem_validacao:E1,E2:E4,V1
              sem_dup:E5:E1,V1
              pct_zero:C2:C1
              sem_gate_cobertura:C3:C1
              pos_not_null:MIG!P1_FALHOU
              pos_grant_update:MIG!P5_FALHOU
              desfabrica_app:D1:C1"
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
    nome="${linha%%:*}"; resto="${linha#*:}"; reds="${resto%%:*}"
    case "$resto" in *:*) greens="${resto#*:}" ;; *) greens="" ;; esac
    log="/tmp/falsif-${SLUG}-${nome}.log"
    if SABOTAGEM="$nome" PGPORT_TEST="$((PORT+i))" bash "$0" > "$log" 2>&1; then
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); continue
    fi
    antes=$falhas
    for a in ${reds//,/ }; do
      case "$a" in
        *!*) id="${a%%!*}"; marca="${a#*!}"   # vermelho de EXECUÇÃO: o erro tem de trazer a marca
             grep -q "^  ❌ $id .*ERROR:  $marca:" "$log" || { echo "❌ $nome: $id devia falhar com a marca $marca"; falhas=$((falhas+1)); } ;;
        *)   grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); } ;;
      esac
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

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/ (resolve o PGBIN no Mac e no CI)
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
# Erro esperado: casa a SQLSTATE e a MARCA (ASCII, caixa fixa) — "lançou algo" não conta.
erro() { # $1 id, $2 descrição, $3 sqlstate, $4 marca, $5 sql
  local out; out="$(P -tA -c "\\set VERBOSITY verbose" -c "$5" 2>&1 || true)"
  if printf '%s' "$out" | grep -q "ERROR:  $3:" && printf '%s' "$out" | grep -q "$4"; then
    ok "$1 $2 ($3 $4)"
  else
    bad "$1 $2 — esperado $3/$4, veio: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

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
# ACL de prod de sales_orders (20260709163500): SELECT/UPDATE por coluna, nunca table-level.
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE SELECT, UPDATE ON public.sales_orders FROM authenticated;
GRANT SELECT (id, customer_user_id, created_by, status, account, hash_payload) ON public.sales_orders TO authenticated;
GRANT UPDATE (status, notes) ON public.sales_orders TO authenticated;
SQL
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

MIG="$TMPD/mig.sql"
cp "$MIG_ORIG" "$MIG"
DESF="$TMPD/desf.sql"
cp "$REPO_ROOT/db/2026-11-13-desfabricar-autor-importado.sql" "$DESF"
sabotar() { # $1 = expressão perl; exige que MUDE o arquivo (sabotagem que não casa = teatro)
  local antes depois
  antes="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  perl -0pi -e "$1" "$MIG"
  depois="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  [ "$antes" != "$depois" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
desliga_pos() { sabotar "s/RAISE EXCEPTION 'P(\\d)_FALHOU/RAISE NOTICE 'P\${1}_FALHOU/g"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_drop_not_null)   sabotar 's/ALTER TABLE public\.sales_orders ALTER COLUMN created_by DROP NOT NULL;/-- sabotado/'; desliga_pos ;;
  chuta_usuario)       sabotar 's/SELECT a\.id, a\.cod_final, m\.user_id\n/SELECT a.id, a.cod_final, coalesce(m.user_id, CASE WHEN a.cod_final IS NOT NULL THEN (SELECT min(user_id::text)::uuid FROM public.omie_vendedor_map WHERE omie_account = p_account) END) AS user_id\n/'; desliga_pos ;;
  apaga_codigo)        sabotar 's/coalesce\(l\.cod_vend, so\.vendedor_omie_codigo\) AS cod_final/l.cod_vend AS cod_final/'; desliga_pos ;;
  reescreve_sempre)    sabotar 's/AND \(so\.vendedor_lido_em IS NULL\n/AND (true OR so.vendedor_lido_em IS NULL\n/'; desliga_pos ;;
  sem_isolamento_conta) sabotar 's/ON so\.account = p_account\n       AND so\.omie_pedido_id = l\.codigo_pedido\n       AND so\.hash_payload LIKE .omie\\_%./ON so.omie_pedido_id = l.codigo_pedido/'; desliga_pos ;;
  sem_validacao)       sabotar 's/  \) THEN\n    RAISE EXCEPTION .VENDEDOR_PAYLOAD_INVALIDO: codigo_pedido/  ) AND false THEN\n    RAISE EXCEPTION \x27VENDEDOR_PAYLOAD_INVALIDO: codigo_pedido/'; desliga_pos ;;
  sem_dup)             sabotar 's/IF v_recebidos IS DISTINCT FROM v_distintos THEN/IF false THEN/'; desliga_pos ;;
  pct_zero)            sabotar 's/CASE WHEN coalesce\(sum\(pedidos\), 0\) = 0 THEN NULL/CASE WHEN coalesce(sum(pedidos), 0) = 0 THEN 0/'; desliga_pos ;;
  sem_gate_cobertura)  sabotar 's/IF NOT \(coalesce\(auth\.role\(\), ..\) = .service_role./IF false AND NOT (coalesce(auth.role(), \x27\x27) = \x27service_role\x27/'; desliga_pos ;;
  pos_not_null)        sabotar 's/ALTER TABLE public\.sales_orders ALTER COLUMN created_by DROP NOT NULL;/-- sabotado/' ;;
  pos_grant_update)    sabotar 's/UPDATE não — escritor único é a RPC\.\nGRANT SELECT \(vendedor_omie_codigo, vendedor_user_id, vendedor_lido_em\)/UPDATE não — escritor único é a RPC.\nGRANT UPDATE (vendedor_user_id) ON public.sales_orders TO authenticated;\nGRANT SELECT (vendedor_omie_codigo, vendedor_user_id, vendedor_lido_em)/' ;;
  desfabrica_app)      perl -0pi -e 's/ WHERE so\.hash_payload LIKE .omie\\_%.\n   AND so\.created_by IS NOT NULL\nON CONFLICT/ WHERE so.created_by IS NOT NULL\nON CONFLICT/' "$DESF"
                       perl -0pi -e 's/ WHERE so\.hash_payload LIKE .omie\\_%.\n   AND so\.created_by IS NOT NULL\n   AND EXISTS/ WHERE so.created_by IS NOT NULL\n   AND EXISTS/' "$DESF"
                       cmp -s "$DESF" "$REPO_ROOT/db/2026-11-13-desfabricar-autor-importado.sql" && { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; } ;;
  *) echo "INFRA: sabotagem desconhecida '$SABOTAGEM'"; exit 2 ;;
esac

# ── MIG ──────────────────────────────────────────────────────────────────────────────────────
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG migration aplica (POS verde)"; else bad "MIG migration falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG2 re-aplicar é seguro"; else bad "MIG2 re-aplicar falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi

# ── semente ──────────────────────────────────────────────────────────────────────────────────
# Usuários (auth.users para a FK) · mapa por conta · pedidos importados (hash canônico) direto,
# sem itens (coerência: 0 linhas = fora do escopo do trigger).
P -q <<'SQL' >/dev/null
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),  -- REGINA
  ('00000000-0000-0000-0000-0000000000a2'),  -- TATYANA
  ('00000000-0000-0000-0000-0000000000f1'),  -- master
  ('00000000-0000-0000-0000-0000000000e1'),  -- employee
  ('00000000-0000-0000-0000-0000000000c1');  -- cliente
INSERT INTO public.profiles (user_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'REGINA'), ('00000000-0000-0000-0000-0000000000a2', 'TATYANA')
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'master'), ('00000000-0000-0000-0000-0000000000e1', 'employee');
INSERT INTO public.omie_vendedor_map (omie_account, omie_codigo_vendedor, user_id, nome) VALUES
  ('oben', 842, '00000000-0000-0000-0000-0000000000a1', 'REGINA'),
  ('oben', 840, '00000000-0000-0000-0000-0000000000a2', 'TATYANA'),
  ('colacor', 842, '00000000-0000-0000-0000-0000000000a2', 'TATYANA');  -- mesmo código, outra conta
INSERT INTO public.sales_orders (customer_user_id, created_by, items, subtotal, total, status, account,
                                 omie_pedido_id, hash_payload, order_date_kpi, created_at, updated_at)
SELECT '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '[]', t, t, 'importado', a, p, 'omie_'||a||'_'||p,
       d, d + time '12:00', timestamptz '2026-01-01 00:00Z'
  FROM (VALUES ('oben', 1001, 100, date '2026-10-01'), ('oben', 1002, 200, date '2026-10-02'),
               ('oben', 1003, 300, date '2026-10-03'), ('oben', 1004, 400, date '2026-10-04'),
               ('colacor', 1001, 500, date '2026-10-05')) v(a, p, t, d);
SQL

# ── CB1: o caminho vivo do sync grava importado sem autor ───────────────────────────────────
out="$(P -tA 2>&1 <<'SQL' || true
SELECT (public.criar_pedidos_com_itens(jsonb_build_array(jsonb_build_object(
  'customer_user_id', '00000000-0000-0000-0000-0000000000c1', 'created_by', NULL,
  'items', jsonb_build_array(jsonb_build_object('omie_codigo_produto', 77, 'descricao', 'x', 'quantidade', 1, 'valor_unitario', 10, 'desconto', 0)),
  'subtotal', 10, 'discount', 0, 'total', 10, 'status', 'importado',
  'omie_pedido_id', 1999, 'omie_numero_pedido', '1999', 'account', 'oben', 'hash_payload', 'omie_oben_1999',
  'created_at', '2026-10-09T12:00:00Z', 'order_date_kpi', '2026-10-09',
  'itens', jsonb_build_array(jsonb_build_object('customer_user_id', '00000000-0000-0000-0000-0000000000c1',
     'product_id', NULL, 'omie_codigo_produto', 77, 'quantity', 1, 'unit_price', 10, 'discount', 0,
     'desconto_valor', 0, 'hash_payload', 'omie_oben_1999_77')),
  'precos', '[]'::jsonb))))->>'inserted';
SELECT count(*) FROM public.sales_orders WHERE hash_payload = 'omie_oben_1999' AND created_by IS NULL;
SQL
)"
eq CB1 "criar_pedidos_com_itens insere importado com created_by NULL" "$(printf '%s' "$out" | tr '\n' ' ' | sed 's/ $//')" "1 1"

LOTE='[{"codigo_pedido":1001,"cod_vend":842},{"codigo_pedido":1002,"cod_vend":777},{"codigo_pedido":1003,"cod_vend":null},{"codigo_pedido":9999,"cod_vend":842}]'
reg() { Pq -c "SELECT public.sales_orders_registrar_vendedor_omie('$1', '$2'::jsonb)::text" 2>&1; }
col() { Pq -c "SELECT coalesce(vendedor_omie_codigo::text,'-')||'|'||coalesce(vendedor_user_id::text,'-')||'|'||(vendedor_lido_em IS NOT NULL)::text FROM public.sales_orders WHERE account='$1' AND hash_payload='omie_$1_$2'"; }

r="$(reg oben "$LOTE")"
eq V1 "código mapeado resolve o usuário" "$(col oben 1001)" "842|00000000-0000-0000-0000-0000000000a1|true"
eq V2 "código sem mapa: grava código, usuário NULL, listado" "$(col oben 1002)|$(Pq -c "SELECT ('$r'::jsonb)->>'codigos_sem_mapa'")" "777|-|true|[777]"
eq V3 "cod_vend null: lido, sem código" "$(col oben 1003)" "-|-|true"
eq V4 "pedido fora do banco: contado e nada escrito" "$(Pq -c "SELECT (j->>'recebidos')||'/'||(j->>'casados')||'/'||(j->>'atualizados')||'/'||(j->>'fora_do_banco') FROM (SELECT '$r'::jsonb j) s")|$(col oben 1004)" "4/3/3/1|-|-|false"

UPD_ANTES="$(Pq -c "SELECT string_agg(updated_at::text, ',' ORDER BY omie_pedido_id) FROM public.sales_orders WHERE account='oben' AND omie_pedido_id IN (1001,1002,1003)")"
r2="$(reg oben "$LOTE")"
UPD_DEPOIS="$(Pq -c "SELECT string_agg(updated_at::text, ',' ORDER BY omie_pedido_id) FROM public.sales_orders WHERE account='oben' AND omie_pedido_id IN (1001,1002,1003)")"
eq V5 "re-ler o mesmo lote: 0 atualizados, updated_at intocado" "$(Pq -c "SELECT ('$r2'::jsonb)->>'atualizados'")|$([ "$UPD_ANTES" = "$UPD_DEPOIS" ] && echo same || echo mudou)" "0|same"

reg oben '[{"codigo_pedido":1001,"cod_vend":null}]' >/dev/null
eq V6 "cod_vend null NÃO apaga código conhecido" "$(col oben 1001)" "842|00000000-0000-0000-0000-0000000000a1|true"

reg oben '[{"codigo_pedido":1001,"cod_vend":840}]' >/dev/null
eq V7 "vendedor mudou no Omie: segue o Omie" "$(col oben 1001)" "840|00000000-0000-0000-0000-0000000000a2|true"

# V8: linha do APP (hash NULL) do mesmo pedido + a da outra conta seguem intocadas.
P -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, items, status, account, omie_pedido_id)
         VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '[]', 'enviado', 'oben', 1004)" >/dev/null
reg oben '[{"codigo_pedido":1004,"cod_vend":842}]' >/dev/null
eq V8 "isolamento: outra conta e linha do app intocadas" "$(col colacor 1001)|$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload IS NULL AND vendedor_lido_em IS NOT NULL")" "-|-|false|0"

P -q -c "INSERT INTO public.omie_vendedor_map (omie_account, omie_codigo_vendedor, user_id) VALUES ('oben', 777, '00000000-0000-0000-0000-0000000000a2')" >/dev/null
reg oben '[{"codigo_pedido":1002,"cod_vend":777}]' >/dev/null
eq V9 "mapa ganhou o código: re-ler resolve" "$(col oben 1002)" "777|00000000-0000-0000-0000-0000000000a2|true"

P -q -c "UPDATE public.sales_orders SET vendedor_omie_codigo=NULL, vendedor_user_id=NULL, vendedor_lido_em=NULL WHERE account='oben' AND omie_pedido_id=1003" >/dev/null
erro E1 "codigo_pedido string" 22023 VENDEDOR_PAYLOAD_INVALIDO "SELECT public.sales_orders_registrar_vendedor_omie('oben', '[{\"codigo_pedido\":\"1003\",\"cod_vend\":842}]')"
erro E2 "cod_vend negativo" 22023 VENDEDOR_PAYLOAD_INVALIDO "SELECT public.sales_orders_registrar_vendedor_omie('oben', '[{\"codigo_pedido\":1003,\"cod_vend\":-5}]')"
eq E2b "payload inválido não gravou" "$(col oben 1003)" "-|-|false"
erro E3 "cod_vend fracionário" 22023 VENDEDOR_PAYLOAD_INVALIDO "SELECT public.sales_orders_registrar_vendedor_omie('oben', '[{\"codigo_pedido\":1003,\"cod_vend\":1.5}]')"
erro E4 "conta colacor_sc" 22023 VENDEDOR_CONTA_INVALIDA "SELECT public.sales_orders_registrar_vendedor_omie('colacor_sc', '[]')"
erro E5 "pedido duplicado no lote" 22023 VENDEDOR_PAYLOAD_DUPLICADO "SELECT public.sales_orders_registrar_vendedor_omie('oben', '[{\"codigo_pedido\":1003,\"cod_vend\":842},{\"codigo_pedido\":1003,\"cod_vend\":840}]')"

erro A1 "authenticated não executa o escritor" 42501 "permission denied" "SET ROLE authenticated; SELECT public.sales_orders_registrar_vendedor_omie('oben', '[]')"

# ── cobertura ────────────────────────────────────────────────────────────────────────────────
# Universo oben no período: 1001(840→a2), 1002(777→a2), 1003(nada), 1004(842→a1), 1999 (não lido).
cob() { Pq -c "SET ROLE authenticated; SET test.uid = '$1'; $2" 2>&1 | tail -1; }
C1="$(cob 00000000-0000-0000-0000-0000000000f1 "SELECT (j->'por_conta'->0->>'account')||'|'||(j->'por_conta'->0->>'pedidos')||'|'||(j->'por_conta'->0->>'lidos')||'|'||(j->'por_conta'->0->>'com_vendedor')||'|'||(j->'por_conta'->0->>'pct_com_vendedor')||'|'||(j->'total'->>'pedidos')||'|'||jsonb_array_length(j->'por_vendedor') FROM (SELECT public.venda_cobertura_vendedor('2026-10-01','2026-10-31') j) s")"
eq C1 "cobertura master por conta" "$C1" "colacor|1|0|0|0.0|6|2"
C2="$(cob 00000000-0000-0000-0000-0000000000f1 "SELECT coalesce(j->'total'->>'pct_com_vendedor','NULL')||'|'||(j->'total'->>'pedidos') FROM (SELECT public.venda_cobertura_vendedor('2025-01-01','2025-01-31') j) s")"
eq C2 "período vazio: pct NULL" "$C2" "NULL|0"
erro C3 "cobertura não-master" 42501 "requer master" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000e1'; SELECT public.venda_cobertura_vendedor('2026-10-01','2026-10-31')"
C4="$(Pq -c "SET test.role = 'service_role'; SELECT (public.venda_cobertura_vendedor('2026-10-01','2026-10-31')->'total'->>'com_vendedor')" 2>&1 | tail -1)"
eq C4 "service_role passa" "$C4" "3"
OBEN="$(cob 00000000-0000-0000-0000-0000000000f1 "SELECT (e->>'pedidos')||'|'||(e->>'lidos')||'|'||(e->>'com_codigo')||'|'||(e->>'com_vendedor')||'|'||(e->>'pct_com_vendedor') FROM jsonb_array_elements(public.venda_cobertura_vendedor('2026-10-01','2026-10-31')->'por_conta') e WHERE e->>'account'='oben'")"
eq C5 "cobertura oben (5 pedidos, 3 lidos, 3 códigos, 3 vendedores)" "$OBEN" "5|3|3|3|60.0"
erro C6 "período > 400 dias" 22023 COBERTURA_PERIODO "SET test.role = 'service_role'; SELECT public.venda_cobertura_vendedor('2024-01-01','2026-01-01')"

# ── D1: o script do acervo ──────────────────────────────────────────────────────────────────
ANTES_D="$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload LIKE 'omie\\_%' AND created_by IS NOT NULL")"
if out="$(P -q -f "$DESF" 2>&1)" && printf '%s' "$out" | grep -q DESFABRICAR_AUTOR_IMPORTADO_OK; then
  D1="$ANTES_D|$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload LIKE 'omie\\_%' AND created_by IS NOT NULL")|$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload IS NULL AND created_by = '00000000-0000-0000-0000-0000000000e1'")|$(Pq -c "SELECT count(*) FROM private.bkp_sales_orders_created_by_20261113 WHERE created_by = '00000000-0000-0000-0000-0000000000e1'")"
  P -q -f "$DESF" >/dev/null 2>&1 || D1="$D1|reaplicar-falhou"
  eq D1 "acervo: antes|depois|app com autor|backup (e re-aplicar seguro)" "$D1" "5|0|1|5"
else
  bad "D1 script do acervo falhou: $(printf '%s' "$out" | grep -m1 ERROR)"
fi

echo "═══ $PASS ✅ · $FAIL ❌ (esperado $TOTAL_ESPERADO ✅) ═══"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || exit 1
echo "PROVA_VENDEDOR_PEDIDO_OMIE_OK"
