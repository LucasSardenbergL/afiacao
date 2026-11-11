#!/usr/bin/env bash
# REGRESSÃO — o simulador DES recusa quando a posição ou a meta do trimestre é desconhecida
# (20261105180000_des_simular_puxar_sem_posicao_recusa.sql).
#
# simular_puxar_volume_trimestre fazia `IF posição IS NULL THEN 0`: sem faturado confirmado do GoodData
# (a view devolve NULL desde a 20261105091216), a faixa, o ganho e a recomendação saíam de uma posição 0
# inventada. Em T4 a projeção lia a meta de T1 do MESMO ano; sem meta nenhuma, um 400000 fixo.
#   Bloco P — fidelidade: o predecessor (fixture da prod) tem o md5 do prosrc da prod; o instalado, o da PÓS.
#   Bloco B — o predecessor EXECUTADO mostra os 3 defeitos (sem isso o N/Y/M passariam vazios) e que
#     anon recebia uma simulação inteira (posição 0, meta 400000).
#   Bloco N — sem faturado: recusa com P0001 + marca, nos 4 jeitos de não ter (sem snapshot, só meta,
#     snapshot com faturado NULL, sem linha) e também sobre a view ANTIGA (rollback da view).
#   Bloco Z — faturado 0 é fato: simula, e a posição é o trânsito (60.000), não 0.
#   Bloco V — com posição e meta: o JSON é IDÊNTICO ao do predecessor em 8 combinações (fora T4).
#     NÃO certifica a escolha do check-in (a RPC usa MAX(id), a view a data — follow-up).
#   Bloco Y — T4: a projeção lê T1 do ano seguinte; sem ela, a meta do corrente (não T1 passado).
#   Bloco M — sem meta seguinte nem corrente: recusa (antes 400000).
#   Bloco S — chamada direta: anon e cliente recusados (a RLS esvazia a view); master simula.
#   Bloco K — o envelope: trava em 2 sessões, PRÉ (3ª versão viva; atributo derivado), PÓS (DROP+CREATE
#     reseta ACL; corpo errado) e reaplicar é seguro.
#
# Stubs: as bases da view (v_des_snapshot_mais_recente, v_des_pedidos_em_transito, v_des_checkin_atual)
# entram como TABELAS com as colunas da prod; a view e a dependente v_des_desconto_por_checkin são os
# corpos da prod (fixture + 20261105091216; 20260929002059). des_determinar_faixa é o da prod, verbatim.
# As tabelas de configuração levam só as colunas que a RPC lê (PL/pgSQL é late-bound).
#
# Rodar:   bash db/test-des-simular-puxar-sem-posicao.sh > log 2>&1; echo $?
# Provar dente:  bash db/test-des-simular-puxar-sem-posicao.sh --falsificar
# md5 do corpo novo (para a PRE/PÓS da migration):  bash db/test-des-simular-puxar-sem-posicao.sh --md5
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5560}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="des-simular-puxar-sem-posicao"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261105180000_des_simular_puxar_sem_posicao_recusa.sql"
FIX_PRED="$REPO_ROOT/db/fixtures/des-simular-puxar-prod-20261105.sql"
# A view como a prod a tem hoje: o predecessor (fixture) + a migration que a prod já aplicou.
FIX_VIEW_PRED="$REPO_ROOT/db/fixtures/des-posicao-ao-vivo-prod-20261105.sql"
MIG_VIEW="$REPO_ROOT/supabase/migrations/20261105091216_des_posicao_ao_vivo_sem_faturado_e_nula.sql"
MIG_CHECKIN="$REPO_ROOT/supabase/migrations/20260929002059_des_desconto_total_maximo_por_faixa.sql"
MD5_PROD_PRED=50d0f4eaf68eb2aa1616296d3980efed   # md5(prosrc), psql-ro 2026-11-05
MD5_ESTE=fea04a3887c8d0ac809e5588f5b6ee97
SIG="public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)"
# Denominador: P1 B0 B1 B2 B3 · K1 · K2-K7 · P2 A1 · N1-N5 · Z1 Z2 · V1 · Y1 Y2 Y3 · M1 · S1 S2 S3
TOTAL_ESPERADO=29

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro
# de execução — sabotagem que não aplicou, SQL quebrado, saída vazia — NÃO mata mutante.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
#   volta_zero        a guarda da posição volta a `IF NULL THEN 0` (o predecessor, só nesse trecho)
#   so_posicao        a guarda olha a posição em vez do faturado: só a view ANTIGA a fura (N5)
#   zero_vira_nulo    a guarda larga demais: faturado 0 também recusa (fato tratado como ausência)
#   ano_antigo        T4 volta a ler T1 do MESMO ano
#   volta_400000      sem meta nenhuma volta a projetar 400000
#   vizinha_alterada  outro cálculo muda junto (a troca não foi cirúrgica)
#   sem_trava, sem_pre, pre_sem_atributo, pos_sem_acl, pos_sem_md5, pre_sem_este — o envelope, 1 camada por vez
#   trava_escreve_atributo  a trava reescreve a volatilidade (STABLE): apaga a deriva que a PRE devia ver
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="volta_zero:N1,N2,N3,N4,N5,S1,S2:Z1,Z2,V1,Y1,Y2,M1,S3
              so_posicao:N5:N1,N2,N3,N4,Z1,Z2,V1,S1,S2,S3
              zero_vira_nulo:Z1,Z2,V1:N1,N2,N3,N4,N5,Y1,M1,S3
              ano_antigo:Y1,Y2:N1,Z1,Z2,V1,Y3,M1,S3
              volta_400000:M1:N1,Z1,Z2,V1,Y1,Y2,S1,S2,S3
              vizinha_alterada:V1:N1,N2,N3,N4,N5,Z2,M1,S1,S2
              sem_trava:K1:K2,K3,K4,K5,K6,K7
              sem_pre:K2:K1,K3,K4,K5,K6,K7
              pre_sem_atributo:K3,K7:K1,K2,K4,K5,K6
              pos_sem_acl:K4:K1,K2,K3,K5,K6,K7
              pos_sem_md5:K5:K1,K2,K3,K4,K6,K7
              pre_sem_este:K6:K1,K2,K3,K4,K5,K7
              trava_escreve_atributo:K7:K1,K2,K3,K4,K5,K6"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""
    for x in ${verm//,/ }; do
      grep -Eq "(^|[^A-Z0-9])${x} FALHOU" "$log" || faltou="$faltou $x"
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    intrusos="$(grep -oE '[A-Z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$intrusos" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$intrusos" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO em: ${intrusos}— vermelho que não é do assert não mata mutante"
                              grep 'ERRO_DE_EXECUCAO' "$log" | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi
MODO_MD5=""
[ "${1:-}" = "--md5" ] && MODO_MD5=1
SABOTAGEM="${SABOTAGEM:-}"
case "$SABOTAGEM" in
  ""|volta_zero|so_posicao|zero_vira_nulo|ano_antigo|volta_400000|vizinha_alterada) ;;
  sem_trava|sem_pre|pre_sem_atributo|pos_sem_acl|pos_sem_md5|pre_sem_este|trava_escreve_atributo) ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Leitura: `2>&1` faz o erro virar o VALOR lido, e o `eq` o classifica como execução.
