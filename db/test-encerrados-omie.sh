#!/usr/bin/env bash
# PROVA PG17 — reposicao_registrar_encerrados_omie (único writer de purchase_orders_tracking.encerrado_omie_em
# e de reposicao_encerrados_omie_publicacao). Executa a migration REAL contra um stub mínimo e afirma:
#  • habilitado=false (default): a passada só é OBSERVADA — registra o conjunto, a coluna não muda;
#  • habilitado=true: marca o conjunto (1ª vez vista; re-publicar não move o carimbo) e limpa TODO o
#    resto da empresa, inclusive marca sem cobertura (previsão nula / fora da janela);
#  • fencing: seq ≤ o aceito é 'obsoleto' e não toca nada; o habilitado nunca é sobrescrito pela RPC;
#  • encerrado fora do espelho → SQLSTATE P0002 e NADA muda (atômico); nCodPed nulo/≤0 ou seq ≤0 → 22023;
#  • a outra empresa não é tocada;
#  • ACL: anon/authenticated sem EXECUTE nem UPDATE na publicação, service_role executa.
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
  sabota sem-fencing     's/IF FOUND AND p_seq <= v_atual.seq THEN/IF false THEN/'
  sabota sem-habilitacao 's/v_habilitado := coalesce(v_atual.habilitado, false);/v_habilitado := true;/'
  sabota limpa-so-janela 's/AND NOT (t.omie_codigo_pedido = ANY (p_ids));/AND NOT (t.omie_codigo_pedido = ANY (p_ids)) AND t.data_previsao_original IS NOT NULL;/'
  sabota re-carimba      's/AND t.encerrado_omie_em IS NULL;/;/'
  sabota sem-ausentes    's/IF v_ausentes > 0 THEN/IF false THEN/'
  sabota sem-revoke      's/FROM PUBLIC, anon, authenticated;/FROM PUBLIC;/'
  sabota outra-empresa   's/WHERE t.empresa = p_empresa$/WHERE true/'
  sabota sobrescreve-hab 's/novos = EXCLUDED.novos, limpos = EXCLUDED.limpos, publicado_em = EXCLUDED.publicado_em;/novos = EXCLUDED.novos, limpos = EXCLUDED.limpos, publicado_em = EXCLUDED.publicado_em, habilitado = false;/'
  sabota tent-sem-fencing 's/IF p_seq IS NOT NULL AND (p_seq < v_atual.seq OR/IF false AND (p_seq < v_atual.seq OR/'
  sabota fecha-2-vezes   "s/OR (p_seq = v_atual.seq AND v_atual.status <> 'coletando'))/)/"
  sabota tent-sem-revoke 's/^  FROM PUBLIC, anon, authenticated;$/  FROM PUBLIC;/'
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

