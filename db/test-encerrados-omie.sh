#!/usr/bin/env bash
# PROVA PG17 — reposicao_marcar_encerrados_omie (único writer de purchase_orders_tracking.encerrado_omie_em).
# Executa a migration REAL contra um stub mínimo da tabela e afirma:
#  • marca o conjunto, 1ª vez vista (re-rodar não move o carimbo);
#  • limpa o reaberto SÓ com previsão dentro da janela (fora da janela/previsão nula ficam);
#  • encerrado fora do espelho → SQLSTATE P0002 e NADA muda (atômico); nCodPed nulo/≤0 → 22023;
#  • a outra empresa não é tocada;
#  • ACL: anon/authenticated sem EXECUTE, service_role executa.
#
#   bash db/test-encerrados-omie.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   bash db/test-encerrados-omie.sh --falsificar    # controle verde + cada sabotagem tem de ficar VERMELHA
#   LC_TESTE=pt_BR.UTF-8 bash db/test-encerrados-omie.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="${MIG_ENCERRADOS:-$REPO_ROOT/supabase/migrations/20261018092000_pedido_compra_encerrado_omie.sql}"
export LC_ALL="${LC_TESTE:-C}" LANG="${LC_TESTE:-C}"

if [ "${1:-}" = "--falsificar" ]; then
  TMPD="$(mktemp -d "/tmp/falsif-encerrados.XXXXXX")"
  trap 'rm -rf "$TMPD"' EXIT
  ORIG="$REPO_ROOT/supabase/migrations/20261018092000_pedido_compra_encerrado_omie.sql"
  # CONTROLE na MESMA invocação: a cópia intacta tem de ficar VERDE (senão "sempre vermelho" aprovaria tudo)
  cp "$ORIG" "$TMPD/controle.sql"
  if ! MIG_ENCERRADOS="$TMPD/controle.sql" PGPORT_TEST=5481 bash "$0" > "$TMPD/controle.log" 2>&1; then
    echo "FALSIFICACAO ABORTADA: controle intacto ficou vermelho"; tail -20 "$TMPD/controle.log"; exit 1
  fi
  echo "controle verde ($(grep -c 'OK ' "$TMPD/controle.log") asserts)"
  sabota() { # nome, expressão sed
    cp "$ORIG" "$TMPD/$1.sql"
    sed -i '' "$2" "$TMPD/$1.sql"
    if cmp -s "$ORIG" "$TMPD/$1.sql"; then echo "SABOTAGEM INERTE: $1 (sed não casou)"; exit 1; fi
    if MIG_ENCERRADOS="$TMPD/$1.sql" PGPORT_TEST=5482 bash "$0" > "$TMPD/$1.log" 2>&1; then
      echo "SABOTAGEM VERDE: $1 — a prova não a pega"; exit 1
    fi
    echo "vermelho como esperado: $1 ($(grep -m1 'FALHA ' "$TMPD/$1.log" || tail -1 "$TMPD/$1.log"))"
  }
  sabota sem-janela      's/AND t.data_previsao_original BETWEEN p_janela_de AND p_janela_ate/AND true/'
  sabota re-carimba      's/AND t.encerrado_omie_em IS NULL;/;/'
  sabota sem-ausentes    's/IF v_ausentes > 0 THEN/IF false THEN/'
  sabota sem-revoke      's/FROM PUBLIC, anon, authenticated;/FROM PUBLIC;/'
  sabota outra-empresa   's/WHERE t.empresa = p_empresa$/WHERE true/'
  echo "FALSIFICACAO OK"
  exit 0
fi

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5480}"
SLUG="encerrados-omie-$PORT"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHA $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 - esperado [$3], veio [$2]"; fi; }

# Supabase concede EXECUTE a anon/authenticated por DEFAULT PRIVILEGE — sem isto o REVOKE seria teatro
P -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"
P <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN', 'COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id bigserial PRIMARY KEY,
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  data_previsao_original date,
  updated_at timestamptz,
  UNIQUE (empresa, omie_codigo_pedido)
);
GRANT ALL ON public.purchase_orders_tracking TO service_role;
INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido, data_previsao_original) VALUES
  ('OBEN', 1014, '2026-05-21'), ('OBEN', 1049, '2026-05-27'), ('OBEN', 2000, '2026-10-20'),
  ('OBEN', 3000, '2024-01-10'), ('OBEN', 4000, NULL), ('COLACOR', 1014, '2026-05-21');
