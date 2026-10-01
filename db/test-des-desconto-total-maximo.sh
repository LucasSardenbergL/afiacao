#!/usr/bin/env bash
# REGRESSÃO — o "máximo possível" do check-in DES é o DA FAIXA do check-in
# (20260929002059_des_desconto_total_maximo_por_faixa.sql).
#
# v_des_desconto_por_checkin.desconto_total_maximo somava `WHERE cp2.faixa_id = cp2.faixa_id` —
# tautologia: os percentuais de TODAS as faixas e versões de contrato. O certo (intenção confirmada
# pelo founder, 2026-09-29) é o padrão da faixa + todos os critérios DAQUELA faixa (qualitativos +
# bônus), na versão de contrato '2026' — o mesmo universo do desconto projetado.
#   Bloco P — fidelidade: o predecessor (fixture da prod) dá o md5 da prod; o instalado, o da PÓS,
#     sob os dois search_path.
#   Bloco B — o NÚMERO: faixas com somas DIFERENTES (a soma global reprova), percentual de outra
#     versão ligado à faixa (o filtro de versão tem dente), ids de faixa ≠ números de faixa, faixa
#     sem percentual ⇒ NULL (nunca o padrão sozinho), projetado = máximo com tudo atingido e nunca
#     acima dele. B0/V0: o predecessor EXECUTADO mostra o defeito.
#   Bloco V — as outras 12 colunas saem idênticas às do predecessor, linha a linha.
#   Bloco S — security_invoker preservado: cliente autenticado lê 0 linhas, master lê as 3.
#   Bloco K — o envelope: trava (com a migration parada logo após a PRÉ, outra sessão não mexe na
#     view), PRÉ (aborta sobre uma 3ª versão viva), PÓS (aborta um replace sem o WITH; aborta um
#     corpo que não é o do md5) e reaplicar é seguro (a PRÉ aceita "este").
#
# Stubs: as views de cima (v_des_checkin_atual, v_des_posicao_trimestre_ao_vivo) entram como
# TABELAS com nome, colunas e tipos da prod (psql-ro, 2026-09-29) — é só isso que o deparse
# imprime, e o P1 prova que basta (md5 da prod). RLS nelas e nas bases: só staff lê, como na prod.
#
# Rodar:   bash db/test-des-desconto-total-maximo.sh > log 2>&1; echo $?
#          bash db/test-des-desconto-total-maximo.sh --falsificar > log 2>&1; echo $?
# matriz: HARNESS_LC=C|pt_BR.UTF-8
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5520}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="des-desconto-total-maximo"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260929002059_des_desconto_total_maximo_por_faixa.sql"
# O predecessor não tem CREATE no repo: sai da fixture capturada da prod (pg_get_viewdef verbatim).
FIX_VIEWS="$REPO_ROOT/db/fixtures/des-views-predecessoras-prod-20260927.sql"
MD5_PROD_PRED=1c8885b860f65f5c76b1fd5314b96e28   # psql-ro, 2026-09-29 (o mesmo de 2026-09-27)
MD5_ESTE=879fe737d8a8e872ab855c1db35d3179
# Denominador: P1 B0 V0 · K1 · K2-K5 · P2 P3 · B1-B5 · V1 · S1-S3
TOTAL_ESPERADO=19

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro
# de execução — sabotagem que não aplicou, SQL quebrado, saída vazia — NÃO mata mutante e
# reprova a falsificação.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
#   tautologia          o WHERE volta a ser `cp2.faixa_id = cp2.faixa_id` (o predecessor)
#   sem_filtro_versao   correlaciona a faixa, mas soma critério de qualquer versão de contrato
#   faixa_por_numero    compara o id da faixa com o NÚMERO da faixa (ids ≠ números no seed)
#   so_qualitativos     o bônus fica fora do máximo (o projetado passa dele)
#   coalesce_zero       faixa sem percentual vira o padrão sozinho (ausente fabricado como 0)
#   vizinha_alterada    outra coluna muda junto (a troca não foi cirúrgica)
#   sem_invoker         o replace sem o WITH: a view lê como dono — o md5 NÃO vê (P2/P3 verdes)
#   sem_trava, sem_pre, pos_sem_invoker, pos_sem_md5, pre_sem_este — o envelope, 1 camada por vez
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="tautologia:B1,B2,B3,B4,P2,P3:B0,V0,B5,V1,S1,S2,S3
              sem_filtro_versao:B1:B2,B3,B4,B5,V1,S1
              faixa_por_numero:B1,B2,B4:B3,B5,V1
              so_qualitativos:B1,B2,B4,B5:B3,V1
              coalesce_zero:B3:B1,B2,B4,B5,V1
              vizinha_alterada:V1,B4:B1,B2,B3
              sem_invoker:S1,S2:P2,P3,B1,B2,B3,B4,V1,S3
              sem_trava:K1:K2,K3,K4,K5
              sem_pre:K2:K1,K3,K4,K5
              pos_sem_invoker:K3:K1,K2,K4,K5
              pos_sem_md5:K4:K1,K2,K3,K5
              pre_sem_este:K5:K1,K2,K3,K4"
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
    # Erro de execução em QUALQUER assert reprova: vermelho que não é do assert não mata mutante.
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
SABOTAGEM="${SABOTAGEM:-}"
case "$SABOTAGEM" in
  ""|tautologia|sem_filtro_versao|faixa_por_numero|so_qualitativos|coalesce_zero|vizinha_alterada|sem_invoker) ;;
  sem_trava|sem_pre|pos_sem_invoker|pos_sem_md5|pre_sem_este) ;;
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
# Leitura como usuário do app: papel `authenticated` + o uid na GUC que o auth.uid() do stub lê.
Como() { PGOPTIONS="-c role=authenticated -c test.uid=$1" Pq -c "$2" 2>&1 || true; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth TO authenticated;
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
# Negativo: capturar a SQLSTATE e a marca ESPERADAS e relançar o resto — outro erro sai como ERRO
# (o `eq` o lê como execução, não como dente). A sentinela ('NEGOU') não é texto que o código
# emita. `pg_temp` vive só na conexão: o auxiliar nasce na MESMA chamada que o usa.
Nega() {   # <sql> <sqlstate> <marca> [<opções extras de conexão>]
  PGOPTIONS="${4:-}" Pq -q -c "
    CREATE FUNCTION pg_temp.nega(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS \$f\$
    BEGIN
      EXECUTE p_sql;
      RETURN 'PASSOU';
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN 'NEGOU'; END IF;
      RAISE;
    END \$f\$;
    SELECT pg_temp.nega(\$q\$$1\$q\$, '$2', '$3');" 2>&1 || true
}
# O envelope por inteiro, como o `db:aplicar` o roda: uma transação, psql -f, ON_ERROR_STOP — mas
# terminando em ROLLBACK. PASSOU = aplicou inteira · NEGOU = abortou com P0001 e a marca esperada
# (VERBOSITY verbose põe a SQLSTATE na linha, nos dois lc_messages) · qualquer outra coisa sai crua.
Aplica() {   # <arquivo> <marca da negação> [<preparo, na MESMA transação, antes do arquivo>]
  local arq="$1" marca="$2" preparo="${3:-}" out rc=0
  out="$( { printf '\\set VERBOSITY verbose\nBEGIN;\n'
            if [ -n "$preparo" ]; then printf '\\i %s\n' "$preparo"; fi
            printf '\\i %s\nROLLBACK;\n' "$arq"; } \
          | P -qAt 2>&1 )" || rc=$?
  if [ "$rc" -eq 0 ]; then echo PASSOU
  elif printf '%s' "$out" | grep -q "P0001: $marca"; then echo NEGOU
  else printf 'rc=%s psql: %s' "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  fi
}

