#!/usr/bin/env bash
# REGRESSÃO — o DEFAULT de route_visits.visit_date é o dia de SÃO PAULO, seja qual for o fuso da SESSÃO
# (20261001043717_hoje_sp_route_visits_visit_date.sql — a fase visitas da classe (ii), fase 3).
#
# A prod roda sessão UTC. Os 3 check-ins do app OMITEM visit_date: das 21:00 às 23:59 BRT o DEFAULT
# carimbava AMANHÃ, e o trigger reconcile_visita_agendada (scheduled_date <= NEW.visit_date) dava baixa
# na visita agendada para amanhã — que sumia da agenda antes de acontecer.
#
# O que se prova:
#   P01 — o DEFAULT predecessor (o texto do pg_get_expr) é o da prod; P02 — o corpo do trigger
#         reconcile_visita_agendada (md5 do prosrc) e o gatilho dele são os da prod: o ponta a ponta exerce
#         o código que roda lá.
#   K1/K2 — a trava: com a sessão A parada logo depois da PRÉ, B não mexe na coluna (K1) e nem LÊ a tabela
#         (K2 — é o ACCESS EXCLUSIVE já na entrada; travar mais fraco viraria upgrade de lock no ALTER).
#   Z0 — o pin.
#   D01 a/b/c/d — os 4 asserts dos DEFAULTs da fase 2 (db/test-hoje-sp-views-defaults.sh):
#     a — sob sessão UTC, a linha das 21:00:00 BRT de D nasce com D;
#     b — às 23:59:59 BRT de D, sessão UTC e sessão SP dão o MESMO dia;
#     c — CONTROLE POSITIVO: sob sessão UTC, à 00:00:00 BRT de D+1 já é D+1 (o DEFAULT lê o relógio
#         controlado — sem isto, a e b passariam por vacuidade);
#     d — o mesmo que (a) sob sessão SP: VERDE na sabotagem do gêmeo da sessão (o defeito só aparece na
#         sessão UTC); só o relógio de parede o derruba.
#   E1/E2/E3 — ponta a ponta com o trigger. Só a visita agendada para D+1 está pendente:
#     E1 — o check-in das 22:30 BRT de D (sessão UTC) NÃO dá baixa nela;
#     E2 — CONTROLE POSITIVO: o check-in da 00:30 BRT de D+1 dá (o trigger roda e casa as linhas);
#     E3 — o das 22:30 BRT de D sob sessão SP também não dá.
#   G1/G2/G3 — a PRÉ recusa DEFAULT divergente, a PÓS recusa DEFAULT adulterado, re-aplicar passa.
#
# ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) sem a GUC. O dia da sessão NÃO é
# função — nenhum sombreamento o alcança —, por isso o DEFAULT antigo não entra na falsificação como tal:
# entra o GÊMEO controlável dele (o now() truncado em date no fuso da SESSÃO).
#
# Rodar:   bash db/test-hoje-sp-visitas.sh > log 2>&1; echo $?
#          bash db/test-hoje-sp-visitas.sh --falsificar > log 2>&1
# matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5541}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="hoje-sp-visitas"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261001043717_hoje_sp_route_visits_visit_date.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
# Denominador: P01 P02 · K1 K2 · Z0 · D01 × a,b,c,d · E1 E2 E3 · G1 G2 G3.
TOTAL_ESPERADO=15

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas as
# sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar vermelhos por
# RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro de execução —
# sabotagem que não aplicou, SQL quebrado, saída vazia, tripwire — NÃO mata mutante e reprova a
# falsificação; a única exceção é declarada POR ASSERT (`ID!MARCA`: sem_pin, cujo vermelho esperado É o
# tripwire no assert que lê pelo pin).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  # default_sessao: o GÊMEO do dia da sessão — vermelho na sessão UTC à noite (a, b, E1); verde no que o
  #   gêmeo também acerta (c: valor de D+1; d e E3: sob sessão SP; E2: a baixa da 00:30).
  # default_em_utc_escrito: o fuso ESCRITO, mas o errado — independe da sessão (b verde) e erra à noite.
  # default_de_parede: o relógio de parede, que o controlado não intercepta — o dia de hoje de verdade.
  SABOTAGENS="default_sessao:D01a,D01b,E1:D01c,D01d,E2,E3
              default_em_utc_escrito:D01a,D01d,E1,E3:D01b,D01c,E2
              default_de_parede:D01a,D01c,D01d,E1,E3:D01b,E2
              sem_pin:Z0!TRIPWIRE:D01a
              sem_trava:K1,K2:P01,P02
              trava_fraca:K2:K1
              pre_removida:G1:G2,G3
              pos_removida:G2:G1,G3"
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
    faltou=""; sobrou=""; ids_erro=""
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"; ids_erro="$ids_erro $id"
             grep -Eq "(^|[^A-Za-z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    # Erro de execução só vale NO assert que o declarou (`ID!MARCA`); em qualquer outro, reprova — senão a
    # exceção de um assert viraria licença para a suíte inteira.
    intrusos=""
    for id in $(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u || true); do
      case " $ids_erro " in *" $id "*) ;; *) intrusos="$intrusos $id" ;; esac
    done
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$intrusos" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$intrusos" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO fora do declarado em:${intrusos} — vermelho que não é do assert não mata mutante"
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

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
invalido() { case "$1" in ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*) return 0 ;; *) return 1 ;; esac; }
# Um VALOR que é erro (psql, tripwire) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}
# Roda um arquivo SQL numa transação que VOLTA ATRÁS, como função: 'PASSOU' se não levantou nada;
# 'NEGOU' se levantou a SQLSTATE e a marca ESPERADAS; qualquer outro erro sai como ERRO (o `eq` o lê como
# execução, não como dente). É o que põe a PRÉ e a PÓS da migration à prova sem deixar rastro no banco.
# shellcheck disable=SC2016  # $f$ e $tenta$ são dollar-quotes do SQL gerado, não expansão do shell
Tenta() {   # <arquivo com o SQL> <sqlstate> <marca>
  local f="$TMPD/tenta.$RANDOM.sql"
  {
    printf 'BEGIN;\n'
    printf 'CREATE FUNCTION pg_temp.tenta(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS $f$\n'
    printf 'BEGIN\n  EXECUTE p_sql;\n  RETURN %s;\nEXCEPTION WHEN OTHERS THEN\n' "'PASSOU'"
    printf '  IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN %s; END IF;\n  RAISE;\nEND $f$;\n' "'NEGOU'"
    printf 'SELECT pg_temp.tenta($tenta$'
    cat "$1"
    printf '$tenta$, %s, %s);\nROLLBACK;\n' "'$2'" "'$3'"
  } > "$f"
  PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=2025-03-12T15:00:00Z" Pq -q -f "$f" 2>&1 || true
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única). O snapshot traz route_visits e
# visitas_agendadas com os TIPOS da prod, o DEFAULT predecessor, e o trigger com o corpo da prod.
# ══════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — criado ANTES da migration: o DEFAULT amarra o `now()` no ALTER (pelo search_path de
# quem altera). `public.now()` lê a GUC `test.agora` e é TRIPWIRE: sem ela levanta Z9T01 em vez de cair no
# relógio de parede.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora — a prova escapou do relógio controlado'
      USING ERRCODE = 'Z9T01';
  END IF;
  RETURN v::timestamptz;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# P — O PREDECESSOR É O DA PROD (psql-ro, 2026-10-01): é o ensaio do predicado da PRÉ, e a garantia de que