Exec() { PGOPTIONS="-c search_path=pg_catalog,public,pg_temp" Pq -c "$1" 2>&1 || true; }
# Leitura como usuário do app: papel + o uid na GUC que o auth.uid() do stub lê.
Como() { PGOPTIONS="-c role=$1 -c test.uid=${2:-}" Pq -c "$3" 2>&1 || true; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro (psql) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 300)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

MASTER=11111111-1111-1111-1111-111111111111
CLIENTE=22222222-2222-2222-2222-222222222222
# Negativo: capturar a SQLSTATE e a marca ESPERADAS e relançar o resto. A sentinela ('NEGOU') não é
# texto que o código emita; a resposta que PASSA devolve 'PASSOU'. Uma OUTRA recusa de domínio desta
# RPC (P0001 'DES sem …' com outra marca) é RESULTADO ('OUTRA: …'), não erro de execução: é o que uma
# sabotagem que fura a 1ª guarda e esbarra na 2ª produz. `pg_temp` vive só na conexão: o auxiliar nasce
# na MESMA chamada que o usa, como postgres — o SET ROLE do preparo vem depois (pg_temp é do backend).
NEGA_FN="CREATE FUNCTION pg_temp.nega(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS \$f\$
    BEGIN
      EXECUTE p_sql;
      RETURN 'PASSOU';
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN 'NEGOU'; END IF;
      IF SQLSTATE = 'P0001' AND SQLERRM LIKE 'DES sem %' THEN RETURN 'OUTRA: ' || split_part(SQLERRM, ':', 1); END IF;
      RAISE;
    END \$f\$;"
# O veredito é a última linha NEGOU/PASSOU/OUTRA; sem ela, a saída inteira (erro) vira o valor.
veredito() { local out; out="$(cat)"; printf '%s\n' "$out" | grep -E '^(NEGOU|PASSOU|OUTRA: .*)$' | tail -n 1 | grep . || printf '%s' "$out"; }
# Numa transação que termina em ROLLBACK: BEGIN; auxiliar; <preparo>; negação; ROLLBACK.
Nega() {   # <sql> <sqlstate> <marca> [<PGOPTIONS>] [<preparo: SQL ou \i arquivo>]
  { printf 'BEGIN;\n%s\n%s\n' "$NEGA_FN" "${5:-}"
    printf "SELECT pg_temp.nega(\$q\$%s\$q\$, '%s', '%s');\nROLLBACK;\n" "$1" "$2" "$3"; } \
    | PGOPTIONS="${4:-}" Pq -q 2>&1 | veredito || true
}
# A mesma negação, como um papel do app (anon / authenticated + uid).
NegaComo() {   # <papel> <uid> <sql> <sqlstate> <marca>
  Nega "$3" "$4" "$5" "" "SET ROLE $1; SELECT set_config('test.uid', '$2', false);"
}
# O envelope por inteiro, como o `db:aplicar` o roda: uma transação, psql -f, ON_ERROR_STOP — mas
# terminando em ROLLBACK. PASSOU = aplicou inteira · NEGOU = abortou com P0001 e a marca esperada.
Aplica() {   # <arquivo> <marca da negação> [<preparo, na MESMA transação, antes do arquivo>]
  local arq="$1" marca="$2" preparo="${3:-}" out rc=0
  out="$( { printf '\\set VERBOSITY verbose\nBEGIN;\n'
            if [ -n "$preparo" ]; then printf '\\i %s\n' "$preparo"; fi
            printf '\\i %s\nROLLBACK;\n' "$arq"; } \
          | P -qAt 2>&1 )" || rc=$?
  if [ "$rc" -eq 0 ]; then echo PASSOU
  elif grep -q "P0001: $marca" <<<"$out"; then echo NEGOU
  else printf 'rc=%s psql: %s' "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  fi
}

