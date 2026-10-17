#!/usr/bin/env bash
# PROVA PG17 — sombra da associação NF↔PO (20261017040000_recebimento_associacao_sombra.sql)
#
#   I  a migration aplica com a postcondição OK (I0), re-aplicar é seguro (I1) e re-aplicar sobre uma policy extra
#      de leitura aborta na postcondição (I2)
#   A  a RPC grava (A1); mesma observação ou mais velha NÃO sobrescreve — compare-and-set (A2 A3); mais nova
#      sobrescreve (A4); o CHECK recusa associável com motivo (A5) e não-associável com par (A6); payload nulo → 22023
#      (A7); campo AUSENTE (motivos A8, pares A9) → 22023, nunca array vazio
#   R  RLS: authenticated sem papel vê 0 (R1); employee vê (R2); anon é negado no GRANT (R3)
#   W  ninguém além da RPC escreve: authenticated (W1) e service_role (W2) levam 42501
#   X  EXECUTE da RPC: authenticated (X1) e anon (X2) levam 42501
#   P  a POSTCONDIÇÃO tem dente: cópias da migration com UM defeito cada abortam (P1-P4)
#
# Uso: bash db/test-recebimento-associacao-sombra.sh            # suíte
#      bash db/test-recebimento-associacao-sombra.sh --falsificar  # controle + cada sabotagem tem de ficar vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5851}"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261017040000_recebimento_associacao_sombra.sql"
TOTAL_ESPERADO=20

# ── --falsificar: controle primeiro, na MESMA invocação. SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que
# TÊM de acusar a sabotagem (`ID!MARCA`: o vermelho tem de trazer a marca do motivo declarado) e os que TÊM de seguir
# verdes. Verde só conta com a linha VERDE explícita, e o filho só conta se chegou ao RESUMO (ausência de VERMELHO
# não é aprovação; Codex 2026-10-17). Comportamento é sabotado no BANCO depois da migration real; a postcondição,
# numa CÓPIA da migration — uma camada por vez.
SABOTAGENS="sem_cas:A2,A3:A1,A4 cas_invertido:A4:A1 check_aberto:A5,A6:A1 rls_aberta:R1:R2,R3
            escrita_staff:W1:W2,X1 escrita_service:W2:W1 execute_aberto:X1:X2 rpc_aceita_ausente:A8,A9:A1,A7
            pc_policy_extra_aceita:I2!reaplicou:I0,I1,R1 pc_sem_rls:I0!RLS pc_sem_cas:I0!SECURITY
            pc_execute_aberto:I0!EXECUTE pc_sem_check:I0!CHECK"
