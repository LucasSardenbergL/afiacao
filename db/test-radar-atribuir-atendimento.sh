#!/usr/bin/env bash
# test-radar-atribuir-atendimento.sh — prova EXECUTADA (PG17) da 20261106221000_radar_atribuir_atendimento.sql: o
# gestor/master passa o lead a um vendedor (`radar_atribuir_atendimento`), com o gate server-side de gestor, o
# registro de quem atribuiu (`atribuido_por` + `encerrado_por`/`reatribuido` na posse anterior), o teto de 100 do
# DESTINO, a recusa de destino fora da capability e de já-cliente, e a lista `radar_vendedores_atribuiveis`.
#
# Monta o MESMO schema de produção da db/test-radar-acesso-vendedor.sh (snapshot + ACL medido + retrato de prod de
# 2026-10-29 conferido por md5 + a cadeia viva). A cadeia pega a 20261029201200 (cria radar_atendimentos) E esta
# migration (toca a tabela guardada), nesta ordem — é o arquivo REAL que roda.
#
# Uso:
#   bash db/test-radar-atribuir-atendimento.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-radar-atribuir-atendimento.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5497}"
TMPD="$(mktemp -d /tmp/pgtest-radar-atribuir.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
MIG="$REPO_ROOT/supabase/migrations/20261106221000_radar_atribuir_atendimento.sql"
[ -f "$FIXTURE" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }

# Objetos desta entrega + os da 20261029201200 de que ela depende (a cadeia dinâmica seleciona as migrations que os tocam).
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar radar_atendimento_expira_em radar_definir_atendimento radar_atendimentos_ativos
            radar_atribuir_atendimento radar_vendedores_atribuiveis)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(radar_atendimentos)
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  # Mesmo artefato do harness irmão: o snapshot de 15/10 ainda tem a contagem de 8 parâmetros (prod só tem a de 10).
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + retrato de 29/10 + cadeia (20261029201200 → esta)…"
cv_montar

# A migration desta entrega TEM de estar na cadeia (senão a prova exercitaria nada).
[ "$(P -tA -q -c "SELECT to_regprocedure('public.radar_atribuir_atendimento(text,uuid)') IS NOT NULL")" = t ] \
  || { echo "❌ a cadeia não aplicou 20261106221000 (radar_atribuir_atendimento ausente)"; exit 1; }

MASTER='00000000-0000-0000-0000-00000000a001'
GER='00000000-0000-0000-0000-00000000a002'     # employee + gerencial
FARM='00000000-0000-0000-0000-00000000a003'    # employee + farmer ("Vendedor Um")
FARM2='00000000-0000-0000-0000-00000000a004'   # employee + farmer ("Vendedor Dois")
FARM3='00000000-0000-0000-0000-00000000a005'   # employee + hunter ("Vendedor Tres": no teto de 100)
OPER='00000000-0000-0000-0000-00000000a006'    # employee + operacional: fora da capability
CLI='00000000-0000-0000-0000-00000000a008'     # customer
L1='11111111000101'; L2='22222222000102'; L3='33333333000103'; L4='44444444000104'; L5='55555555000105'
L6='66666666000106'; L7='77777777000107'

echo "→ seed: papéis, leads, 100 posses do Vendedor Tres…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$FARM2'),('$FARM3'),('$OPER'),('$CLI');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER','master'),('$GER','employee'),('$FARM','employee'),('$FARM2','employee'),('$FARM3','employee'),
  ('$OPER','employee'),('$CLI','customer');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer'),('$FARM2','farmer'),('$FARM3','hunter'),('$OPER','operacional');