# Recortes da migration (e das fixtures) em arquivo. Nos modos mig/parte1 a sabotagem de ENVELOPE
# ativa corta a camada dela; as trocas <de> <para> <n> têm de ocorrer exatamente n× — uma troca
# que não pegou deixaria a suíte verde (e o laço, que exige vermelho no assert certo, acusa).
gerar() {   # <modo: mig|parte1|funcao|pred|viewpred|checkin> <saída> [<de> <para> <n> ...]
  python3 - "$MIG" "$FIX_PRED" "$FIX_VIEW_PRED" "$MIG_CHECKIN" "$SABOTAGEM" "$@" <<'PYGEN' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM): gerar $1"; exit 9; }
import sys
mig_path, pred_path, vpred_path, chk_path, sab, modo, out = sys.argv[1:8]
trocas = sys.argv[8:]
mig = open(mig_path, encoding="utf-8").read()

def trecho(s, ini_txt, fim_txt):
    i = s.find(ini_txt)
    if i < 0 or s.find(ini_txt, i + 1) >= 0:
        sys.exit("trecho ausente ou repetido: %r" % ini_txt)
    j = s.find(fim_txt, i)
    if j < 0:
        sys.exit("fim não achado: %r" % fim_txt)
    return i, j + len(fim_txt)

def corta(s, ini_txt, fim_txt):
    i, j = trecho(s, ini_txt, fim_txt)
    return s[:i] + s[j:]

if modo in ("mig", "parte1"):
    s = mig
    if sab == "sem_trava":
        s = corta(s, "DO $trava$", "$trava$;\n")
    elif sab == "sem_pre":   # só o md5 da PRE: o resto do bloco guarda o ACL de antes para a PÓS
        s = corta(s, "  IF p.oid IS NULL OR md5(p.prosrc) NOT IN", "  END IF;\n")
    elif sab == "pre_sem_atributo":
        s = corta(s, "  IF p.prosecdef OR p.provolatile <> 's' OR p.proconfig::text", "  END IF;\n")
    elif sab == "pos_sem_md5":
        s = corta(s, "  IF md5(p.prosrc) IS DISTINCT FROM", "  END IF;\n")
    elif sab == "pos_sem_acl":
        s = corta(s, "  IF v_agora IS DISTINCT FROM", "  END IF;\n")
    elif sab == "trava_escreve_atributo":
        de = "  ALTER FUNCTION public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer) COST 100;"
        if s.count(de) != 1:
            sys.exit("trava não achada")
        s = s.replace(de, de.replace("COST 100;", "STABLE;"))
    elif sab == "pre_sem_este":
        de = "NOT IN ('50d0f4eaf68eb2aa1616296d3980efed', '"
        i = s.find(de)
        if i < 0 or s.find(de, i + 1) >= 0:
            sys.exit("lista da PRE não achada")
        j = s.find("')", i)
        s = s[:i] + "NOT IN ('50d0f4eaf68eb2aa1616296d3980efed" + s[j:]
    if modo == "parte1":   # a sessão A da trava roda ATÉ o fim da pré-condição e para
        fim = "$pre$;\n" if "$pre$;\n" in s else "$trava$;\n"
        s = s[:s.find(fim) + len(fim)]
elif modo == "funcao":
    i, j = trecho(mig, "CREATE OR REPLACE FUNCTION public.simular_puxar_volume_trimestre(", "$function$;\n")
    s = mig[i:j]
elif modo == "pred":
    s = open(pred_path, encoding="utf-8").read().rstrip("\n") + ";"
elif modo == "viewpred":
    fx = open(vpred_path, encoding="utf-8").read()
    i, j = trecho(fx, "CREATE VIEW public.v_des_posicao_trimestre_ao_vivo\n", ";\n")
    s = "CREATE OR REPLACE VIEW" + fx[i + len("CREATE VIEW"):j]
elif modo == "checkin":
    ck = open(chk_path, encoding="utf-8").read()
    i, j = trecho(ck, "CREATE OR REPLACE VIEW public.v_des_desconto_por_checkin\n", ";\n")
    s = ck[i:j]
else:
    sys.exit("modo desconhecido: " + modo)
for k in range(0, len(trocas), 3):
    de, para, n = trocas[k], trocas[k + 1], int(trocas[k + 2])
    if s.count(de) != n:
        sys.exit("padrão ocorre %dx, esperado %d: %r" % (s.count(de), n, de))
    s = s.replace(de, para)