SQL

echo "== aplica a migration =="
P -f "$MIG" >/dev/null
eq "re-colar a migration é idempotente" "$(P -f "$MIG" >/dev/null 2>&1 && echo ok || echo erro)" "ok"

J="'2025-10-18'::date, '2027-02-15'::date"
run() { Pq -c "SET ROLE service_role; SELECT public.reposicao_marcar_encerrados_omie('$1', $2, $J)::text;" | tail -1; }
marcado() { Pq -c "SELECT coalesce(encerrado_omie_em::text, 'null') FROM public.purchase_orders_tracking WHERE empresa='$1' AND omie_codigo_pedido=$2;"; }

echo "== marca =="
eq "1a passada marca 2 novos" "$(run OBEN "ARRAY[1014,1049]::bigint[]")" '{"novos": 2, "limpos": 0, "marcados": 2}'
C1="$(marcado OBEN 1014)"
[ "$C1" != "null" ] && ok "1014 carimbado" || bad "1014 nao carimbado"
eq "pedido aberto na janela segue null" "$(marcado OBEN 2000)" "null"
eq "outra empresa (COLACOR 1014) intocada" "$(marcado COLACOR 1014)" "null"
sleep 1
eq "re-rodar nao cria novos" "$(run OBEN "ARRAY[1014,1049]::bigint[]")" '{"novos": 0, "limpos": 0, "marcados": 2}'
eq "carimbo da 1a vez preservado" "$(marcado OBEN 1014)" "$C1"

echo "== reaberto =="
P -c "UPDATE public.purchase_orders_tracking SET encerrado_omie_em = now() WHERE omie_codigo_pedido IN (3000, 4000) AND empresa='OBEN';"
eq "1049 some da passada: limpo; fora da janela e previsao nula ficam" "$(run OBEN "ARRAY[1014]::bigint[]")" '{"novos": 0, "limpos": 1, "marcados": 3}'
eq "1049 voltou a null" "$(marcado OBEN 1049)" "null"
[ "$(marcado OBEN 3000)" != "null" ] && ok "3000 (previsao fora da janela) mantido" || bad "3000 limpo sem cobertura"
[ "$(marcado OBEN 4000)" != "null" ] && ok "4000 (previsao nula) mantido" || bad "4000 limpo sem cobertura"

echo "== recusas (SQLSTATE exata, resto re-lança) =="
P -c "CREATE TABLE public._r (s text); GRANT ALL ON public._r TO service_role;"
recusa() { # sqlstate, ids
  P -c "TRUNCATE public._r;"
  P -c "SET ROLE service_role; DO \$\$ BEGIN PERFORM public.reposicao_marcar_encerrados_omie('OBEN', $2, $J); RAISE EXCEPTION 'NAO_LANCOU'; EXCEPTION WHEN SQLSTATE '$1' THEN INSERT INTO public._r VALUES ('$1'); END \$\$;" >/dev/null 2>&1 || true
  Pq -c "SELECT coalesce(max(s), 'nada') FROM public._r;"
}
eq "encerrado fora do espelho recusa com P0002" "$(recusa P0002 "ARRAY[1014,1049,999]::bigint[]")" "P0002"
eq "recusa e atomica: 1049 nao marcado" "$(marcado OBEN 1049)" "null"
eq "nCodPed nulo recusa com 22023" "$(recusa 22023 "ARRAY[1014,NULL]::bigint[]")" "22023"
eq "nCodPed negativo recusa com 22023" "$(recusa 22023 "ARRAY[-5]::bigint[]")" "22023"

echo "== ACL =="
FN="public.reposicao_marcar_encerrados_omie(public.empresa_reposicao,bigint[],date,date)"
eq "anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
eq "authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "fim ok"