# Recortes da migration (e da fixture) em arquivo. Nos modos mig/parte1 a sabotagem de ENVELOPE
# ativa corta a camada dela; as trocas <de> <para> <n> têm de ocorrer exatamente n× — uma troca
# que não pegou deixaria a suíte verde (e o laço, que exige vermelho no assert certo, acusa).
gerar() {   # <modo: mig|parte1|view|pred> <saída> [<de> <para> <n> ...]
  python3 - "$MIG" "$FIX_VIEWS" "$SABOTAGEM" "$@" <<'PYGEN' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM): gerar $1"; exit 9; }
import sys
mig_path, fix_path, sab, modo, out = sys.argv[1:6]
trocas = sys.argv[6:]
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
    elif sab == "sem_pre":
        s = corta(s, "DO $pre$", "$pre$;\n")
    elif sab == "pos_sem_md5":
        s = corta(s, "  IF v_md5 <> '", "  END IF;\n")
    elif sab == "pos_sem_invoker":
        s = corta(s, "  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o", "  END IF;\n")
    elif sab == "pre_sem_este":
        de = "NOT IN ('1c8885b860f65f5c76b1fd5314b96e28', '879fe737d8a8e872ab855c1db35d3179')"
        if s.count(de) != 1:
            sys.exit("lista da PRE não achada")
        s = s.replace(de, "NOT IN ('1c8885b860f65f5c76b1fd5314b96e28')")
    if modo == "parte1":   # a sessão A da trava roda ATÉ o fim da pré-condição e para
        fim = "$pre$;\n" if "$pre$;\n" in s else "$trava$;\n"
        s = s[:s.find(fim) + len(fim)]