open(out, "w", encoding="utf-8").write(s + "\n")
PYGEN
}

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que a view e a RPC leem. Colunas e TIPOS da prod (psql-ro, 2026-11-05).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.v_des_snapshot_mais_recente (
  id bigint, empresa text, ano integer, trimestre integer, data_referencia date, objetivo_valor numeric,
  fat_bruto_valor numeric, objetivo_qtde numeric, fat_bruto_qtde numeric, pedidos_abertos_valor numeric,
  pedidos_abertos_qtde numeric, criado_em timestamptz
);
CREATE TABLE public.v_des_pedidos_em_transito (
  pedido_id bigint, empresa text, fornecedor_nome text, grupo_codigo text, data_ciclo date,
  horario_disparo_real timestamptz, valor_total numeric, status text, tipo_ciclo text, data_emissao date,
  data_faturamento_prevista date, ano_atual integer, trimestre_atual integer, inicio_trimestre date,
  fim_trimestre date, fatura_no_trimestre boolean, zona_confianca text
);
CREATE TABLE public.des_meta_empresa (
  id bigint PRIMARY KEY, empresa text, ano integer, trimestre integer, meta_faturamento numeric,
  faixa_des_objetivo integer, observacoes text, criado_em timestamptz, atualizado_em timestamptz
);
CREATE TABLE public.des_contrato_versao (
  id bigint PRIMARY KEY, versao text NOT NULL UNIQUE, data_inicio_vigencia date, data_fim_vigencia date,
  observacoes text, criado_em timestamptz
);
CREATE TABLE public.des_faixa_quantitativa (
  id bigint PRIMARY KEY, contrato_versao_id bigint REFERENCES public.des_contrato_versao(id),
  faixa_numero integer, estrelas integer, volume_min numeric, volume_max numeric,
  desconto_padrao_perc numeric, observacoes text, criado_em timestamptz
);
CREATE TABLE public.v_des_checkin_atual (
  empresa text, ano integer, trimestre integer, checkin_id bigint, data_avaliacao date, tipo text,
  avaliado_com text, avaliado_por text, codigo text, nome text, criterio_tipo text, atingido boolean,
  observacao_criterio text
);
CREATE TABLE public.des_criterio_qualitativo (
  id bigint PRIMARY KEY, contrato_versao_id bigint NOT NULL REFERENCES public.des_contrato_versao(id),
  codigo text NOT NULL, nome text NOT NULL, descricao text, ordem integer NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('qualitativo', 'bonus')), criado_em timestamptz,
  UNIQUE (contrato_versao_id, codigo)
);
CREATE TABLE public.des_criterio_percentual (
  id bigint PRIMARY KEY, criterio_id bigint NOT NULL REFERENCES public.des_criterio_qualitativo(id),
  faixa_id bigint NOT NULL, percentual numeric NOT NULL, criado_em timestamptz,
  UNIQUE (criterio_id, faixa_id)
);
-- O que só a RPC lê (só as colunas lidas).
CREATE TABLE public.des_checkin_qualitativo (
  id bigint PRIMARY KEY, empresa text NOT NULL, ano integer NOT NULL, trimestre integer NOT NULL,
  data_avaliacao date NOT NULL, tipo text NOT NULL
);
CREATE TABLE public.des_checkin_qualitativo_resposta (
  id bigint PRIMARY KEY, checkin_id bigint NOT NULL, criterio_id bigint NOT NULL, atingido boolean NOT NULL
);
CREATE TABLE public.fornecedor_prazo_pagamento_config (
  id bigint PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, codigo text NOT NULL,
  nome text NOT NULL, desconto_ou_encargo_perc numeric NOT NULL, ativo boolean, padrao boolean
);
CREATE TABLE public.fornecedor_custo_adicional_config (
  id bigint PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, tipo text NOT NULL,
  valor numeric NOT NULL, ativo boolean
);
CREATE TABLE public.empresa_configuracao_custos (
  empresa text PRIMARY KEY, selic_anual numeric NOT NULL, spread_oportunidade numeric NOT NULL,
  armazenagem_fisica numeric NOT NULL
);

-- des_determinar_faixa: o corpo da PROD, verbatim (pg_get_functiondef, psql-ro 2026-11-05).
CREATE OR REPLACE FUNCTION public.des_determinar_faixa(p_valor numeric, p_versao text DEFAULT '2026'::text)
 RETURNS TABLE(faixa_id bigint, faixa_numero integer, estrelas integer, desconto_padrao_perc numeric, volume_min numeric, volume_max numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    fq.id,
    fq.faixa_numero,
    fq.estrelas,
    fq.desconto_padrao_perc,
    fq.volume_min,
    fq.volume_max
  FROM des_faixa_quantitativa fq
  JOIN des_contrato_versao cv ON cv.id = fq.contrato_versao_id
  WHERE cv.versao = p_versao
    AND p_valor >= fq.volume_min
    AND (fq.volume_max IS NULL OR p_valor <= fq.volume_max)
  LIMIT 1;
$function$;

-- RLS como na prod: só staff lê as bases DES e as configurações (anon e cliente: 0 linhas).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['v_des_snapshot_mais_recente', 'v_des_pedidos_em_transito', 'des_meta_empresa',
                           'des_contrato_versao', 'des_faixa_quantitativa', 'v_des_checkin_atual',
                           'des_criterio_qualitativo', 'des_criterio_percentual', 'des_checkin_qualitativo',
                           'des_checkin_qualitativo_resposta', 'fornecedor_prazo_pagamento_config',
                           'fornecedor_custo_adicional_config', 'empresa_configuracao_custos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY staff_le ON public.%I FOR SELECT TO authenticated
                      USING (public.has_role(auth.uid(), 'master'::public.app_role)
                             OR public.has_role(auth.uid(), 'employee'::public.app_role))$p$, t);
  END LOOP;
END
$rls$;
SQL

# A VIEW como a prod a tem hoje (fixture da prod + a migration que a prod já aplicou) e a dependente.
gerar viewpred "$TMPD/viewpred.sql"
P -q -f "$TMPD/viewpred.sql"
gerar checkin "$TMPD/checkin.sql"
P -q -f "$TMPD/checkin.sql"
P -q -1 -f "$MIG_VIEW" >/dev/null
# O PREDECESSOR da RPC (fixture da prod) e o ACL explícito da prod (anon/authenticated/service_role).
gerar pred "$TMPD/pred.sql"
P -q -f "$TMPD/pred.sql"
P -q <<SQL
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated, anon;
GRANT EXECUTE ON FUNCTION $SIG TO anon, authenticated, service_role;
SQL

Q_MD5="SELECT md5(prosrc) FROM pg_proc WHERE oid = '$SIG'::regprocedure"
Q_ATTR="SELECT COALESCE(p.proacl::text, 'NULO') || '|' || COALESCE(p.proconfig::text, 'NULO') || '|' ||
          pg_get_userbyid(p.proowner) || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' ||
          pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid)
          FROM pg_proc p WHERE p.oid = '$SIG'::regprocedure"