# o ponta a ponta (E) exerce o trigger que roda lá.
# ══════════════════════════════════════════════════════════════════════════════
Exec() { PGOPTIONS="-c search_path=public,pg_catalog,pg_temp" Pq -c "$1" 2>&1 || true; }
expr_default() {
  Exec "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = 'public.route_visits'::regclass AND a.attname = 'visit_date'"
}
DIA_SESSAO="CURRENT""_DATE"   # a agulha partida: o texto antigo do DEFAULT, sem citá-lo inteiro
eq P01 "route_visits.visit_date predecessor = prod" "$(expr_default)" "$DIA_SESSAO"
eq P02 "reconcile_visita_agendada (md5 do corpo) e o gatilho em route_visits = prod" \
  "$(Exec "SELECT md5(p.prosrc) || ':' || (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.route_visits'::regclass
             AND t.tgname = 'trg_reconcile_visita_agendada' AND t.tgfoid = p.oid AND t.tgenabled = 'O')
           FROM pg_proc p WHERE p.oid = 'public.reconcile_visita_agendada()'::regprocedure")" \
  "06eb0e8328ad94116d316807a99b986b:1"

# ══════════════════════════════════════════════════════════════════════════════
# K — A TRAVA. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a transação aberta: o
# instante em que, sem trava, outra transação trocaria o DEFAULT e o ALTER a apagaria em silêncio. B tenta
# com lock_timeout e tem de ser BARRADA (55P03). A mexida de B não tem efeito (SET STATISTICS -1 é o valor
# que já está): o que se mede é se ela CONSEGUE o lock. K2 mede o NÍVEL: nem a leitura passa — a trava já é
# o ACCESS EXCLUSIVE que o ALTER toma. sem_trava: a sessão A roda só a pré-condição; trava_fraca: SHARE
# UPDATE EXCLUSIVE (a leitura passaria, e o ALTER subiria o lock no meio da transação).
# ══════════════════════════════════════════════════════════════════════════════
python3 - "$MIG" "$TMPD/parte1.sql" "$SABOTAGEM" <<'PYP1'
import sys
mig, out, sab = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(mig, encoding="utf-8").read()
fim = s.find("$pre$;")
if fim < 0:
    sys.exit("fim da pré-condição ($pre$;) não achado em " + mig)