elif modo == "view":
    i, j = trecho(mig, "CREATE OR REPLACE VIEW public.v_des_desconto_por_checkin\n", ";\n")
    s = mig[i:j]
elif modo == "pred":
    fx = open(fix_path, encoding="utf-8").read()
    i, j = trecho(fx, "CREATE VIEW public.v_des_desconto_por_checkin\n", ";\n")
    s = "CREATE OR REPLACE VIEW" + fx[i + len("CREATE VIEW"):j]
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
NL=$'\n'
WHERE_NOVO="cp2.faixa_id = checkin_com_faixa.faixa_id AND cq2.contrato_versao_id = (( SELECT des_contrato_versao.id${NL}                   FROM des_contrato_versao${NL}                  WHERE des_contrato_versao.versao = '2026'::text))))"
WHERE_VELHO="cp2.faixa_id = cp2.faixa_id))"

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que a view lê. Colunas e TIPOS conferidos na prod via psql-ro
# (2026-09-29) — são os que o deparse imprime (o P1 exige o md5 da prod). Restrições que o
# argumento "cada critério conta 1×" usa, iguais às da prod: UNIQUE(versao),
# UNIQUE(contrato_versao_id, codigo), UNIQUE(criterio_id, faixa_id), faixa_id NOT NULL.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- Na prod são VIEWS (o check-in mais recente e a posição do trimestre); para o deparse de
-- v_des_desconto_por_checkin só nome, colunas e tipos importam — e o seed escolhe a faixa.
CREATE TABLE public.v_des_checkin_atual (
  empresa text, ano integer, trimestre integer, checkin_id bigint, data_avaliacao date, tipo text,
  avaliado_com text, avaliado_por text, codigo text, nome text, criterio_tipo text, atingido boolean,
  observacao_criterio text
);
CREATE TABLE public.v_des_posicao_trimestre_ao_vivo (
  empresa text, ano integer, trimestre integer, faixa_conservadora json
);
CREATE TABLE public.des_contrato_versao (
  id bigint PRIMARY KEY, versao text NOT NULL UNIQUE, data_inicio_vigencia date, data_fim_vigencia date,
  observacoes text, criado_em timestamptz
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

-- RLS como na prod: só staff lê as bases DES (a view, security_invoker, lê como quem chama).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['v_des_checkin_atual', 'v_des_posicao_trimestre_ao_vivo', 'des_contrato_versao',
                           'des_criterio_qualitativo', 'des_criterio_percentual'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY staff_le ON public.%I FOR SELECT TO authenticated
                      USING (public.has_role(auth.uid(), 'master'::public.app_role)
                             OR public.has_role(auth.uid(), 'employee'::public.app_role))$p$, t);
  END LOOP;
END
$rls$;
SQL

# OS PREDECESSORES: a view como a prod a tem (fixture), com o grant que a prod dá a authenticated.
gerar pred "$TMPD/pred.sql"
P -q -f "$TMPD/pred.sql"
P -q -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (antes da migration: o predecessor EXECUTADO é a linha de base do V1)
#   versão 2026 (id 1): faixas 11/12/13 = nº 1/2/3 (ids ≠ números de propósito); versão 2027 (id 2):
#   faixa 21. Faixa 11: 1,50 + 1,25 + 0,75 + bônus 1,00 = 4,50 (+ 0,60 de um critério da 2027 —
#   só o filtro de versão o tira). Faixa 12: 1,00 + 0,80 + 0,45 + bônus 1,00 = 3,25. Faixa 13: nada.
#   Soma global (a tautologia): 4,50 + 3,25 + 3,00 + 0,60 = 11,35.
#   Check-ins (1º tri 2026): 1 = empresa A, faixa 11, mix e pdv atingidos; 2 = B, faixa 12, TUDO
#   atingido; 3 = C, faixa 13, mix atingido; 4 = D, sem faixa (fica fora da view, como hoje).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$CLIENTE', 'customer');
INSERT INTO public.des_contrato_versao (id, versao) VALUES (1, '2026'), (2, '2027');
INSERT INTO public.des_criterio_qualitativo (id, contrato_versao_id, codigo, nome, ordem, tipo) VALUES
  (101, 1, 'mix_produtos',     'Mix',   1, 'qualitativo'),
  (102, 1, 'cursos_tecnicos',  'Cursos', 2, 'qualitativo'),
  (103, 1, 'visibilidade_pdv', 'PDV',   3, 'qualitativo'),
  (109, 1, 'bonus_objetivo',   'Bonus', 9, 'bonus'),
  (201, 2, 'mix_produtos',     'Mix',   1, 'qualitativo'),
  (209, 2, 'bonus_objetivo',   'Bonus', 9, 'bonus');
INSERT INTO public.des_criterio_percentual (id, criterio_id, faixa_id, percentual) VALUES
  (1, 101, 11, 1.50), (2, 102, 11, 1.25), (3, 103, 11, 0.75), (4, 109, 11, 1.00),
  (5, 101, 12, 1.00), (6, 102, 12, 0.80), (7, 103, 12, 0.45), (8, 109, 12, 1.00),
  (9, 201, 21, 2.00), (10, 209, 21, 1.00),
  (11, 201, 11, 0.60);
INSERT INTO public.v_des_posicao_trimestre_ao_vivo (empresa, ano, trimestre, faixa_conservadora) VALUES
  ('A', 2026, 1, '{"faixa_id": 11, "faixa_numero": 1, "estrelas": 6, "desconto_padrao_perc": 6.00}'),
  ('B', 2026, 1, '{"faixa_id": 12, "faixa_numero": 2, "estrelas": 5, "desconto_padrao_perc": 5.40}'),
  ('C', 2026, 1, '{"faixa_id": 13, "faixa_numero": 3, "estrelas": 4, "desconto_padrao_perc": 4.86}'),
  ('D', 2026, 1, NULL);
INSERT INTO public.v_des_checkin_atual (empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, codigo, nome, criterio_tipo, atingido) VALUES
  ('A', 2026, 1, 1, '2026-03-10', 'projecao', 'mix_produtos',     'Mix',    'qualitativo', true),
  ('A', 2026, 1, 1, '2026-03-10', 'projecao', 'cursos_tecnicos',  'Cursos', 'qualitativo', false),
  ('A', 2026, 1, 1, '2026-03-10', 'projecao', 'visibilidade_pdv', 'PDV',    'qualitativo', true),
  ('A', 2026, 1, 1, '2026-03-10', 'projecao', 'bonus_objetivo',   'Bonus',  'bonus',       false),
  ('B', 2026, 1, 2, '2026-03-11', 'confirmacao_andre', 'mix_produtos',     'Mix',    'qualitativo', true),
  ('B', 2026, 1, 2, '2026-03-11', 'confirmacao_andre', 'cursos_tecnicos',  'Cursos', 'qualitativo', true),
  ('B', 2026, 1, 2, '2026-03-11', 'confirmacao_andre', 'visibilidade_pdv', 'PDV',    'qualitativo', true),
  ('B', 2026, 1, 2, '2026-03-11', 'confirmacao_andre', 'bonus_objetivo',   'Bonus',  'bonus',       true),
  ('C', 2026, 1, 3, '2026-03-12', 'projecao', 'mix_produtos',     'Mix',    'qualitativo', true),
  ('C', 2026, 1, 3, '2026-03-12', 'projecao', 'bonus_objetivo',   'Bonus',  'bonus',       false),
  ('D', 2026, 1, 4, '2026-03-13', 'projecao', 'mix_produtos',     'Mix',    'qualitativo', true);
SQL

Q_MAX="SELECT COALESCE(desconto_total_maximo::text, 'NULO') FROM public.v_des_desconto_por_checkin WHERE checkin_id ="
Q_VIZ="SELECT md5(string_agg(concat_ws('|', empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, faixa_numero, estrelas,
         desconto_padrao, qualitativos_atingidos_perc, bonus_atingido_perc, desconto_total_projetado), E'\n' ORDER BY checkin_id))
       FROM public.v_des_desconto_por_checkin"