if [ -n "$MODO_MD5" ]; then
  gerar funcao "$TMPD/md5.sql"
  P -q -f "$TMPD/md5.sql"
  echo "MD5_ESTE (md5 do prosrc): $(Exec "$Q_MD5")"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED. Faixas 2026: id 11 = nº1 [50.000; 99.999,99] · 12 = nº2 [100.000; 249.999,99] ·
#   13 = nº3 [250.000; ∞). Uma empresa por estado:
#     SEMSNAP  T4/26 sem snapshot; trânsito seguro 297.966,59; meta T4 400.840,02
#     SOMETA   T4/26 só meta
#     NULOFAT  T4/26 snapshot com fat_bruto_valor NULL + trânsito 70.000
#     AUSENTE  nenhuma linha
#     ZERO     T2/26 snapshot fat 0, sem trânsito; metas T2 e T3 = 100.000
#     ZEROTR   T2/26 snapshot fat 0 + trânsito seguro 60.000 depois dele; metas T2 e T3 = 100.000
#     CHEIO    T2/26 fat 103.068,74 (metas T2 400.840,02, T3 333.333; 1 check-in com Mix atingido) e
#              T4/26 fat 103.068,74 + trânsito 150.000 (metas T1/26 111.111, T4/26 400.840,02, T1/27 222.222)
#     FIMANO   T4/26 fat 120.000; metas T1/26 111.111 e T4/26 444.444, nenhuma de 2027
#     SEMMETA  T2/26 fat 120.000; nenhuma meta
#   Prazos (como a OBEN): antecipado +2,00 (padrão) e 28_42_56 −2,56; frete 2,5%; capital 14,75+3+8.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$CLIENTE', 'customer');
INSERT INTO public.des_contrato_versao (id, versao) VALUES (1, '2026');
INSERT INTO public.des_faixa_quantitativa (id, contrato_versao_id, faixa_numero, estrelas, volume_min, volume_max, desconto_padrao_perc) VALUES
  (11, 1, 1, 1,  50000,  99999.99, 0.50),
  (12, 1, 2, 2, 100000, 249999.99, 1.00),
  (13, 1, 3, 3, 250000,      NULL, 1.50);
INSERT INTO public.v_des_snapshot_mais_recente (id, empresa, ano, trimestre, data_referencia, objetivo_valor, fat_bruto_valor, pedidos_abertos_valor) VALUES
  (1, 'NULOFAT', 2026, 4, '2026-10-10', 500000, NULL,      NULL),
  (2, 'ZERO',    2026, 2, '2026-04-05', 500000, 0,         0),
  (3, 'ZEROTR',  2026, 2, '2026-04-05', 500000, 0,         0),
  (4, 'CHEIO',   2026, 2, '2026-05-20', 500000, 103068.74, 0),
  (5, 'CHEIO',   2026, 4, '2026-10-20', 500000, 103068.74, 0),
  (6, 'FIMANO',  2026, 4, '2026-10-20', 500000, 120000,    0),
  (7, 'SEMMETA', 2026, 2, '2026-05-20', 500000, 120000,    0);
INSERT INTO public.v_des_pedidos_em_transito (pedido_id, empresa, valor_total, data_emissao, ano_atual, trimestre_atual, fatura_no_trimestre, zona_confianca) VALUES
  (101, 'SEMSNAP', 297966.59, '2026-10-15', 2026, 4, true, 'verde'),
  (201, 'NULOFAT',  70000.00, '2026-10-12', 2026, 4, true, 'verde'),
  (301, 'ZEROTR',   60000.00, '2026-04-07', 2026, 2, true, 'verde'),
  (401, 'CHEIO',   150000.00, '2026-10-22', 2026, 4, true, 'verde');
INSERT INTO public.des_meta_empresa (id, empresa, ano, trimestre, meta_faturamento) VALUES
  (1,  'SEMSNAP', 2026, 4, 400840.02),
  (2,  'SOMETA',  2026, 4, 400840.02),
  (3,  'NULOFAT', 2026, 4, 100000),
  (4,  'ZERO',    2026, 2, 100000),
  (5,  'ZERO',    2026, 3, 100000),
  (6,  'ZEROTR',  2026, 2, 100000),
  (7,  'ZEROTR',  2026, 3, 100000),
  (8,  'CHEIO',   2026, 1, 111111),
  (9,  'CHEIO',   2026, 2, 400840.02),
  (10, 'CHEIO',   2026, 3, 333333),
  (11, 'CHEIO',   2026, 4, 400840.02),
  (12, 'CHEIO',   2027, 1, 222222),
  (13, 'FIMANO',  2026, 1, 111111),
  (14, 'FIMANO',  2026, 4, 444444);
INSERT INTO public.des_criterio_qualitativo (id, contrato_versao_id, codigo, nome, ordem, tipo) VALUES
  (101, 1, 'mix_produtos', 'Mix', 1, 'qualitativo');
INSERT INTO public.des_criterio_percentual (id, criterio_id, faixa_id, percentual) VALUES
  (1, 101, 11, 0.20), (2, 101, 12, 0.40), (3, 101, 13, 0.75);
INSERT INTO public.des_checkin_qualitativo (id, empresa, ano, trimestre, data_avaliacao, tipo) VALUES
  (2, 'CHEIO', 2026, 2, '2026-05-25', 'projecao');
INSERT INTO public.des_checkin_qualitativo_resposta (id, checkin_id, criterio_id, atingido) VALUES (1, 2, 101, true);
INSERT INTO public.v_des_checkin_atual (empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, codigo, nome, criterio_tipo, atingido) VALUES
  ('CHEIO', 2026, 2, 2, '2026-05-25', 'projecao', 'mix_produtos', 'Mix', 'qualitativo', true);