if [ "${1:-}" = "--falsificar" ]; then
  falhas=0
  rodar() {  # <nome> <porta> → as linhas de veredito do filho
    PGPORT_TEST="$2" SABOTAGEM="$1" bash "$0" 2>&1 | grep -E '^(RESUMO|VERDE|VERMELHO|ERRO)' || true
  }
  ctl="$(rodar "" 5852)"
  if ! printf '%s\n' "$ctl" | grep -q "^RESUMO verdes=$TOTAL_ESPERADO vermelhos=0$"; then
    echo "CONTROLE NÃO VERDE — falsificação inválida:"; printf '%s\n' "$ctl"; exit 1
  fi
  echo "controle: $TOTAL_ESPERADO/$TOTAL_ESPERADO verdes"
  porta=5853
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    out="$(rodar "$sab" "$porta")"; porta=$((porta + 1))
    motivo=""
    printf '%s\n' "$out" | grep -q '^RESUMO ' || motivo="$motivo o filho não chegou ao RESUMO (abortou antes de provar);"
    for decl in ${verm//,/ }; do
      id="${decl%%!*}"; marca=""
      [ "$id" = "$decl" ] || marca="${decl#*!}"
      linha_v="$(printf '%s\n' "$out" | grep -m1 "^VERMELHO $id " || true)"
      if [ -z "$linha_v" ]; then motivo="$motivo $id deveria ficar VERMELHO;"
      elif [ -n "$marca" ] && ! printf '%s' "$linha_v" | grep -qF -- "$marca"; then motivo="$motivo $id vermelho pelo motivo errado (sem '$marca');"
      fi
    done
    for id in ${verdes//,/ }; do
      printf '%s\n' "$out" | grep -q "^VERDE $id\$" || motivo="$motivo $id deveria seguir VERDE (linha VERDE ausente);"
    done
    if [ -z "$motivo" ]; then echo "sabotagem $sab: tem dente ($verm)"; else falhas=$((falhas + 1)); echo "sabotagem $sab:$motivo"; printf '%s\n' "$out"; fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "FALSIFICACAO-OK"; exit 0; fi
  echo "FALSIFICACAO REPROVOU: $falhas sabotagem(ns) sem dente"; exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-assoc-sombra.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q() { Pdb -At -q -c "$1" 2>&1 | tail -n 1; }

trocar() {  # <entrada> <saída> <de> <para> — o padrão tem de ocorrer EXATAMENTE 1x (troca que não pegou é erro)
  python3 - "$@" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(de) != 1:
    sys.exit('padrao ocorre %dx (esperado 1): %r' % (s.count(de), de))
open(dst, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';"
Pdb -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
-- devolve a SQLSTATE como VALOR: o assert compara EXATO (erro inesperado reprova, ≠ WHEN OTHERS THEN 'OK')
CREATE OR REPLACE FUNCTION public._prova(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, 'NULL');
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public._prova(text) TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
INSERT INTO public.user_roles (user_id, role) VALUES ('a0000000-0000-4000-8000-000000000001', 'employee');
SQL
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER ROLE service_role BYPASSRLS;"

verdes=0; vermelhos=0
ok() {  # <id> <esperado> <obtido>
  if [ "$2" = "$3" ]; then verdes=$((verdes + 1)); echo "VERDE $1"; else vermelhos=$((vermelhos + 1)); echo "VERMELHO $1 esperado=[$2] obtido=[$3]"; fi
}

# ── I — a migration (real ou sabotada) aplica e re-aplica ──
MIG_USADA="$MIG"
case "$SABOTAGEM" in
  pc_sem_rls) trocar "$MIG" "$TMPD/m.sql" 'ALTER TABLE public.recebimento_associacao_sombra ENABLE ROW LEVEL SECURITY;' '-- sabotado' ;;
  pc_sem_cas) trocar "$MIG" "$TMPD/m.sql" '  WHERE s.observado_em < EXCLUDED.observado_em;' '  ;' ;;
  pc_execute_aberto) trocar "$MIG" "$TMPD/m.sql" 'REVOKE ALL ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) FROM authenticated;' '-- sabotado' ;;
  pc_sem_check) trocar "$MIG" "$TMPD/m.sql" 'AND jsonb_array_length(pares) > 0 AND jsonb_array_length(pedidos) > 0' 'AND true' ;;
esac
MIG_I2="$MIG"
if [ "$SABOTAGEM" = pc_policy_extra_aceita ]; then  # só a cópia usada no I2: o I0/I1 seguem com a migration real
  trocar "$MIG" "$TMPD/m2.sql" '     OR (SELECT count(*) FROM pg_policy WHERE polrelid = v_tab) <> 1 THEN' '     THEN'
  MIG_I2="$TMPD/m2.sql"
fi
[ -f "$TMPD/m.sql" ] && MIG_USADA="$TMPD/m.sql"
if Pdb -q -f "$MIG_USADA" >"$TMPD/i0.log" 2>&1 && grep -q "POSTCONDICAO OK" "$TMPD/i0.log"; then ok I0 aplicou aplicou; else ok I0 aplicou "falhou: $(grep -m1 -E 'ERROR|EXCEPTION' "$TMPD/i0.log" | cut -c1-400)"; fi
if [ "${MIG_USADA}" != "$MIG" ]; then  # sabotagem de postcondição: só o I0 importa
  echo "RESUMO verdes=$verdes vermelhos=$vermelhos"; exit 0