parte = s[:fim + len("$pre$;")]
if sab == "sem_trava":
    ini, fim_t = parte.find("DO $trava$"), parte.find("$trava$;")
    if ini < 0 or fim_t < 0:
        sys.exit("bloco $trava$ não achado")
    parte = parte[:ini] + parte[fim_t + len("$trava$;"):]
elif sab == "trava_fraca":
    forte = "IN ACCESS EXCLUSIVE MODE"
    if parte.count(forte) != 1:
        sys.exit("modo da trava não achado 1x")
    parte = parte.replace(forte, "IN SHARE UPDATE EXCLUSIVE MODE")
open(out, "w", encoding="utf-8").write(parte + "\n")
PYP1
mkfifo "$TMPD/a.in"
PGOPTIONS="-c search_path=public,pg_catalog" "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove \
  -v ON_ERROR_STOP=1 -qAt < "$TMPD/a.in" > "$TMPD/a.out" 2>&1 &
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
barra() {   # <sql> — 'BARROU' se B tomou lock_timeout (55P03); 'PASSOU' se conseguiu; o resto é ERRO
  PGOPTIONS="-c lock_timeout=1500" Pq -q -c "
    CREATE FUNCTION pg_temp.barra(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
    BEGIN
      EXECUTE p_sql;
      RETURN 'PASSOU';
    EXCEPTION WHEN lock_not_available THEN
      RETURN 'BARROU';
    END \$f\$;
    SELECT pg_temp.barra(\$q\$$1\$q\$);" 2>&1 || true
}
eq K1 "com A parada após a pré-condição, B não mexe na coluna" \
  "$(barra "ALTER TABLE public.route_visits ALTER COLUMN visit_date SET STATISTICS -1")" BARROU
eq K2 "... nem LÊ a tabela: a trava já é o ACCESS EXCLUSIVE do ALTER" \
  "$(barra "SELECT count(*) FROM public.route_visits")" BARROU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL, com a PRÉ e a PÓS dela. Aplicada com `pg_catalog` DEPOIS de `public` para o
# DEFAULT amarrar o now() controlado (na prod amarra o de pg_catalog: o texto do deparse é o mesmo,
# `now()`, e é por isso que a PÓS vale nos dois lugares).
# ══════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q --single-transaction -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"

# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA assinatura de um
# embutido passa a vencê-lo — inclusive as que o DEFAULT chama por sintaxe (`AT TIME ZONE` é `timezone(...)`).
# A guarda pergunta ao CATÁLOGO: das funções de `public` que sombreiam `pg_catalog`, de quais o DEFAULT
# DEPENDE (pg_depend, o que ficou amarrado no ALTER)? Tem de ser só o nosso now(). Controle POSITIVO: se
# não vê nem ele, está cega (e o DEFAULT não lê o relógio controlado) — aborta.
sombra="$(Pq -c "SELECT COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname <> 'now'), '')
  FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                AND c.proname = p.proname AND c.proargtypes = p.proargtypes)
   AND d.classid = 'pg_attrdef'::regclass AND d.objid IN (
         SELECT ad.oid FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
          WHERE ad.adrelid = 'public.route_visits'::regclass AND a.attname = 'visit_date');")"