Q_MD5="SELECT md5(pg_get_viewdef('public.v_des_desconto_por_checkin'::regclass, true))"

eq P1 "o predecessor (fixture) = o da prod: é o que a PRÉ reconhece" "$(Exec "$Q_MD5")" "$MD5_PROD_PRED"
eq B0 "predecessor EXECUTADO: o máximo do check-in 1 soma TODAS as faixas (6,00 + 11,35)" "$(Exec "$Q_MAX 1")" 17.35
eq V0 "predecessor: 3 linhas (o check-in sem faixa fica fora) — o V1 não compara vazio com vazio" \
  "$(Exec "SELECT count(*) FROM public.v_des_desconto_por_checkin")" 3
VIZ_ANTES="$(Exec "$Q_VIZ")"

# ══════════════════════════════════════════════════════════════════════════════
# K1 — A TRAVA. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a transação
# aberta: o instante em que, sem trava, outra transação recriaria a view e o CREATE OR REPLACE
# desta apagaria a mudança dela em silêncio. B tenta mexer na view com lock_timeout e tem de ser
# BARRADA (55P03). A mexida de B é um ALTER sem efeito: o que se mede é se ela CONSEGUE o lock.
# Sem a trava, nada prende a view: o deparse da PRÉ solta o lock dela ao terminar (só as relações
# que ela LÊ ficam presas até o fim da transação).
# ══════════════════════════════════════════════════════════════════════════════
gerar parte1 "$TMPD/parte1.sql"
mkfifo "$TMPD/a.in"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -qAt < "$TMPD/a.in" > "$TMPD/a.out" 2>&1 &
PID_A=$!
exec 7> "$TMPD/a.in"
printf 'BEGIN;\n\\i %s\n\\! touch %s\n' "$TMPD/parte1.sql" "$TMPD/a.pronta" >&7
# Espera COM TETO e com o ramo que diz "não consegui": a sessão morta ou lenta não vira "barrou".
for _ in $(seq 1 150); do
  [ -e "$TMPD/a.pronta" ] && break
  kill -0 "$PID_A" 2>/dev/null || break
  sleep 0.2