INSERT INTO public.fornecedor_prazo_pagamento_config (id, empresa, fornecedor_nome, codigo, nome, desconto_ou_encargo_perc, ativo, padrao)
  SELECT row_number() OVER (), e, 'RENNER SAYERLACK S/A', c, c, d, true, pd
    FROM unnest(ARRAY['ZERO', 'ZEROTR', 'CHEIO', 'FIMANO', 'SEMMETA']) e,
         (VALUES ('antecipado', 2.00, true), ('28_42_56', -2.56, false)) v(c, d, pd);
INSERT INTO public.fornecedor_custo_adicional_config (id, empresa, fornecedor_nome, tipo, valor, ativo)
  SELECT row_number() OVER (), e, 'RENNER SAYERLACK S/A', 'frete_perc_valor', 2.50, true
    FROM unnest(ARRAY['ZERO', 'ZEROTR', 'CHEIO', 'FIMANO', 'SEMMETA']) e;
INSERT INTO public.empresa_configuracao_custos (empresa, selic_anual, spread_oportunidade, armazenagem_fisica)
  SELECT e, 14.75, 3.00, 8.00 FROM unnest(ARRAY['ZERO', 'ZEROTR', 'CHEIO', 'FIMANO', 'SEMMETA']) e;
SQL

# Chamada que nunca vira erro de execução por RECUSA DE DOMÍNIO: devolve o jsonb, ou {"recusou": marca}
# quando a RPC levanta P0001 'DES sem …' (o resto relança). Assim uma sabotagem que passa a recusar
# onde devia simular dá um RESULTADO diferente (FALHOU), não uma saída vazia.
P -q <<'SQL'
CREATE FUNCTION public.tenta_sim(e text, a int, t int, v numeric, pz text, d int) RETURNS jsonb
LANGUAGE plpgsql AS $f$
BEGIN
  RETURN public.simular_puxar_volume_trimestre(e, a, t, v, pz, d);
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'DES sem %' THEN RETURN jsonb_build_object('recusou', split_part(SQLERRM, ':', 1)); END IF;
  RAISE;
END $f$;
SQL
# Um caminho do jsonb de uma chamada; recusa vira o texto da marca, ausência vira NULO.
Sim() {   # <empresa> <ano> <tri> <valor> <prazo> <dias> <caminho jsonb>
  Exec "SELECT COALESCE(r #>> '$7', r ->> 'recusou', 'NULO') FROM (SELECT public.tenta_sim('$1', $2, $3, $4, '$5', $6) AS r) x"
}
# Posição atual | nº da faixa atual (NULO sem faixa); recusa vira o texto da marca.
PosFaixa() {   # <empresa> <ano> <tri> <valor> <prazo> <dias>
  Exec "SELECT COALESCE((r #>> '{posicao,atual}') || '|' || COALESCE(r #>> '{faixas,atual,faixa_numero}', 'NULO'), r ->> 'recusou', 'NULO')
          FROM (SELECT public.tenta_sim('$1', $2, $3, $4, '$5', $6) AS r) x"
}
SIM_SQL() { printf "SELECT public.simular_puxar_volume_trimestre('%s', %s, %s, %s, '%s', %s)" "$@"; }
MARCA_POS="DES sem posicao confirmada"
MARCA_META="DES sem meta para projetar"
# As 8 combinações do diferencial (fora T4): empresa|ano|tri|valor|prazo|dias.
COMBOS="CHEIO|2026|2|0|antecipado|60 CHEIO|2026|2|50000|antecipado|60 CHEIO|2026|2|200000|28_42_56|30
        CHEIO|2026|2|200000|antecipado|90 ZERO|2026|2|50000|antecipado|60 ZERO|2026|2|120000|28_42_56|60
        ZEROTR|2026|2|30000|antecipado|60 ZEROTR|2026|2|250000|28_42_56|45"
P -q -c "CREATE TABLE public.antes (combo text PRIMARY KEY, r jsonb);"
for c in $COMBOS; do
  IFS='|' read -r e a t v pz d <<<"$c"
  P -q -c "INSERT INTO public.antes VALUES ('$c', ($(SIM_SQL "$e" "$a" "$t" "$v" "$pz" "$d")));"
done