case "$sombra" in
  'now|') echo "guarda de sombra: o DEFAULT depende só do now() controlado entre os nomes sombreados (controle positivo visto)" ;;
  now\|*) echo "❌ o DEFAULT amarrou mais que o now() a public: [${sombra#*|}] — a prova rodaria outra semântica"; exit 1 ;;
  *) echo "❌ guarda cega: o DEFAULT não depende do public.now() — não lê o relógio controlado [$sombra]"; exit 1 ;;
esac

# Os G rodam AQUI, sobre o estado limpo pós-migration e ANTES de qualquer sabotagem do DEFAULT: eles
# re-executam a migration, e um DEFAULT sabotado faria a PRÉ acusar (com razão) predecessor divergente.
echo "── G: a PRÉ e a PÓS da migration, postas à prova (numa transação que volta atrás)"
# G1: um DEFAULT DIVERGENTE (outra mudança chegou antes) — a migration tem de abortar na PRÉ.
# G2: a migration com o DEFAULT ADULTERADO (outro fuso) — a PÓS tem de recusar.
# G3: re-aplicar a migration inteira sobre ela mesma passa (a PRÉ aceita "já esta").
python3 - "$MIG" "$TMPD" "$SABOTAGEM" <<'PYG'
import sys
mig, tmpd, sab = sys.argv[1], sys.argv[2], sys.argv[3]
m = open(mig, encoding="utf-8").read()

def sem(texto, tag):
    ini, fim = texto.find("DO $" + tag + "$"), texto.find("$" + tag + "$;")
    if ini < 0 or fim < 0:
        sys.exit("bloco $" + tag + "$ não achado")
    return texto[:ini] + texto[fim + len("$" + tag + "$;"):]

COND_PRE = "IF v_vivo IS DISTINCT FROM 'CURRENT' || '_DATE'"
if sab == "pre_removida":
    if m.count(COND_PRE) != 1:
        sys.exit("condição da PRÉ não achada 1x")
    migracao = m.replace(COND_PRE, "IF false AND v_vivo IS DISTINCT FROM 'CURRENT' || '_DATE'")
else:
    migracao = m
divergente = "ALTER TABLE public.route_visits ALTER COLUMN visit_date SET DEFAULT ((now() AT TIME ZONE 'America/Manaus'::text))::date;\n"
open(tmpd + "/g1.sql", "w", encoding="utf-8").write(divergente + migracao)

ALTER = "ALTER TABLE public.route_visits ALTER COLUMN visit_date SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;"
migracao = sem(m, "post") if sab == "pos_removida" else m
if migracao.count(ALTER) != 1:
    sys.exit("ALTER do DEFAULT não achado 1x na migration")