fi
if Pdb -q -f "$MIG" >"$TMPD/i1.log" 2>&1; then ok I1 reaplicou reaplicou; else ok I1 reaplicou falhou; fi

# ── sabotagens de COMPORTAMENTO, aplicadas no banco depois da migration real ──
# shellcheck disable=SC2016  # '$fn$' é o delimitador literal do corpo da função, não expansão
case "$SABOTAGEM" in
  sem_cas)  Pdb -q -c "$(sed -n '/^CREATE OR REPLACE FUNCTION public.recebimento_associacao_sombra_publicar/,/^\$fn\$;/p' "$MIG" | sed 's/  WHERE s.observado_em < EXCLUDED.observado_em;/  ;/')" ;;
  cas_invertido) Pdb -q -c "$(sed -n '/^CREATE OR REPLACE FUNCTION public.recebimento_associacao_sombra_publicar/,/^\$fn\$;/p' "$MIG" | sed 's/WHERE s.observado_em < EXCLUDED.observado_em/WHERE s.observado_em > EXCLUDED.observado_em/')" ;;
  check_aberto) Pdb -q -c "ALTER TABLE public.recebimento_associacao_sombra DROP CONSTRAINT recebimento_associacao_sombra_proposta_check;" ;;
  rls_aberta) Pdb -q -c "ALTER TABLE public.recebimento_associacao_sombra DISABLE ROW LEVEL SECURITY;" ;;
  escrita_staff) Pdb -q -c "GRANT INSERT ON public.recebimento_associacao_sombra TO authenticated; CREATE POLICY ins ON public.recebimento_associacao_sombra FOR INSERT WITH CHECK (true);" ;;
  escrita_service) Pdb -q -c "GRANT INSERT ON public.recebimento_associacao_sombra TO service_role;" ;;
  execute_aberto) Pdb -q -c "GRANT EXECUTE ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) TO authenticated;" ;;
  rpc_aceita_ausente) Pdb -q -c "$(sed -n '/^CREATE OR REPLACE FUNCTION public.recebimento_associacao_sombra_publicar/,/^\$fn\$;/p' "$MIG" | sed "s/ IS DISTINCT FROM 'array'/ <> 'array'/g")" ;;
esac

linha() {  # <nid> <observado_em> <classe> <motivos-json> <pares-json> <pedidos-json>
  printf '{"empresa":"OBEN","nid_receb":%s,"numero_nfe":"000955263","fornecedor_codigo_omie":8689681266,"estado_nf":"pendente","vinculo":"nenhum","classe":"%s","motivos":%s,"contratos":["2138394"],"pares":%s,"pedidos":%s,"versao_classificador":"assoc-sombra-v2","observado_em":"%s"}' \
    "$1" "$3" "$4" "$5" "$6" "$2"
}
PAR='[{"nSequencia":1,"nIdPedido":9001,"nIdItPedido":77,"quantidade":2,"unidade":"GL"}]'
PED='[{"nIdPedido":9001,"numero_pedido":"1263","cobertura":"total"}]'
pub() { Q "SET ROLE service_role; SELECT public._prova(\$q\$SELECT public.recebimento_associacao_sombra_publicar('$1'::jsonb)\$q\$);"; }