# ══════════════════════════════════════════════════════════════════════════════
# B — o PREDECESSOR executado (antes da migration): os 3 defeitos e a exposição.
# ══════════════════════════════════════════════════════════════════════════════
eq P1 "o predecessor (fixture) = o da prod: é o que a PRÉ reconhece" "$(Exec "$Q_MD5")" "$MD5_PROD_PRED"
eq B0 "predecessor: SEMSNAP (sem faturado) simula a partir de posição 0,00 e recomenda" \
  "$(Exec "SELECT (r #>> '{posicao,atual}') || '|' || (r ->> 'recomendacao') FROM (SELECT ($(SIM_SQL SEMSNAP 2026 4 300000 antecipado 60)) AS r) x")" "0|nao_compensa"
eq B1 "predecessor: em T4 a projeção lê T1 do MESMO ano (111.111), não T1/27 (222.222)" \
  "$(Sim CHEIO 2026 4 50000 antecipado 60 '{projecao,proximo_trimestre_projetado}')" "111111"
eq B2 "predecessor: sem meta nenhuma, projeta 400000 inventado" \
  "$(Sim SEMMETA 2026 2 50000 antecipado 60 '{projecao,proximo_trimestre_projetado}')" "400000"
eq B3 "predecessor: anon recebia uma simulação inteira (posição 0, meta 400000)" \
  "$(Como anon '' "SELECT (r #>> '{posicao,atual}') || '|' || (r #>> '{projecao,proximo_trimestre_projetado}') FROM (SELECT ($(SIM_SQL CHEIO 2026 2 50000 antecipado 60)) AS r) x" | tail -n 1)" "0|400000"
ATTR_ANTES="$(Exec "$Q_ATTR")"

# ══════════════════════════════════════════════════════════════════════════════
# K1 — A TRAVA, em DUAS sessões. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a
# transação aberta. B tenta mexer na função com lock_timeout e tem de ser BARRADA (55P03).
# ══════════════════════════════════════════════════════════════════════════════
gerar parte1 "$TMPD/parte1.sql"
mkfifo "$TMPD/a.in"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -qAt < "$TMPD/a.in" > "$TMPD/a.out" 2>&1 &
PID_A=$!
exec 7> "$TMPD/a.in"
printf 'BEGIN;\n\\i %s\n\\! touch %s\n' "$TMPD/parte1.sql" "$TMPD/a.pronta" >&7
for _ in $(seq 1 150); do
  [ -e "$TMPD/a.pronta" ] && break
  kill -0 "$PID_A" 2>/dev/null || break
  sleep 0.2
done
if [ ! -e "$TMPD/a.pronta" ]; then
  echo "❌ K: a sessão A não chegou ao fim da pré-condição — a trava não foi posta à prova"
  head -c 600 "$TMPD/a.out"; exit 1
fi
eq K1 "com A parada após a pré-condição, B não mexe na função" \
  "$(Nega "ALTER FUNCTION $SIG STABLE" 55P03 '' '-c lock_timeout=1500')" NEGOU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1), numa transação só, como o `db:aplicar` a roda.
# ══════════════════════════════════════════════════════════════════════════════
P -q -1 -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (trava, PRÉ e PÓS passaram)"

# ══════════════════════════════════════════════════════════════════════════════
# K2-K6 — O ENVELOPE, em transações que terminam em ROLLBACK (o estado segue o da migration).
# K3-K5 partem do PREDECESSOR vivo, para a PRÉ do md5 não ser a camada que barra.
# ══════════════════════════════════════════════════════════════════════════════
gerar mig "$TMPD/k_mig.sql"
gerar pred "$TMPD/k_pred.sql"
gerar funcao "$TMPD/k_terceira.sql" "v_cm_anual := COALESCE(" "v_cm_anual := 0 + COALESCE(" 1
printf "ALTER FUNCTION %s SECURITY DEFINER;\n" "$SIG" > "$TMPD/k_definer.sql"
cat "$TMPD/k_pred.sql" "$TMPD/k_definer.sql" > "$TMPD/k_pred_definer.sql"
gerar mig "$TMPD/k_drop_create.sql" "CREATE OR REPLACE FUNCTION public.simular_puxar_volume_trimestre(" \
  "DROP FUNCTION $SIG;
CREATE FUNCTION public.simular_puxar_volume_trimestre(" 1
gerar mig "$TMPD/k_corpo_errado.sql" "v_cm_anual := COALESCE(" "v_cm_anual := 0 + COALESCE(" 1
eq K2 "PRÉ: sobre uma 3ª versão viva (mudança concorrente), a migration aborta" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU' "$TMPD/k_terceira.sql")" NEGOU
eq K3 "PRÉ: corpo da prod mas SECURITY DEFINER (deriva de atributo), a migration aborta" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU' "$TMPD/k_pred_definer.sql")" NEGOU
eq K4 "PÓS: DROP+CREATE (reseta o ACL) aborta" \
  "$(Aplica "$TMPD/k_drop_create.sql" 'POS2 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K5 "PÓS: um corpo que não é o do md5 aborta" \
  "$(Aplica "$TMPD/k_corpo_errado.sql" 'POS1 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K6 "reaplicar sobre ela mesma passa (a PRÉ aceita este)" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU')" PASSOU
# K7 — outra sessão commitou VOLATILE antes da trava: a trava não pode reescrever a volatilidade e
# esconder a deriva; a PRE tem de vê-la (o caso sequencial da janela leitura→ALTER do estágio 2).
printf "ALTER FUNCTION %s VOLATILE;\n" "$SIG" > "$TMPD/k_volatile.sql"
eq K7 "PRÉ: deriva de volatilidade commitada antes da trava, a migration aborta (a trava não a apaga)" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU' "$TMPD/k_volatile.sql")" NEGOU

# ── SABOTAGEM da função (só no modo --falsificar) — no BANCO, recriando a função instalada com o trecho
# trocado; o repo nunca é tocado. As de envelope já entraram pelo `gerar` (K1-K6).
sabotar() { gerar funcao "$TMPD/sab.sql" "$@"; P -q -f "$TMPD/sab.sql"; }
NL=$'\n'
G_GUARDA="  IF v_fat_confirmado IS NULL THEN${NL}    RAISE EXCEPTION 'DES sem posicao confirmada:"
case "$SABOTAGEM" in
  volta_zero)       sabotar "$G_GUARDA" "  IF v_posicao_atual IS NULL THEN v_posicao_atual := 0; END IF;${NL}  IF false THEN${NL}    RAISE EXCEPTION 'DES sem posicao confirmada:" 1 ;;
  so_posicao)       sabotar "$G_GUARDA" "  IF v_posicao_atual IS NULL THEN${NL}    RAISE EXCEPTION 'DES sem posicao confirmada:" 1 ;;
  zero_vira_nulo)   sabotar "  IF v_fat_confirmado IS NULL THEN" "  IF COALESCE(v_fat_confirmado, 0) = 0 THEN" 1 ;;
  ano_antigo)       sabotar "AND ano = CASE WHEN v_trimestre = 4 THEN v_ano + 1 ELSE v_ano END" "AND ano = v_ano" 1 ;;
  volta_400000)     sabotar "       WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre);${NL}    IF v_projecao_proximo_trimestre IS NULL THEN" \
                            "       WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre);${NL}    v_projecao_proximo_trimestre := COALESCE(v_projecao_proximo_trimestre, 400000);${NL}    IF v_projecao_proximo_trimestre IS NULL THEN" 1 ;;
  vizinha_alterada) sabotar "v_cm_anual := COALESCE(" "v_cm_anual := 0.01 + COALESCE(" 1 ;;
  *) ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