open(tmpd + "/g2.sql", "w", encoding="utf-8").write(migracao.replace(ALTER, ALTER.replace("America/Sao_Paulo", "America/Manaus")))
open(tmpd + "/g3.sql", "w", encoding="utf-8").write(m)
PYG
eq G1 "DEFAULT divergente: a migration aborta na PRÉ" "$(Tenta "$TMPD/g1.sql" P0001 'PRE FALHOU')" NEGOU
eq G2 "DEFAULT adulterado: a PÓS recusa" "$(Tenta "$TMPD/g2.sql" P0001 'POS1 FALHOU')" NEGOU
eq G3 "re-aplicar a migration sobre ela mesma passa" "$(Tenta "$TMPD/g3.sql" P0001 'nunca')" PASSOU

# ── SABOTAGEM (só no modo --falsificar) — no BANCO, trocando o DEFAULT instalado; o repo nunca é tocado.
# O GÊMEO controlável do texto antigo: o dia truncado no fuso da SESSÃO. Monta-se das peças (as agulhas
# inteiras não aparecem neste arquivo: os gates de prova leem todo shell de db/).
AGORA="now()"
GEMEO_DIA="(${AGORA})::date"
sabotar_default() {   # <expressão>
  PGOPTIONS="-c search_path=public,pg_catalog" P -q -c "ALTER TABLE public.route_visits ALTER COLUMN visit_date SET DEFAULT $1;" >/dev/null
}
case "$SABOTAGEM" in
  "") ;;
  sem_pin|sem_trava|trava_fraca|pre_removida|pos_removida) ;;   # agem mais adiante (pin) ou já agiram (K, G)
  default_sessao) sabotar_default "$GEMEO_DIA" ;;
  # o fuso ESCRITO, mas o errado
  default_em_utc_escrito) sabotar_default "(${AGORA} AT TIME ZONE 'UTC'::text)::date" ;;
  # o relógio de parede, que o controlado não intercepta
  default_de_parede) sabotar_default "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'::text)::date" ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# O pin: toda conexão nova nasce em 12/03/2025 15:00Z (12:00 BRT, o mesmo dia nos dois fusos). Z0 lê por
# ele; os blocos por sessão trocam o instante no pacote de conexão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-03-12 15:00:00+00';"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (datas e instantes LITERAIS; nenhuma semente lê relógio). D = qua 12/03/2025. Uma visita
# AGENDADA para D+1, pendente, do vendedor S ao cliente C — a única: é ela que o check-in noturno de D, com
# o dia UTC, levaria embora. `session_replication_role = replica`: a semente não dispara gatilhos.
# ══════════════════════════════════════════════════════════════════════════════
CLI='0b000000-0000-0000-0000-0000000000c1'
VEN='0b000000-0000-0000-0000-0000000000a1'
AGE='0e000000-0000-0000-0000-000000000001'
P -q <<SQL
SET session_replication_role = replica;
INSERT INTO public.visitas_agendadas (id, customer_user_id, scheduled_by, scheduled_date, status, created_at, updated_at)
VALUES ('$AGE', '$CLI', '$VEN', DATE '2025-03-13', 'pendente', '2025-03-10 15:00:00+00', '2025-03-10 15:00:00+00');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# CONTROLES E BLOCOS
# ══════════════════════════════════════════════════════════════════════════════
T2='2025-03-13T00:00:00Z'   # 21:00:00 BRT de D — o UTC já é D+1
TN='2025-03-13T01:30:00Z'   # 22:30:00 BRT de D
T3='2025-03-13T02:59:59Z'   # 23:59:59 BRT de D
T4='2025-03-13T03:00:00Z'   # 00:00:00 BRT de D+1
TM='2025-03-13T03:30:00Z'   # 00:30:00 BRT de D+1
UTC=UTC; SPZ=America/Sao_Paulo
# A linha que OMITE visit_date (como os 3 check-ins do app), inserida e desfeita.
LerDefault() {   # <TimeZone> <instante>
  PGOPTIONS="-c TimeZone=$1 -c test.agora=$2 -c session_replication_role=replica" \
    Pq -q -c "BEGIN" -c "INSERT INTO public.route_visits (customer_user_id, visited_by) VALUES ('$CLI', '$VEN') RETURNING visit_date" -c "ROLLBACK" 2>&1 || true
}
# O check-in do app, com os gatilhos LIGADOS, e o estado da agendada de D+1 logo depois; desfeito.
LerCheckin() {   # <TimeZone> <instante>
  PGOPTIONS="-c TimeZone=$1 -c test.agora=$2" \
    Pq -q -c "BEGIN" \
       -c "INSERT INTO public.route_visits (customer_user_id, visited_by, visit_type, check_in_at) VALUES ('$CLI', '$VEN', 'comercial', '$2')" \
       -c "SELECT status FROM public.visitas_agendadas WHERE id = '$AGE'" -c "ROLLBACK" 2>&1 || true
}