INSERT INTO public.profiles (user_id, name) VALUES
  ('$MASTER','Lucas'),('$FARM','Vendedor Um'),('$FARM2','Vendedor Dois'),('$FARM3','Vendedor Tres'),('$GER','Gestor'),
  ('$OPER','Operador'),('$CLI','Cliente');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente) VALUES
  ('$L1','LEAD UM','4744005','2026-10',false), ('$L2','LEAD DOIS','4744005','2026-10',false),
  ('$L3','LEAD TRES','4744005','2026-10',false), ('$L4','CLIENTE QUATRO','4744005','2026-10',true),
  ('$L5','LEAD CINCO','4744005','2026-10',false), ('$L6','LEAD SEIS','4744005','2026-10',false),
  ('$L7','LEAD SETE','4744005','2026-10',false);
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente)
SELECT lpad((70000000 + g)::text, 8, '0') || '000199', 'EXTRA ' || g, '4744005', '2026-10', false
  FROM generate_series(1, 100) g;
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em)
SELECT lpad((70000000 + g)::text, 8, '0') || '000199', '$FARM3', now() FROM generate_series(1, 100) g;
-- L5: posse EXPIRADA do Vendedor Dois (assumida há 10 dias, sem toque).
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L5', '$FARM2', now() - interval '10 days');
-- L6: posse de quem PERDEU o acesso (operacional).
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L6', '$OPER', now());
COMMIT;
CREATE SCHEMA IF NOT EXISTS prova;
-- SQLSTATE + o começo da mensagem: distingue o gate do Radar ('forbidden: radar_prospectar') do de gestor.
CREATE OR REPLACE FUNCTION prova.erro(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ':' || left(SQLERRM, 40); END \$f\$;
GRANT USAGE ON SCHEMA prova TO authenticated, anon;
GRANT EXECUTE ON FUNCTION prova.erro(text) TO authenticated, anon;
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — a leitura COMO o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
# erro_como <uid> <sql> — 'OK' ou 'SQLSTATE:mensagem' (o ramo exato que recusou).
erro_como() { q_como authenticated "$1" "SELECT prova.erro(\$cmd\$$2\$cmd\$);"; }
atribuir() {  # <uid> <cnpj> <dono> <campo do jsonb>
  q_como authenticated "$1" "SELECT public.radar_atribuir_atendimento('$2', '$3')->>'$4'"
}
dono_aberto() { P -tA -q -c "SELECT COALESCE((SELECT dono_user_id::text FROM public.radar_atendimentos WHERE cnpj='$1' AND encerrado_em IS NULL), 'nenhum')"; }

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "── A. gate: só gestor/master atribui (fronteira no banco) ──"
  chk A1 "vendedor (farmer) não atribui: gate de gestor" \
    "$(erro_como "$FARM" "SELECT public.radar_atribuir_atendimento('$L1', '$FARM2')")" "42501:forbidden: gestor/master only"
  chk A2 "operacional: barrado já no gate do Radar" \
    "$(erro_como "$OPER" "SELECT public.radar_atribuir_atendimento('$L1', '$FARM')")" "42501:forbidden: radar_prospectar"
  chk A3 "customer: barrado no gate do Radar" \
    "$(erro_como "$CLI" "SELECT public.radar_atribuir_atendimento('$L1', '$FARM')")" "42501:forbidden: radar_prospectar"
  chk A4 "anon: sem EXECUTE (ACL)" \
    "$(q_como anon '' "SELECT prova.erro(\$c\$SELECT public.radar_atribuir_atendimento('$L1', '$FARM')\$c\$)")" \
    "42501:permission denied for function radar_atr"
  chk A5 "lista de vendedores: farmer não lê" \
    "$(erro_como "$FARM" "SELECT * FROM public.radar_vendedores_atribuiveis()")" "42501:forbidden: gestor/master only"
  chk A6 "nada foi escrito pelas recusas" "$(dono_aberto "$L1")" "nenhum"

  echo "── B. atribuir lead livre ──"
  chk B1 "master atribui L1 ao Vendedor Um" "$(atribuir "$MASTER" "$L1" "$FARM" ok)" "true"
  chk B2 "dono aberto = Vendedor Um" "$(dono_aberto "$L1")" "$FARM"
  chk B3 "atribuido_por = master" \
    "$(P -tA -q -c "SELECT atribuido_por FROM public.radar_atendimentos WHERE cnpj='$L1' AND encerrado_em IS NULL")" "$MASTER"
  chk B4 "o Vendedor Um vê o lead como SEU" \
    "$(q_como authenticated "$FARM" "SELECT eh_meu FROM public.radar_atendimentos_ativos() WHERE cnpj='$L1'")" "t"
  chk B5 "re-atribuir ao mesmo dono é no-op (ja_era_dono, sem linha nova)" \
    "$(atribuir "$GER" "$L1" "$FARM" ja_era_dono)/$(P -tA -q -c "SELECT count(*) FROM public.radar_atendimentos WHERE cnpj='$L1'")" "true/1"
  chk B6 "gestor (gerencial) também atribui" "$(atribuir "$GER" "$L2" "$FARM2" ok)" "true"

  echo "── C. tirar de outro: a posse anterior fecha como reatribuido, com quem fez ──"
  chk C1 "master passa L1 do Um para o Dois" "$(atribuir "$MASTER" "$L1" "$FARM2" tirou_de_outro)" "true"
  chk C2 "dono aberto = Vendedor Dois" "$(dono_aberto "$L1")" "$FARM2"
  chk C3 "posse anterior: reatribuido por master" \
    "$(P -tA -q -c "SELECT motivo_encerramento || '/' || encerrado_por FROM public.radar_atendimentos WHERE cnpj='$L1' AND dono_user_id='$FARM' AND encerrado_em IS NOT NULL")" \
    "reatribuido/$MASTER"
  chk C4 "1 aberto por CNPJ" "$(P -tA -q -c "SELECT count(*) FROM public.radar_atendimentos WHERE cnpj='$L1' AND encerrado_em IS NULL")" "1"
  chk C5 "o Um não consegue mais liberar o lead (não é dono)" \
    "$(q_como authenticated "$FARM" "SELECT public.radar_definir_atendimento('$L1','liberar')->>'motivo'")" "nao_e_dono"

  echo "── D. recusas de domínio ──"
  chk D1 "destino fora da capability (operacional)" "$(atribuir "$MASTER" "$L3" "$OPER" motivo)" "destino_sem_acesso"
  chk D2 "destino customer" "$(atribuir "$MASTER" "$L3" "$CLI" motivo)" "destino_sem_acesso"
  chk D3 "já cliente não se atribui" "$(atribuir "$MASTER" "$L4" "$FARM" motivo)" "ja_cliente"
  chk D4 "destino no teto de 100" "$(atribuir "$MASTER" "$L3" "$FARM3" motivo)" "limite"
  chk D5 "nenhuma das recusas escreveu em L3/L4" "$(dono_aberto "$L3")/$(dono_aberto "$L4")" "nenhum/nenhum"
  chk D6 "cnpj inválido: 22023" "$(erro_como "$MASTER" "SELECT public.radar_atribuir_atendimento('123', '$FARM')")" "22023:cnpj inválido"
  chk D7 "vendedor nulo: 22023" \
    "$(erro_como "$MASTER" "SELECT public.radar_atribuir_atendimento('$L3', NULL)")" "22023:radar_atribuir_atendimento: vendedor aus"
  chk D8 "empresa inexistente: P0002" \
    "$(erro_como "$MASTER" "SELECT public.radar_atribuir_atendimento('99999999000199', '$FARM')")" "P0002:empresa não encontrada: 99999999000199"

  echo "── E. posse morta não bloqueia, e é fechada com o motivo certo ──"
  chk E1 "L5 (expirada do Dois) vai para o Um" "$(atribuir "$MASTER" "$L5" "$FARM" tirou_de_outro)" "false"
  chk E2 "a expirada fechou como expirado" \
    "$(P -tA -q -c "SELECT motivo_encerramento FROM public.radar_atendimentos WHERE cnpj='$L5' AND dono_user_id='$FARM2'")" "expirado"
  chk E3 "L6 (dono sem acesso) vai para o Um" "$(atribuir "$MASTER" "$L6" "$FARM" ok)" "true"
  chk E4 "a do operacional fechou como dono_sem_acesso" \
    "$(P -tA -q -c "SELECT motivo_encerramento FROM public.radar_atendimentos WHERE cnpj='$L6' AND dono_user_id='$OPER'")" "dono_sem_acesso"

  echo "── F. master atribui a si mesmo = assumir (atribuido_por NULL) ──"
  chk F1 "master atribui L7 a si" "$(atribuir "$MASTER" "$L7" "$MASTER" ok)" "true"
  chk F2 "atribuido_por NULL quando o dono é quem atribuiu" \
    "$(P -tA -q -c "SELECT COALESCE(atribuido_por::text, 'NULL') FROM public.radar_atendimentos WHERE cnpj='$L7' AND encerrado_em IS NULL")" "NULL"
  chk F3 "a constraint barra atribuido_por = dono (escrita direta)" \
    "$(P -tA -q -c "SELECT prova.erro(\$c\$UPDATE public.radar_atendimentos SET atribuido_por = dono_user_id WHERE cnpj='$L7'\$c\$)" | cut -d: -f1)" "23514"

  echo "── G. lista de vendedores atribuíveis ──"
  chk G1 "master vê os 5 da capability (sem operacional/customer)" \
    "$(q_como authenticated "$MASTER" "SELECT string_agg(nome || '=' || papel, ',' ORDER BY nome) FROM public.radar_vendedores_atribuiveis()")" \
    "Gestor=gerencial,Lucas=master,Vendedor Dois=farmer,Vendedor Tres=hunter,Vendedor Um=farmer"

  echo "── H. catálogo ──"
  chk H1 "re-aplicar a migration é no-op" "$(P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk H2 "radar_atendimentos segue fechada ao JWT" \
    "$(P -tA -q -c "SELECT has_table_privilege('authenticated','public.radar_atendimentos','SELECT,INSERT,UPDATE,DELETE')")" "f"
  chk H3 "lista: anon sem EXECUTE" \
    "$(P -tA -q -c "SELECT has_function_privilege('anon','public.radar_vendedores_atribuiveis()','EXECUTE')")" "f"
}