done
if [ ! -e "$TMPD/a.pronta" ]; then
  echo "❌ K: a sessão A não chegou ao fim da pré-condição — a trava não foi posta à prova"
  head -c 600 "$TMPD/a.out"; exit 1
fi
eq K1 "com A parada após a pré-condição, B não mexe na view" \
  "$(Nega "ALTER VIEW public.v_des_desconto_por_checkin SET (security_invoker = on)" 55P03 '' '-c lock_timeout=1500')" NEGOU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1), numa transação só, como o `db:aplicar` a roda.
# ══════════════════════════════════════════════════════════════════════════════
P -q -1 -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (trava, PRÉ e PÓS passaram)"

# ══════════════════════════════════════════════════════════════════════════════
# K2-K5 — O ENVELOPE, em transações que terminam em ROLLBACK (o estado segue o da migration).
# K3/K4 partem do PREDECESSOR vivo, para a PRÉ não ser a camada que barra.
# ══════════════════════════════════════════════════════════════════════════════
gerar mig "$TMPD/k_mig.sql"
gerar pred "$TMPD/k_pred.sql"
gerar view "$TMPD/k_terceira.sql" "'2026'::text)))) AS desconto_total_maximo" "'2027'::text)))) AS desconto_total_maximo" 1
gerar mig "$TMPD/k_sem_with.sql" "WITH (security_invoker = on) AS" "AS" 1
gerar mig "$TMPD/k_corpo_errado.sql" "$WHERE_NOVO" "$WHERE_VELHO" 1
eq K2 "PRÉ: sobre uma 3ª versão viva (mudança concorrente), a migration aborta" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU' "$TMPD/k_terceira.sql")" NEGOU
eq K3 "PÓS: um replace SEM o WITH aborta (a view passaria a ler como dono)" \
  "$(Aplica "$TMPD/k_sem_with.sql" 'POS3 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K4 "PÓS: um corpo que não é o do md5 aborta" \
  "$(Aplica "$TMPD/k_corpo_errado.sql" 'POS2 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K5 "reaplicar sobre ela mesma passa (a PRÉ aceita este)" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU')" PASSOU