# Z0: lida SEM instante no pacote de conexão (vale o pin), a linha nasce com o mesmo dia que no instante do pin.
LerPin() {
  PGOPTIONS="-c session_replication_role=replica" \
    Pq -q -c "BEGIN" -c "INSERT INTO public.route_visits (customer_user_id, visited_by) VALUES ('$CLI', '$VEN') RETURNING visit_date" -c "ROLLBACK" 2>&1 || true
}
pin="$(LerPin)"; no_instante="$(LerDefault "$UTC" '2025-03-12T15:00:00Z')"
if invalido "$pin" || invalido "$no_instante"; then
  erro_exec Z0 "leitura inválida [$(printf '%s | %s' "$pin" "$no_instante" | tr '\n' ' ' | head -c 220)]"
else
  eq Z0 "visit_date pelo pin = no instante do pin" "$pin" "$no_instante"
fi

echo "── DEFAULT: a (21:00 = D, UTC) · b (UTC = SP às 23:59:59) · c (D+1 à 00:00 de SP) · d (a, sob SP)"
eq D01a "linha das 21:00:00 BRT (sessão UTC) nasce com o dia de SP" "$(LerDefault "$UTC" "$T2")" 2025-03-12
def_u="$(LerDefault "$UTC" "$T3")"; def_s="$(LerDefault "$SPZ" "$T3")"
if invalido "$def_u" || invalido "$def_s"; then
  erro_exec D01b "leitura inválida [$def_u | $def_s]"
elif [ "$def_u" = "$def_s" ]; then ok D01b "sessão UTC = sessão SP às 23:59:59 BRT (=$def_u)"
else bad D01b "sessão UTC [$def_u] ≠ sessão SP [$def_s] às 23:59:59 BRT"; fi
eq D01c "à 00:00:00 BRT de D+1 (sessão UTC) já é D+1" "$(LerDefault "$UTC" "$T4")" 2025-03-13
eq D01d "linha das 21:00:00 BRT (sessão SP) nasce com o dia de SP" "$(LerDefault "$SPZ" "$T2")" 2025-03-12

echo "── ponta a ponta: o check-in e a visita agendada para AMANHÃ"
eq E1 "check-in às 22:30 BRT de D (sessão UTC) não dá baixa na agendada de D+1" "$(LerCheckin "$UTC" "$TN")" pendente
eq E2 "check-in à 00:30 BRT de D+1 (sessão UTC) dá baixa nela — o trigger roda e casa as linhas" "$(LerCheckin "$UTC" "$TM")" realizada
eq E3 "check-in às 22:30 BRT de D (sessão SP) também não dá baixa" "$(LerCheckin "$SPZ" "$TN")" pendente


echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$PASS" -ne "$TOTAL_ESPERADO" ] && [ "$FAIL" -eq 0 ]; then
  echo "❌ $PASS asserts executados, esperados $TOTAL_ESPERADO — a prova foi TRUNCADA (FAIL=0 com PASS encolhido não é verde)"
  exit 1
fi
[ "$FAIL" -eq 0 ]
