#!/usr/bin/env bash
# Prova PG17 (com falsificação) do backfill db/backfill-pedido-cancelado-omie-20261121.sql:
# pedido que o Omie marca como cancelado sai do universo de venda — e SÓ ele.
# Roda o ARQUIVO REAL (lista embutida inclusa), numa transação só, como o db:aplicar faz.
# Uso: bash db/test-backfill-pedido-cancelado-omie.sh   (exit 0 = verde com controle + sabotagens)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5471}"
SLUG="backfill-cancelado"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMP/data"
export LC_ALL=C LANG=C
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# VERBOSITY=verbose: o psql imprime a SQLSTATE ("ERROR:  P0001: …") — é ela que os negativos casam.
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"; }
Pq() { P -tA "$@"; }

ARQ="${BACKFILL_ARQ:-$REPO_ROOT/db/backfill-pedido-cancelado-omie-20261121.sql}"
[ -f "$ARQ" ] || { echo "❌ arquivo do backfill ausente: $ARQ"; exit 2; }

# PIDs REAIS da lista embutida (o 1º de cada conta) e um PID fora dela.
pid_da() { awk -v c="$1" '$0 ~ "SELECT \x27" c "\x27, unnest\\(\x27\\{" { sub(/.*\{/, ""); split($0, a, ","); print a[1]; exit }' "$ARQ"; }
PO="$(pid_da oben)"; PC="$(pid_da colacor)"
case "$PO$PC" in *[!0-9]*|"") echo "❌ não extraí os PIDs da lista (oben=[$PO] colacor=[$PC])"; exit 2;; esac
FORA=1   # PID 1 não existe no Omie: fora da lista por construção
echo "PIDs da lista: oben=$PO colacor=$PC · fora=$FORA"

esquema() {
P -q <<'SQL'
DROP TABLE IF EXISTS public.sales_orders;
CREATE TABLE public.sales_orders (
  id             int PRIMARY KEY,
  account        text,
  omie_pedido_id bigint,
  status         text NOT NULL,
  total          numeric,
  deleted_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT '2026-01-01'
);
SQL
}

# Semente: cada linha é um caso.
semear() {
P -q <<SQL
TRUNCATE public.sales_orders;
INSERT INTO public.sales_orders (id, account, omie_pedido_id, status, total, deleted_at) VALUES
  (1, 'oben',    $PO,   'enviado',   100, NULL),          -- na lista → cancelado
  (2, 'colacor', $PC,   'faturado',  200, NULL),          -- na lista, FATURADO → cancelado
  (3, 'colacor', $PC,   'separacao', 300, NULL),          -- 2ª linha do mesmo par → cancelado
  (4, 'oben',    $FORA, 'faturado',  400, NULL),          -- fora da lista → intocado
  (5, 'oben',    $PC,   'importado', 500, NULL),          -- PID da colacor sob a conta oben → intocado
  (6, 'colacor', $PC,   'importado', 600, '2026-11-01'),  -- na lista mas excluída → intocada
  (7, 'oben',    $PO,   'rascunho',  700, NULL),          -- na lista, já fora do universo → intocada
  (8, 'oben',    $PO,   'cancelado', 800, NULL);          -- já cancelado → intocado
SQL
}
aplicar() { P -q -1 -f "$1" >"$TMP/apply.out" 2>&1; }
estado() { Pq -c "SELECT string_agg(id || ':' || status, ' ' ORDER BY id) FROM public.sales_orders"; }
ESPERADO="1:cancelado 2:cancelado 3:cancelado 4:faturado 5:importado 6:importado 7:rascunho 8:cancelado"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# Bateria: devolve 0 só se TODOS os asserts passam sobre o arquivo $1.
bateria() {
  local arq="$1" falhou=0 v
  esquema; semear
  if aplicar "$arq"; then
    v="$(estado)"
    [ "$v" = "$ESPERADO" ] || { echo "    · [EFEITO] veio [$v]"; falhou=1; }
    # [IDEMPOTENTE] 2ª aplicação: nenhuma linha tocada (updated_at não anda se o UPDATE não pega nada)
    P -q -c "UPDATE public.sales_orders SET updated_at = '2026-01-01'" >/dev/null
    if aplicar "$arq"; then
      v="$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE updated_at <> '2026-01-01'")"
      [ "$v" = "0" ] || { echo "    · [IDEMPOTENTE] 2ª rodada tocou $v linha(s)"; falhou=1; }
      [ "$(estado)" = "$ESPERADO" ] || { echo "    · [IDEMPOTENTE] estado mudou na 2ª rodada"; falhou=1; }
    else echo "    · [IDEMPOTENTE] 2ª rodada falhou: $(grep -m1 -E 'ERRO|ERROR' "$TMP/apply.out" | cut -c1-160)"; falhou=1; fi
  else
    echo "    · [EFEITO] aplicação falhou: $(grep -m1 -E 'ERRO|ERROR' "$TMP/apply.out" | cut -c1-160)"; falhou=1
  fi
  # [APP-AVANÇADO] status fora do gerido pelo Omie, na lista → a postcondição ABORTA (P0001) e nada muda.
  esquema; semear
  P -q -c "UPDATE public.sales_orders SET status = 'entregue' WHERE id = 4; UPDATE public.sales_orders SET omie_pedido_id = $PO WHERE id = 4"
  if aplicar "$arq"; then
    echo "    · [APP-AVANÇADO] aplicou com pedido cancelado no Omie ainda no universo"; falhou=1
  else
    # sentinela ≠ texto do código: casamos a SQLSTATE do psql (VERBOSITY) e não a mensagem
    grep -q 'P0001' "$TMP/apply.out" || { echo "    · [APP-AVANÇADO] falhou por OUTRO motivo: $(grep -m1 -E 'ERRO|ERROR' "$TMP/apply.out" | cut -c1-160)"; falhou=1; }
    v="$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE status = 'cancelado'")"
    [ "$v" = "1" ] || { echo "    · [APP-AVANÇADO] o aborto não desfez tudo ($v cancelados, esperado 1)"; falhou=1; }
  fi
  # [LISTA-TRUNCADA] a mesma lista sem o 1º PID da oben → a contagem embutida ABORTA (P0001).
  esquema; semear
  sed "s/unnest('{$PO,/unnest('{/" "$arq" > "$TMP/trunc.sql"
  if cmp -s "$arq" "$TMP/trunc.sql"; then echo "    · [LISTA-TRUNCADA] não consegui truncar a lista"; falhou=1
  elif aplicar "$TMP/trunc.sql"; then echo "    · [LISTA-TRUNCADA] aplicou com a lista truncada"; falhou=1
  else grep -q 'P0001' "$TMP/apply.out" || { echo "    · [LISTA-TRUNCADA] falhou por OUTRO motivo"; falhou=1; }
  fi
  return $falhou
}