# sabotagem <nome> — muda UMA camada no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
sabotagem() {
  case "$1" in
    sem_gate_gestor) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' \
      "IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN" "IF false THEN" ;;
    sem_destino_cap) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' \
      "IF NOT (COALESCE(private.cap_radar_prospectar(p_dono), false)) THEN" "IF false THEN" ;;
    sem_reatribuido) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' \
      "encerrado_por = v_uid, motivo_encerramento = 'reatribuido'" "encerrado_por = v_uid, motivo_encerramento = 'gestor_liberou'" ;;
    sem_atribuido_por) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' \
      "VALUES (p_cnpj, p_dono, v_agora, NULLIF(v_uid, p_dono))" "VALUES (p_cnpj, p_dono, v_agora, NULL)" ;;
    sem_teto) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' "IF v_meus >= 100 THEN" "IF v_meus >= 1000 THEN" ;;
    sem_ja_cliente) cv_sabotar 'public.radar_atribuir_atendimento(text,uuid)' \
      "IF COALESCE(v_ja_cliente, false) THEN" "IF false THEN" ;;
    lista_aberta) cv_sabotar 'public.radar_vendedores_atribuiveis()' \
      "IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN" "IF false THEN" ;;
    anon_executa) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION public.radar_atribuir_atendimento(text,uuid) TO anon" ;;
    *) echo "SABOTAGEM desconhecida: $1"; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelhos>[:<ids que têm de seguir verdes>]
SABOTAGENS="sem_gate_gestor:A1,A6:A2
sem_destino_cap:D1,D2:D3
sem_reatribuido:C3:C2
sem_atribuido_por:B3:B2
sem_teto:D4:D3
sem_ja_cliente:D3:D4
lista_aberta:A5:G1
anon_executa:A4:A1"

rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ────────────────────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: o controle roda primeiro e, vermelho, aborta antes
# da primeira sabotagem.
echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_|SABOTAGEM' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