eq P2 "instalada = a da PÓS" "$(Exec "$Q_MD5")" "$MD5_ESTE"
eq A1 "ACL, config, dono, volatilidade, INVOKER, argumentos e retorno idênticos aos do predecessor" \
  "$(Exec "$Q_ATTR")" "$ATTR_ANTES"

# N — sem faturado confirmado: recusa, com a SQLSTATE e a marca.
eq N1 "SEMSNAP (sem snapshot, só trânsito): recusa" "$(Nega "$(SIM_SQL SEMSNAP 2026 4 300000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
eq N2 "SOMETA (só meta): recusa" "$(Nega "$(SIM_SQL SOMETA 2026 4 50000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
eq N3 "NULOFAT (snapshot com faturado NULL): recusa" "$(Nega "$(SIM_SQL NULOFAT 2026 4 50000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
eq N4 "AUSENTE (nenhuma linha na view): recusa" "$(Nega "$(SIM_SQL AUSENTE 2026 4 50000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
# N5 — a view ANTIGA de volta (rollback da 20261105091216): posição = só trânsito, faturado NULL.
gerar viewpred "$TMPD/n5_view.sql"
eq N5 "sobre a view ANTIGA (posição 297.966,59 só de trânsito), SEMSNAP ainda recusa" \
  "$(Nega "$(SIM_SQL SEMSNAP 2026 4 300000 antecipado 60)" P0001 "$MARCA_POS" "" "\\i $TMPD/n5_view.sql")" NEGOU

# Z — faturado ZERO é fato: simula, e a posição é o trânsito.
eq Z1 "ZEROTR: faturado 0 + 60.000 de trânsito simula a partir de 60.000,00 (faixa nº1), não de 0" \
  "$(PosFaixa ZEROTR 2026 2 30000 antecipado 60)" "60000.00|1"
eq Z2 "ZERO: faturado 0 sem trânsito simula a partir de 0,00 (sem faixa)" \
  "$(PosFaixa ZERO 2026 2 50000 antecipado 60)" "0.00|NULO"

# V — com posição e meta (fora de T4): o JSON é idêntico ao do predecessor.
Q_V="SELECT count(*) || '|' || count(*) FILTER (WHERE a.r IS DISTINCT FROM n.r) FROM public.antes a
       CROSS JOIN LATERAL (SELECT public.tenta_sim(
         split_part(a.combo, '|', 1), split_part(a.combo, '|', 2)::int, split_part(a.combo, '|', 3)::int,
         split_part(a.combo, '|', 4)::numeric, split_part(a.combo, '|', 5), split_part(a.combo, '|', 6)::int) AS r) n"
eq V1 "8 combinações com posição e meta: o jsonb inteiro idêntico ao do predecessor (0 diferentes)" "$(Exec "$Q_V")" "8|0"

# Y — T4: o ano do próximo trimestre.
eq Y1 "CHEIO T4/26: a projeção lê T1/27 (222.222), não T1/26 (111.111)" \
  "$(Sim CHEIO 2026 4 50000 antecipado 60 '{projecao,proximo_trimestre_projetado}')" "222222"
eq Y2 "FIMANO T4/26 sem meta de 2027: cai na meta do corrente (444.444), não em T1/26 (111.111)" \
  "$(Sim FIMANO 2026 4 50000 antecipado 60 '{projecao,proximo_trimestre_projetado}')" "444444"
eq Y3 "CHEIO T4/26: posição atual = faturado + trânsito (253.068,74), faixa nº3" \
  "$(PosFaixa CHEIO 2026 4 50000 antecipado 60)" "253068.74|3"

# M — sem meta seguinte nem corrente: recusa (antes 400000).
eq M1 "SEMMETA T2/26 (com posição, sem meta T3 nem T2): recusa" \
  "$(Nega "$(SIM_SQL SEMMETA 2026 2 50000 antecipado 60)" P0001 "$MARCA_META")" NEGOU

# S — chamada direta: a RLS esvazia a view para anon e cliente; master simula.
eq S1 "anon chamando direto: recusa (antes: posição 0 e meta 400000)" \
  "$(NegaComo anon '' "$(SIM_SQL CHEIO 2026 2 50000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
eq S2 "cliente autenticado chamando direto: recusa" \
  "$(NegaComo authenticated "$CLIENTE" "$(SIM_SQL CHEIO 2026 2 50000 antecipado 60)" P0001 "$MARCA_POS")" NEGOU
eq S3 "master simula CHEIO T2/26 (posição 103.068,74; o S1/S2 não é RPC quebrada)" \
  "$(Como authenticated "$MASTER" "SELECT public.simular_puxar_volume_trimestre('CHEIO', 2026, 2, 50000, 'antecipado', 60) #>> '{posicao,atual}'" | tail -n 1)" "103068.74"

echo "════════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL (esperados $TOTAL_ESPERADO)"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executou $PASS asserts, o denominador é $TOTAL_ESPERADO — bloco que não rodou é vermelho"
  exit 1
fi
[ "$FAIL" -eq 0 ]