echo "── CONTROLE (arquivo real) ──"
if bateria "$ARQ"; then ok "arquivo real: efeito exato, idempotente, aborta com app-avançado"; else bad "arquivo real VERMELHO"; fi

# Falsificação: cada sabotagem numa CÓPIA; exige VERMELHO. Sabotagem que não aplica = erro do teste.
sabotar() {
  local nome="$1" de="$2" para="$3" copia="$TMP/sab.sql"
  python3 - "$ARQ" "$copia" "$de" "$para" <<'PY'
import sys
s = open(sys.argv[1]).read(); de, para = sys.argv[3], sys.argv[4]
if s.count(de) < 1: sys.exit(f"sabotagem não aplicou: {de!r}")
open(sys.argv[2], "w").write(s.replace(de, para))
PY
  if bateria "$copia" >"$TMP/sab.out" 2>&1; then bad "SABOTAGEM '$nome' passou VERDE (assert sem dente)"
  else ok "sabotagem '$nome' → vermelho por: $(grep -o '· \[[^]]*\]' "$TMP/sab.out" | sort -u | tr '\n' ' ')"; fi
}
echo "── FALSIFICAÇÃO ──"
sabotar "faturado fora do alvo"       "ARRAY['importado','separacao','enviado','faturado']" "ARRAY['importado','separacao','enviado']"
sabotar "sem filtro de excluída"      "     AND so.deleted_at IS NULL
     AND so.status = ANY (c_alvo);" "     AND so.status = ANY (c_alvo);"
sabotar "casa só por PID (sem conta)" "   WHERE c.conta = so.account
     AND c.pid" "   WHERE c.pid"
sabotar "alvo inclui rascunho"        "ARRAY['importado','separacao','enviado','faturado']" "ARRAY['importado','separacao','enviado','faturado','rascunho']"
sabotar "postcondição cega"           "IF v_resto IS DISTINCT FROM 0 THEN" "IF false THEN"
sabotar "contagem da lista frouxa"    "IF v_oben IS DISTINCT FROM" "IF false AND v_oben IS DISTINCT FROM"

echo "── CONTROLE FINAL (arquivo real, de novo) ──"
if bateria "$ARQ"; then ok "arquivo real segue verde"; else bad "arquivo real VERMELHO no controle final"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