# ── SABOTAGEM da view (só no modo --falsificar) — no BANCO, recriando a view instalada com o trecho
# trocado; o repo nunca é tocado. As de envelope já entraram pelo `gerar` (K1-K5).
sabotar() { gerar view "$TMPD/sab.sql" "$@"; P -q -f "$TMPD/sab.sql"; }
case "$SABOTAGEM" in
  tautologia)        sabotar "$WHERE_NOVO" "$WHERE_VELHO" 1 ;;
  sem_filtro_versao) sabotar "$WHERE_NOVO" "cp2.faixa_id = checkin_com_faixa.faixa_id))" 1 ;;
  faixa_por_numero)  sabotar "cp2.faixa_id = checkin_com_faixa.faixa_id" "cp2.faixa_id = checkin_com_faixa.faixa_numero" 1 ;;
  so_qualitativos)   sabotar "cp2.faixa_id = checkin_com_faixa.faixa_id AND" \
                             "cp2.faixa_id = checkin_com_faixa.faixa_id AND cq2.tipo = 'qualitativo'::text AND" 1 ;;
  coalesce_zero)     sabotar "desconto_padrao + (( SELECT sum(cp2.percentual) AS sum" \
                             "desconto_padrao + COALESCE(( SELECT sum(cp2.percentual) AS sum" 1 \
                             "'2026'::text)))) AS desconto_total_maximo" "'2026'::text))), 0::numeric) AS desconto_total_maximo" 1 ;;
  vizinha_alterada)  sabotar "vca.atingido," "NOT vca.atingido AS atingido," 1 ;;
  sem_invoker)       sabotar "WITH (security_invoker = on) AS" "AS" 1 ;;
  *) ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
eq P2 "instalada = a da PÓS (search_path do executor)" "$(Exec "$Q_MD5")" "$MD5_ESTE"
eq P3 "... e o mesmo md5 sob o search_path padrão" "$(Pq -c "$Q_MD5" 2>&1 || true)" "$MD5_ESTE"
eq B1 "faixa 11: 6,00 + 4,50 dela — nem a soma global, nem o critério de outra versão" "$(Exec "$Q_MAX 1")" 10.50
eq B2 "faixa 12: 5,40 + 3,25 dela (soma DIFERENTE da faixa 11)" "$(Exec "$Q_MAX 2")" 8.65
eq B3 "faixa sem percentual cadastrado: NULL (ausente ≠ zero), nunca o padrão sozinho" "$(Exec "$Q_MAX 3")" NULO
eq B4 "tudo atingido: o projetado É o máximo (o bônus está dentro do máximo)" \
  "$(Exec "SELECT COALESCE((desconto_total_projetado = desconto_total_maximo)::text, 'NULO') FROM public.v_des_desconto_por_checkin WHERE checkin_id = 2")" true
eq B5 "nenhuma linha com projetado acima do máximo" \
  "$(Exec "SELECT count(*) FROM public.v_des_desconto_por_checkin WHERE desconto_total_projetado > desconto_total_maximo")" 0
eq V1 "as outras 12 colunas saem idênticas às do predecessor, linha a linha" "$(Exec "$Q_VIZ")" "$VIZ_ANTES"
eq S1 "security_invoker segue ligado" \
  "$(Exec "SELECT COALESCE(bool_or(lower(o) IN ('security_invoker=on', 'security_invoker=true'))::text, 'NULO')
           FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = 'public.v_des_desconto_por_checkin'::regclass")" true
eq S2 "cliente autenticado não lê nenhuma linha (a RLS das bases vale através da view)" \
  "$(Como "$CLIENTE" "SELECT count(*) FROM public.v_des_desconto_por_checkin")" 0
eq S3 "master lê as 3 (o 0 do S2 não é view vazia)" \
  "$(Como "$MASTER" "SELECT count(*) FROM public.v_des_desconto_por_checkin")" 3

echo "════════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL (esperados $TOTAL_ESPERADO)"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executou $PASS asserts, o denominador é $TOTAL_ESPERADO — bloco que não rodou é vermelho"
  exit 1
fi
[ "$FAIL" -eq 0 ]