# Supabase concede EXECUTE a anon/authenticated por DEFAULT PRIVILEGE — sem isto o REVOKE seria teatro.
# E o service_role do Supabase tem BYPASSRLS (medido em prod 2026-10-18).
P -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"
P -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;"
P -c "ALTER ROLE service_role BYPASSRLS;"
P <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
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
run() { Pq -c "SET ROLE service_role; SELECT public.reposicao_registrar_encerrados_omie('$1', $2, $3, $J)::text;" | tail -1; }
marcado() { Pq -c "SELECT coalesce(encerrado_omie_em::text, 'null') FROM public.purchase_orders_tracking WHERE empresa='$1' AND omie_codigo_pedido=$2;"; }
pub() { Pq -c "SELECT coalesce((SELECT $1::text FROM public.reposicao_encerrados_omie_publicacao WHERE empresa='OBEN'), 'sem-linha');"; }
nmarcados() { Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE encerrado_omie_em IS NOT NULL;"; }

echo "== observado (habilitado=false, o default) =="
eq "1a passada so observa" "$(run OBEN 10 "ARRAY[1049,1014]::bigint[]")" '{"novos": null, "limpos": null, "status": "observado"}'
eq "nenhuma marca na coluna" "$(nmarcados)" "0"
eq "conjunto observado registrado (ordenado)" "$(pub ids)" "{1014,1049}"
eq "status observado" "$(pub status)" "observado"
eq "publicado_em nulo" "$(pub "coalesce(publicado_em::text,'null')")" "null"

echo "== habilita a mao e publica =="
P -c "UPDATE public.reposicao_encerrados_omie_publicacao SET habilitado = true WHERE empresa='OBEN';"
eq "publica 2 novos" "$(run OBEN 11 "ARRAY[1014,1049]::bigint[]")" '{"novos": 2, "limpos": 0, "status": "publicado"}'
C1="$(marcado OBEN 1014)"
[ "$C1" != "null" ] && ok "1014 carimbado" || bad "1014 nao carimbado"
eq "pedido aberto segue null" "$(marcado OBEN 2000)" "null"
eq "outra empresa (COLACOR 1014) intocada" "$(marcado COLACOR 1014)" "null"
eq "habilitado preservado pela RPC" "$(pub habilitado)" "true"
sleep 1
eq "re-publicar nao cria novos" "$(run OBEN 12 "ARRAY[1014,1049]::bigint[]")" '{"novos": 0, "limpos": 0, "status": "publicado"}'
eq "carimbo da 1a vez preservado" "$(marcado OBEN 1014)" "$C1"

echo "== fencing =="
eq "seq menor e obsoleto" "$(run OBEN 5 "ARRAY[2000]::bigint[]")" '{"status": "obsoleto", "seq_aceito": 12}'
eq "seq igual e obsoleto" "$(Pq -c "SET ROLE service_role; SELECT public.reposicao_registrar_encerrados_omie('OBEN', 12, ARRAY[2000]::bigint[], $J)->>'status';" | tail -1)" "obsoleto"
eq "obsoleto nao marca 2000" "$(marcado OBEN 2000)" "null"
eq "obsoleto nao troca o conjunto" "$(pub ids)" "{1014,1049}"

echo "== coluna = conjunto atual (limpa sem cobertura) =="
P -c "UPDATE public.purchase_orders_tracking SET encerrado_omie_em = now() WHERE omie_codigo_pedido IN (3000, 4000) AND empresa='OBEN';"
eq "1049, 3000 (fora da janela) e 4000 (previsao nula) limpos" "$(run OBEN 13 "ARRAY[1014]::bigint[]")" '{"novos": 0, "limpos": 3, "status": "publicado"}'
eq "1049 voltou a null" "$(marcado OBEN 1049)" "null"
eq "4000 voltou a null" "$(marcado OBEN 4000)" "null"
eq "so 1014 marcado" "$(nmarcados)" "1"

echo "== tentativa (coletando / invalidado) =="
tent() { Pq -c "SET ROLE service_role; SELECT public.reposicao_tentativa_encerrados_omie('OBEN', $1, '$2', 'motivo x')->>'status';" | tail -1; }
eq "abre tentativa com seq novo" "$(tent 14 coletando)" "coletando"
eq "registro sai de publicado enquanto coleta" "$(pub status)" "coletando"
eq "coletando com o mesmo seq e obsoleto" "$(tent 14 coletando)" "obsoleto"
eq "registrar fecha a propria tentativa" "$(run OBEN 14 "ARRAY[1014]::bigint[]")" '{"novos": 0, "limpos": 0, "status": "publicado"}'
eq "re-registrar o mesmo seq ja fechado e obsoleto" "$(Pq -c "SET ROLE service_role; SELECT public.reposicao_registrar_encerrados_omie('OBEN', 14, ARRAY[1014]::bigint[], $J)->>'status';" | tail -1)" "obsoleto"
eq "abre seq 15" "$(tent 15 coletando)" "coletando"
eq "invalidado de seq velho e obsoleto" "$(tent 14 invalidado)" "obsoleto"
eq "invalida a propria tentativa" "$(tent 15 invalidado)" "invalidado"
eq "registro invalidado com motivo" "$(pub "status || ':' || motivo")" "invalidado:motivo x"
eq "invalidar nao mexe na coluna" "$(nmarcados)" "1"
eq "sem token invalida sem condicao" "$(tent NULL invalidado)" "invalidado"
eq "seq preservado quando invalida sem token" "$(pub seq)" "15"
eq "coletando sem token recusa" "$(Pq -c "SET ROLE service_role; DO \$\$ BEGIN PERFORM public.reposicao_tentativa_encerrados_omie('OBEN', NULL, 'coletando', 'x'); EXCEPTION WHEN SQLSTATE '22023' THEN RAISE NOTICE 'ok'; END \$\$; SELECT 'recusou';" | tail -1)" "recusou"
eq "1a tentativa sem linha cria o registro" "$(Pq -c "SET ROLE service_role; SELECT public.reposicao_tentativa_encerrados_omie('COLACOR', 3, 'coletando', NULL)->>'status';" | tail -1)" "coletando"

echo "== recusas (SQLSTATE exata, resto re-lança) =="
P -c "CREATE TABLE public._r (s text); GRANT ALL ON public._r TO service_role;"
recusa() { # sqlstate, seq, ids
  P -c "TRUNCATE public._r;"
  P -c "SET ROLE service_role; DO \$\$ BEGIN PERFORM public.reposicao_registrar_encerrados_omie('OBEN', $2, $3, $J); RAISE EXCEPTION 'NAO_LANCOU'; EXCEPTION WHEN SQLSTATE '$1' THEN INSERT INTO public._r VALUES ('$1'); END \$\$;" >/dev/null 2>&1 || true
  Pq -c "SELECT coalesce(max(s), 'nada') FROM public._r;"
}
eq "encerrado fora do espelho recusa com P0002" "$(recusa P0002 20 "ARRAY[1014,1049,999]::bigint[]")" "P0002"
eq "recusa e atomica: 1049 nao marcado" "$(marcado OBEN 1049)" "null"
eq "recusa e atomica: seq aceito segue 15" "$(pub seq)" "15"
eq "nCodPed nulo recusa com 22023" "$(recusa 22023 21 "ARRAY[1014,NULL]::bigint[]")" "22023"
eq "nCodPed negativo recusa com 22023" "$(recusa 22023 22 "ARRAY[-5]::bigint[]")" "22023"
eq "seq zero recusa com 22023" "$(recusa 22023 0 "ARRAY[1014]::bigint[]")" "22023"

echo "== ACL =="
FN="public.reposicao_registrar_encerrados_omie(public.empresa_reposicao,bigint,bigint[],date,date)"
TB="public.reposicao_encerrados_omie_publicacao"
eq "anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
eq "authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"
eq "authenticated sem UPDATE na publicacao" "$(Pq -c "SELECT has_table_privilege('authenticated','$TB','UPDATE');")" "f"
FN2="public.reposicao_tentativa_encerrados_omie(public.empresa_reposicao,bigint,text,text)"
eq "authenticated sem EXECUTE na tentativa" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN2','EXECUTE');")" "f"
eq "RLS ligada na publicacao" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='$TB'::regclass;")" "t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "fim ok"