# ── A — compare-and-set e CHECK ──
ok A1 gravada "$(pub "$(linha 100 2026-10-17T10:00:00Z associavel '[]' "$PAR" "$PED")")"
ok A2 leitura_velha "$(pub "$(linha 100 2026-10-17T10:00:00Z ambigua '["item_sem_par"]' '[]' '[]')")"
ok A3 "leitura_velha|associavel" "$(pub "$(linha 100 2026-10-17T09:00:00Z ambigua '["item_sem_par"]' '[]' '[]')")|$(Q "SELECT classe FROM public.recebimento_associacao_sombra WHERE nid_receb = 100")"
ok A4 "gravada|ambigua" "$(pub "$(linha 100 2026-10-17T11:00:00Z ambigua '["item_sem_par"]' '[]' '[]')")|$(Q "SELECT classe FROM public.recebimento_associacao_sombra WHERE nid_receb = 100")"
ok A5 SQLSTATE:23514 "$(pub "$(linha 101 2026-10-17T10:00:00Z associavel '["x"]' "$PAR" "$PED")")"
ok A6 SQLSTATE:23514 "$(pub "$(linha 102 2026-10-17T10:00:00Z ambigua '["x"]' "$PAR" "$PED")")"
ok A7 SQLSTATE:22023 "$(Q "SET ROLE service_role; SELECT public._prova(\$q\$SELECT public.recebimento_associacao_sombra_publicar(NULL)\$q\$);")"
sem() {  # <campo> — payload associável VÁLIDO menos um campo
  Q "SET ROLE service_role; SELECT public._prova(\$q\$SELECT public.recebimento_associacao_sombra_publicar('$(linha 103 2026-10-17T10:00:00Z associavel '[]' "$PAR" "$PED")'::jsonb - '$1')\$q\$);"
}
ok A8 SQLSTATE:22023 "$(sem motivos)"
ok A9 SQLSTATE:22023 "$(sem pares)"

# ── R — RLS ──
ok R1 0 "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-0000000000ff'; SELECT count(*) FROM public.recebimento_associacao_sombra;")"
ok R2 1 "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-000000000001'; SELECT count(*) FROM public.recebimento_associacao_sombra;")"
ok R3 SQLSTATE:42501 "$(Q "SET ROLE anon; SELECT public._prova('SELECT count(*)::text FROM public.recebimento_associacao_sombra');")"

# ── W / X — 1 writer ──
INS="INSERT INTO public.recebimento_associacao_sombra (empresa, nid_receb, estado_nf, vinculo, classe, motivos, contratos, pares, pedidos, versao_classificador, observado_em) VALUES (''OBEN'', 900, ''pendente'', ''nenhum'', ''ambigua'', ARRAY[''x''], ARRAY[]::text[], ''[]'', ''[]'', ''v'', now()) RETURNING ''inseriu''"
ok W1 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-000000000001'; SELECT public._prova('$INS');")"
ok W2 SQLSTATE:42501 "$(Q "SET ROLE service_role; SELECT public._prova('$INS');")"
ok X1 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SELECT public._prova(\$q\$SELECT public.recebimento_associacao_sombra_publicar('{}'::jsonb)\$q\$);")"
ok X2 SQLSTATE:42501 "$(Q "SET ROLE anon; SELECT public._prova(\$q\$SELECT public.recebimento_associacao_sombra_publicar('{}'::jsonb)\$q\$);")"

# ── I2 — policy de leitura extra (USING true) sobrevive à reaplicação? a postcondição tem de abortar ──
Pdb -q -c "CREATE POLICY extra_aberta ON public.recebimento_associacao_sombra FOR SELECT USING (true);"
if Pdb -q -f "$MIG_I2" >"$TMPD/i2.log" 2>&1; then i2="reaplicou"; else i2="$(grep -m1 -oE 'POSTCONDICAO FALHOU' "$TMPD/i2.log" || echo outro_erro)"; fi
ok I2 "POSTCONDICAO FALHOU" "$i2"
Pdb -q -c "DROP POLICY extra_aberta ON public.recebimento_associacao_sombra;"

# ── P — postcondição com dente é provada pelo --falsificar (pc_*); aqui conta o I0 da migration real ──
ok P0 "POSTCONDICAO OK" "$(grep -o 'POSTCONDICAO OK' "$TMPD/i0.log" | head -n 1)"

total=$((verdes + vermelhos))
if [ "$total" -ne "$TOTAL_ESPERADO" ]; then echo "ERRO asserts=$total esperado=$TOTAL_ESPERADO"; vermelhos=$((vermelhos + 1)); fi
echo "RESUMO verdes=$verdes vermelhos=$vermelhos"
echo "PASS=$verdes  FAIL=$vermelhos"
[ "$vermelhos" -eq 0 ] && echo "PROVA-ASSOC-SOMBRA-OK"
[ "$vermelhos" -eq 0 ]
