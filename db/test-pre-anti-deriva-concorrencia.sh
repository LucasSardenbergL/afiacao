#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — a corrida PRE anti-deriva × CREATE OR REPLACE concorrente, nos DOIS níveis ║
# ║  Rode:  bash db/test-pre-anti-deriva-concorrencia.sh > /tmp/t.log 2>&1; echo $?          ║
# ║         bash db/test-pre-anti-deriva-concorrencia.sh --falsificar                        ║
# ║  Exit:  0 verde · 1 asserção vermelha · 3 barreira/âncora podre (nada a julgar)          ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════╝
# A corrida (achado do Codex, 2026-09-27): a PRE de uma migration LÊ o corpo vivo num comando e o
# CREATE OR REPLACE GRAVA em outro. Em READ COMMITTED, B troca o objeto e commita no meio → A o
# apaga → a PÓS de A aprova. Duas defesas, provadas aqui em duas sessões com a ordem OBSERVADA
# (pg_blocking_pids / pg_locks; nunca sleep como barreira):
#
# NÍVEL MIGRATION — o template TRAVA → PRE → CREATE → PÓS (db/fixtures/pre-trava-template.sql, a
# instância do que está na skill lovable-db-operator). A sessão A roda até o fim da PRE e PARA;
# B age; A termina. Propriedade P: nenhuma mudança COMMITADA de B some (ou B falhou, ou é o final).
#   M0 função SEM trava: a corrida existe — B commita no meio e some, com A saindo verde (baseline)
#   M1 função COM trava: B (CREATE OR REPLACE) fica preso em A
#   M2 ... e falha alto (XX000) quando A commita
#   M3 ... e P vale, com o corpo de A no ar
#   M4 B que commitou ANTES de A aparece na PRE de A (recusa; o corpo de B fica)
#   V0 view SEM trava: a corrida existe (baseline)
#   V1 view COM trava: B (CREATE OR REPLACE VIEW) fica preso em A
#   V2 ... e, sem PRE, aplica DEPOIS de A e vence — o atrasado sem protocolo é o regime sequencial
#      ("a última a recriar vence"), não esta corrida: a trava protege A, não o mundo
#   V3 view COM trava e B também no padrão: B espera na trava dele e a PRE de B recusa
#   C1 controle inócuo: a trava de A não prende OUTRA função nem OUTRA view
#
# NÍVEL EXECUTOR — a fila de public.aplicar_sql (db/claude-rw-bootstrap.sql) com o db-aplicar.sh
# REAL em dois processos (fixtures db-aplicar-corrida-a/-b: A tem uma BARREIRA de teste entre a PRE
# e o CREATE; nenhuma das duas tem trava de arquivo — o que se prova é a porta):
#   R0 baseline do isolamento, sem porta nenhuma: em REPEATABLE READ a leitura feita DEPOIS de B
#      commitar ainda vê o predecessor, e o CREATE OR REPLACE apaga B sem erro — é por isso que a
#      porta EXIGE READ COMMITTED (o catálogo chega a mostrar as duas versões do mesmo OID)
#   E1 baseline com o corpo REAL de prod (db/fixtures/aplicar-sql-v1-prod.sql, md5 âncora da prod):
#      B aplica inteiro com A parado e A o apaga — os dois saem 0 e o recibo de B mente
#   E2 o delta db/aplicar-executor-serializa.sql aplica pelo PRÓPRIO executor (auto-substituição)
#   E3 o corpo que o delta deixa é o MESMO do bootstrap (e o literal da PRE/PÓS do delta)
#   E4 a porta continua fechada: claude_rw executa; PUBLIC e anon não
#   E5 com a fila: B é visto ESPERANDO a vez (advisory (20260909,1)) enquanto A está parado
#   E6 ... A sai 0, B sai 4 recusado pela PRE, o corpo final é o de A e o recibo de B é 'falhou'
#   E7 a fila é solta no fim (nenhum advisory (20260909,_) sobra)
#   E8 vez ocupada além do lock_timeout: 55P03 com VEZ_OCUPADA, corpo NÃO executado
#   E9 isolamento ≠ READ COMMITTED é recusado antes do corpo (25000, ISOLAMENTO_ERRADO)
#   E10 o mesmo pelo executor real: B em REPEATABLE READ é recusado e o corpo final é o de A
#   E11 controle: a chave bigint de mesmos números NÃO prende a fila (forma (int4,int4) é outra)
#   E12 o delta re-ensaiado sobre si mesmo passa (PRE aceita "já este"; a sonda da PÓS também)
#   E13 o delta sobre um corpo ESTRANHO é recusado pela PRE e o estranho fica
#   E14 o delta com a porta nova QUEBRADA (late-bound) aborta na PÓS e a porta antiga fica
#
# Tudo nos DOIS idiomas do servidor (C e pt_BR — o veredito do executor lê ERROR/ERRO), que aqui é
# também a 2ª amostra de escalonamento. IDs: C<id> e P<id>. `NIVEIS` (default os dois) escolhe o que
# roda: a falsificação roda só o nível que cada sabotagem ataca, com o denominador do recorte.
set -euo pipefail
# Escrever num FIFO cujo leitor morreu (sessão que abortou) mata o script MUDO com SIGPIPE.
trap '' PIPE

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
SLUG=pre-anti-deriva-concorrencia
PORT_BASE="${PGPORT_TEST:-5531}"
BOOT="db/claude-rw-bootstrap.sql"
APLICAR="scripts/db-aplicar.sh"
DELTA="db/aplicar-executor-serializa.sql"
FIX_V1="db/fixtures/aplicar-sql-v1-prod.sql"
FIX_A="db/fixtures/db-aplicar-corrida-a.sql"
FIX_B="db/fixtures/db-aplicar-corrida-b.sql"
TEMPLATE="db/fixtures/pre-trava-template.sql"
SABOTAGEM="${SABOTAGEM:-}"
NIVEIS="${NIVEIS:-migration executor}"
# Denominador por idioma: migration = M0-M4 · V0-V3 · C1 (10) · executor = R0 · E1-E14 (15).
TOTAL_ESPERADO=0
for n in $NIVEIS; do
  case "$n" in
    migration) TOTAL_ESPERADO=$((TOTAL_ESPERADO + 2 * 10)) ;;
    executor)  TOTAL_ESPERADO=$((TOTAL_ESPERADO + 2 * 15)) ;;
    *) echo "NIVEIS desconhecido: $n"; exit 3 ;;
  esac
done

# md5 EXATOS (prosrc / pg_get_viewdef(…, true)), medidos em PG17 — a prova os confere ao montar.
MD5_V1_PROD=ac51b3cea53fa87492e6956ed7a56586     # aplicar_sql de prod, 2026-09-30 (psql-ro)
F_PRED=f150aad8dd266247b8908d3114492975          # SELECT 'predecessor'
F_ESTE=747315aee156042621a96709601ebc31          # SELECT 'este'
F_A=ce03e1a9b01768d820b237f85779e1bf             # SELECT 'A'
F_B=1fe8f919431c965c3e7055c6f7bac3fa             # SELECT 'B'
V_PRED=a27346427e6398a8fc7f605f33cc34a6          # SELECT 'predecessor'::text AS x
V_ESTE=ac35bdc22e565934a8d890d6e3fbbe3d
V_B=11d9287b72ba56d84e9b0b896dfcc0c2

export LC_ALL=C LANG=C
unset LANGUAGE

# ════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: o CONTROLE roda primeiro, na mesma invocação (suíte que já falha sozinha
# aprovaria toda sabotagem). Cada sabotagem declara os asserts que TÊM de ficar vermelhos por
# RESULTADO e os que TÊM de continuar verdes. Formato: <sabotagem>:<vermelhos>:<verdes>.
# ════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="template_sem_trava:CM1,CM2,CM3,CV1,CV2,CV3,PM1,PM2,PM3,PV1,PV2,PV3:CM0,CM4,CV0,CC1,PM0,PM4,PV0,PC1
              sem_fila:CE5,CE6,CE8,PE5,PE6,PE8:CE1,CE9,CE10,CE11,PE1,PE9,PE10,PE11
              sem_guarda_isolamento:CE9,CE10,PE9,PE10:CE5,CE6,CE8,PE5,PE6,PE8,CR0,PR0
              espera_generica:CE8,PE8:CE5,CE6,CE9,PE5,PE6,PE9
              delta_pre_aceita_tudo:CE13,PE13:CE12,CE14,PE12,PE14
              delta_sem_sonda:CE14,PE14:CE12,CE13,PE12,PE13"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT_BASE

  echo "══ CONTROLE (sem sabotagem, os dois níveis) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" NIVEIS="migration executor" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta + 2))     # cada execução sobe DOIS clusters (C e pt_BR)
    log="$LOGDIR/$sab.log"
    # Só o nível que a sabotagem ataca (as verdes declaradas moram nele).
    niv=executor; [ "$sab" = template_sem_trava ] && niv=migration
    if PGPORT_TEST=$porta SABOTAGEM="$sab" NIVEIS="$niv" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas + 1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|ABORTA' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas + 1)); continue
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
    # Vermelho por ERRO DE EXECUÇÃO não mata mutante: a sabotagem tem de mudar o RESULTADO.
    intrusos="$(grep -oE '[A-Z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "${intrusos// /}" ]; then
      echo "  ✅ $sab — vermelha em [${verm}], verde em [${verdes}]"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "${intrusos// /}" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO em: ${intrusos}"
                                    grep 'ERRO_DE_EXECUCAO' "$log" | head -2 | sed 's/^/       /'; }
      falhas=$((falhas + 1))
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação FALHOU — logs em $LOGDIR ═══"; exit 1
fi

# ════════════════════════════════════════════════════════════════════════════════════════════
# Infra
# ════════════════════════════════════════════════════════════════════════════════════════════
case "$SABOTAGEM" in
  ""|template_sem_trava|sem_fila|sem_guarda_isolamento|espera_generica|delta_pre_aceita_tudo|delta_sem_sonda) ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 3 ;;
esac
for f in "$BOOT" "$APLICAR" "$DELTA" "$FIX_V1" "$FIX_A" "$FIX_B" "$TEMPLATE"; do
  [ -f "$REPO_ROOT/$f" ] || { echo "ABORTA: arquivo ausente: $f"; exit 3; }
done
# O executor só aplica arquivo VERSIONADO e limpo: fixture fora do git não seria a fixture testada.
for f in "$DELTA" "$FIX_A" "$FIX_B"; do
  git -C "$REPO_ROOT" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 \
    || { echo "ABORTA: $f não está commitado — o db-aplicar.sh o recusaria (commite antes de provar)"; exit 3; }
done
SHA_VAZIO="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
[ "$(printf '' | shasum -a 256 2>/dev/null | awk '{print $1}')" = "$SHA_VAZIO" ] \
  || { echo "ABORTA: 'shasum -a 256' não respondeu o hash conhecido (o executor depende dele)"; exit 3; }

WORK="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
mkdir -p "$WORK/tmp"
CLUSTERS=""
cleanup() {
  exec 7>&- 2>/dev/null || true; exec 8>&- 2>/dev/null || true
  for d in $CLUSTERS; do "$PGBIN/pg_ctl" -D "$d" -m immediate stop >/dev/null 2>&1 || true; done
  for p in $(jobs -p); do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0; FAIL=0
ok()        { PASS=$((PASS + 1)); echo "  ✅ $1 OK — $2"; }
bad()       { FAIL=$((FAIL + 1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec() { FAIL=$((FAIL + 1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Valor vazio, erro de psql ou veredito "não consegui observar" não é resultado: ERRO_DE_EXECUCAO.
eq() {
  case "$3" in
    ""|*SEM_VEREDITO*|*NAO_PAROU*|*psql:*|*FATAL*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 240)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

sobe_cluster() { # <C|P> — define LOC, PORT, CDIR, SHIM
  case "$1" in
    C) LOC_SRV=C;           PORT=$PORT_BASE ;;
    P) LOC_SRV=pt_BR.UTF-8; PORT=$((PORT_BASE + 1)) ;;
  esac
  CDIR="$WORK/cluster-$1"; SHIM="$CDIR/psql-rw"; mkdir -p "$CDIR"
  if ! "$PGBIN/initdb" -D "$CDIR/data" -U postgres -E UTF8 --locale=C > "$CDIR/initdb.log" 2>&1; then
    echo "ABORTA: initdb falhou ($1)"; tail -c 600 "$CDIR/initdb.log"; exit 3
  fi
  CLUSTERS="$CLUSTERS $CDIR/data"
  if ! "$PGBIN/pg_ctl" -D "$CDIR/data" -o "-p $PORT -k $CDIR -c listen_addresses=localhost -c lc_messages=$LOC_SRV" \
       -l "$CDIR/pg.log" -w start > "$CDIR/pgctl.log" 2>&1; then
    echo "ABORTA: pg_ctl não subiu o cluster $1 (porta $PORT)"; tail -c 400 "$CDIR/pg.log"; exit 3
  fi
  # As peças do Supabase que o bootstrap referencia.
  if ! P -f - > "$CDIR/fixture.log" 2>&1 <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
SQL
  then echo "ABORTA: a fixture do Supabase falhou ($1)"; tail -c 600 "$CDIR/fixture.log"; exit 3; fi
  { echo '#!/usr/bin/env bash'
    echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost -p $PORT -U claude_rw -d postgres \"\$@\""
  } > "$SHIM"
  chmod +x "$SHIM"
}

P()  { "$PGBIN/psql" -X -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
# PV: com a SQLSTATE na mensagem de erro (VERBOSITY=verbose) — o veredito casa o CÓDIGO, ASCII e
# invariante ao idioma, nunca o texto traduzido.
PV() { "$PGBIN/psql" -X -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qAt "$@"; }
PVAPP() { local app="$1"; shift; env PGAPPNAME="$app" "$PGBIN/psql" -X -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qAt "$@"; }
RWV() { "$SHIM" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qAt "$@"; }
Q()  { P -c "$1" 2>&1 || true; }
sqlstate_de() { grep -oE '(ERROR|ERRO): +[0-9A-Z]{5}' "$1" 2>/dev/null | head -1 | awk '{print $2}' || true; }

# ── sessões de fundo ─────────────────────────────────────────────────────────────────────────
espera_arquivo() { # <arquivo> <pid> — 0 apareceu · 1 a sessão morreu antes · 2 estourou o teto
  local i=0
  while [ "$i" -lt 200 ]; do
    [ -e "$1" ] && return 0
    kill -0 "$2" 2>/dev/null || { [ -e "$1" ] && return 0; return 1; }
    sleep 0.1; i=$((i + 1))
  done
  return 2
}
abre_A() { # sessão A da migration, alimentada por FIFO (fd 7)
  rm -f "$WORK/a.in" "$WORK/a.out" "$WORK/a.pronta"; mkfifo "$WORK/a.in"
  ( PVAPP prova_A < "$WORK/a.in" > "$WORK/a.out" 2>&1; echo "RC_A=$?" >> "$WORK/a.out" ) &
  PID_A=$!
  exec 7> "$WORK/a.in"
}
# `env printf` (o EXTERNO), nunca o builtin: escrita no FIFO de uma sessão que já morreu fica no buffer
# do builtin e VAZA depois na saída capturada do cenário (medido: o veredito chegava com 'ROLLBACK;'
# na frente). No processo externo, o buffer morre com ele.
manda_A() { env printf '%s\n' "$@" >&7 2>/dev/null || true; }
fecha_A() { exec 7>&- 2>/dev/null || true; wait "$PID_A" 2>/dev/null || true; }
abre_H() { # <sql> — o SEGURADOR: toma uma chave numa transação aberta (fd 8) e a mantém
  rm -f "$WORK/h.in" "$WORK/h.out" "$WORK/h.pronta"; mkfifo "$WORK/h.in"
  ( PVAPP prova_H < "$WORK/h.in" > "$WORK/h.out" 2>&1; echo "RC_H=$?" >> "$WORK/h.out" ) &
  PID_H=$!
  exec 8> "$WORK/h.in"
  env printf '%s\n' "BEGIN;" "$1" "\\! touch $WORK/h.pronta" >&8 2>/dev/null || true
  espera_arquivo "$WORK/h.pronta" "$PID_H"
}
solta_H() { env printf '%s\n' "COMMIT;" >&8 2>/dev/null || true; exec 8>&- 2>/dev/null || true; wait "$PID_H" 2>/dev/null || true; }
roda_B() { # <arquivo sql> — B em fundo, application_name prova_B; RC_B=<rc> no fim da saída
  rm -f "$WORK/b.out"
  ( PVAPP prova_B -f "$1" > "$WORK/b.out" 2>&1; echo "RC_B=$?" >> "$WORK/b.out" ) &
  PID_B=$!
}
rc_B() { sed -n 's/^RC_B=//p' "$WORK/b.out" 2>/dev/null | tail -1; }
# B está PRESO em A? Resposta POSITIVA (A está em pg_blocking_pids(B)), com teto e ramo "não sei".
observa_B() { # <pid de A> → BLOQUEADO | TERMINOU | SEM_VEREDITO
  local i=0 n
  while [ "$i" -lt 200 ]; do
    n="$(Q "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'prova_B' AND $1 = ANY(pg_blocking_pids(pid))")"
    [ "$n" = "1" ] && { echo BLOQUEADO; return; }
    grep -q '^RC_B=' "$WORK/b.out" 2>/dev/null && { echo TERMINOU; return; }
    sleep 0.1; i=$((i + 1))
  done
  echo SEM_VEREDITO
}

# ════════════════════════════════════════════════════════════════════════════════════════════
# NÍVEL MIGRATION
# ════════════════════════════════════════════════════════════════════════════════════════════
PARTE1="$WORK/tpl-parte1.sql"; PARTE2="$WORK/tpl-parte2.sql"; PARTE1_SEM="$WORK/tpl-parte1-sem-trava.sql"
awk -v P1="$PARTE1" -v P2="$PARTE2" 'BEGIN{p=1} {print > (p ? P1 : P2)} /^\$pre\$;$/{p=0}' "$REPO_ROOT/$TEMPLATE"
awk '/^DO \$trava\$$/{s=1} !s{print} /^\$trava\$;$/{s=0}' "$PARTE1" > "$PARTE1_SEM"
# A divisão tem de ter cortado onde se pensa: parte 1 com a trava e a PRE, parte 2 com os CREATE.
# shellcheck disable=SC2016  # o $ é LITERAL (rótulo de dollar-quote do PL/pgSQL), não expansão
if ! { grep -q '^DO \$trava\$$' "$PARTE1" && grep -q '^\$pre\$;$' "$PARTE1" && ! grep -q '^DO \$trava\$$' "$PARTE1_SEM" && ! grep -q '^ *ALTER ' "$PARTE1_SEM" \
       && grep -q '^CREATE OR REPLACE FUNCTION public.trava_alvo_f' "$PARTE2" && grep -q '^\$pos\$;$' "$PARTE2"; }; then
  echo "ABORTA: o template não se divide em TRAVA+PRE | CREATE+PÓS como a prova espera"; exit 3
fi
# "Com trava" é o template como está; a sabotagem o troca pela versão sem o bloco $trava$.
PARTE1_COM="$PARTE1"
[ "$SABOTAGEM" = "template_sem_trava" ] && PARTE1_COM="$PARTE1_SEM"

reset_m() {
  Q "DROP VIEW IF EXISTS public.trava_alvo_v, public.trava_outra_v;
     DROP FUNCTION IF EXISTS public.trava_alvo_f(), public.trava_outra_f();
     CREATE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'predecessor'\$\$;
     CREATE VIEW public.trava_alvo_v WITH (security_invoker = on) AS SELECT 'predecessor'::text AS x;
     CREATE FUNCTION public.trava_outra_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'outra'\$\$;
     CREATE VIEW public.trava_outra_v WITH (security_invoker = on) AS SELECT 'outra'::text AS x;" > /dev/null
}
qual_f() { Q "SELECT CASE md5(prosrc) WHEN '$F_PRED' THEN 'pred' WHEN '$F_ESTE' THEN 'este' WHEN '$F_B' THEN 'B'
                ELSE 'outro' END FROM pg_proc WHERE oid = to_regprocedure('public.trava_alvo_f()')"; }
qual_v() { Q "SELECT CASE md5(pg_get_viewdef(oid, true)) WHEN '$V_PRED' THEN 'pred' WHEN '$V_ESTE' THEN 'este'
                WHEN '$V_B' THEN 'B' ELSE 'outro' END FROM pg_class WHERE oid = to_regclass('public.trava_alvo_v')"; }
B_F="$WORK/b-funcao.sql"; B_V="$WORK/b-view.sql"; B_V_PADRAO="$WORK/b-view-padrao.sql"
echo "CREATE OR REPLACE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'B'\$\$;" > "$B_F"
echo "CREATE OR REPLACE VIEW public.trava_alvo_v WITH (security_invoker = on) AS SELECT 'B'::text AS x;" > "$B_V"
cat > "$B_V_PADRAO" <<SQL
BEGIN;
ALTER VIEW public.trava_alvo_v SET (security_invoker = on);
DO \$pb\$
DECLARE v text;
BEGIN
  SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true)) INTO v FROM pg_catalog.pg_class c
   WHERE c.oid = to_regclass('public.trava_alvo_v');
  IF v IS NULL OR v NOT IN ('$V_PRED', '$V_B') THEN
    RAISE EXCEPTION 'PRE FALHOU em B: vivo %', v;
  END IF;
END
\$pb\$;
CREATE OR REPLACE VIEW public.trava_alvo_v WITH (security_invoker = on) AS SELECT 'B'::text AS x;
COMMIT;
SQL

# Um cenário: A roda <parte1> e PARA com a transação aberta; B age; A termina. Ecoa o veredito:
#   obs=<BLOQUEADO|TERMINOU> | rcB | estado de B | A=<OK|sqlstate> | final=<pred|este|B>
cenario_m() { # <parte1> <arquivo de B> <alvo f|v> [controle]
  local p1="$1" bsql="$2" alvo="$3" ctl="${4:-}" obs rcb stb a final livre=""
  reset_m
  abre_A
  manda_A "SELECT 'A_PID=' || pg_backend_pid();" "BEGIN;" "\\i $p1" "\\! touch $WORK/a.pronta"
  if ! espera_arquivo "$WORK/a.pronta" "$PID_A"; then
    fecha_A; echo "NAO_PAROU:$(tr '\n' ' ' < "$WORK/a.out" | head -c 200)"; return
  fi
  local apid; apid="$(sed -n 's/^A_PID=//p' "$WORK/a.out" | head -1)"
  if [ -n "$ctl" ]; then
    # controle inócuo: com A parado segurando a trava, OUTRA função e OUTRA view se recriam na hora
    livre="$(P -c "SET lock_timeout = '3s';
             CREATE OR REPLACE FUNCTION public.trava_outra_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'outra2'\$\$;
             CREATE OR REPLACE VIEW public.trava_outra_v WITH (security_invoker = on) AS SELECT 'outra2'::text AS x;
             SELECT 'LIVRE';" 2>&1 | tr '\n' ' ' | sed 's/ *$//' || true)"
  fi
  roda_B "$bsql"
  obs="$(observa_B "$apid")"
  manda_A "\\i $PARTE2" "COMMIT;" "SELECT 'A_FIM_OK';"
  fecha_A
  wait "$PID_B" 2>/dev/null || true
  rcb="$(rc_B)"
  stb="$(sqlstate_de "$WORK/b.out")"; [ -n "$stb" ] || stb="sem_erro"
  if grep -q '^A_FIM_OK$' "$WORK/a.out"; then a=OK; else a="$(sqlstate_de "$WORK/a.out")"; [ -n "$a" ] || a=ERRO; fi
  if [ "$alvo" = f ]; then final="$(qual_f)"; else final="$(qual_v)"; fi
  # P: nenhuma mudança COMMITADA de B sumiu — ou B falhou, ou o corpo final é o de B.
  local p=VALE
  [ "$rcb" = "0" ] && [ "$final" != "B" ] && p=VIOLADA
  echo "obs=$obs|rcB=$rcb|B=$stb|A=$a|final=$final|P=$p${ctl:+|ctl=$livre}"
}

# M4: B commita ANTES de A começar; a PRE de A tem de recusar.
cenario_m4() {
  reset_m
  Q "CREATE OR REPLACE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'B'\$\$" > /dev/null
  abre_A
  manda_A "BEGIN;" "\\i $PARTE1_COM" "\\! touch $WORK/a.pronta"
  local r=0; espera_arquivo "$WORK/a.pronta" "$PID_A" || r=$?
  # Só fala com A se A passou da PRE (o desfecho ERRADO aqui): a sessão que recusou já morreu.
  [ "$r" = "0" ] && manda_A "ROLLBACK;"
  fecha_A
  local st; st="$(sqlstate_de "$WORK/a.out")"
  local marca=""; grep -q 'PRE FALHOU' "$WORK/a.out" && marca="PRE_FALHOU"
  [ "$r" = "0" ] && st="A_PASSOU_DA_PRE"
  echo "$st|$marca|final=$(qual_f)"
}

roda_nivel_migration() { # <C|P>
  local L="$1" v
  echo "── nível MIGRATION ($L) ──"
  v="$(cenario_m "$PARTE1_SEM" "$B_F" f)"
  eq "${L}M0" "função SEM trava: B commita no meio, some, e A sai verde (a corrida existe)" \
    "$v" "obs=TERMINOU|rcB=0|B=sem_erro|A=OK|final=este|P=VIOLADA"

  v="$(cenario_m "$PARTE1_COM" "$B_F" f ctl)"
  eq "${L}M1" "função COM trava: B fica preso em A" "${v%%|*}" "obs=BLOQUEADO"
  eq "${L}M2" "... e falha alto (XX000) quando A commita" "$(cut -d'|' -f2,3 <<<"$v")" "rcB=3|B=XX000"
  eq "${L}M3" "... P vale, com o corpo de A no ar" "$(cut -d'|' -f4,5,6 <<<"$v")" "A=OK|final=este|P=VALE"
  eq "${L}C1" "controle: a trava de A não prende OUTRA função nem OUTRA view" "${v##*|}" "ctl=LIVRE"

  eq "${L}M4" "B que commitou ANTES aparece na PRE de A (recusa; fica o corpo de B)" \
    "$(cenario_m4)" "P0001|PRE_FALHOU|final=B"

  v="$(cenario_m "$PARTE1_SEM" "$B_V" v)"
  eq "${L}V0" "view SEM trava: a corrida existe" "$v" "obs=TERMINOU|rcB=0|B=sem_erro|A=OK|final=este|P=VIOLADA"

  v="$(cenario_m "$PARTE1_COM" "$B_V" v)"
  eq "${L}V1" "view COM trava: B fica preso em A" "${v%%|*}" "obs=BLOQUEADO"
  eq "${L}V2" "... e, sem PRE, aplica DEPOIS de A e vence (regime sequencial, não esta corrida)" \
    "$(cut -d'|' -f2- <<<"$v")" "rcB=0|B=sem_erro|A=OK|final=B|P=VALE"

  v="$(cenario_m "$PARTE1_COM" "$B_V_PADRAO" v)"
  eq "${L}V3" "view COM trava e B no padrão: B espera e a PRE de B recusa" \
    "$v" "obs=BLOQUEADO|rcB=3|B=P0001|A=OK|final=este|P=VALE"
}

# ════════════════════════════════════════════════════════════════════════════════════════════
# NÍVEL EXECUTOR
# ════════════════════════════════════════════════════════════════════════════════════════════
aplica_fundo() { # <rótulo> <arquivo> [VAR=valor…] — db-aplicar.sh REAL em fundo; rc em $WORK/<rótulo>.rc
  local rot="$1" arq="$2"; shift 2
  rm -f "$WORK/$rot.rc" "$WORK/$rot.log"
  ( r=0
    cd "$REPO_ROOT" && env AFIACAO_PSQL_RW="$SHIM" TMPDIR="$WORK/tmp" PGAPPNAME="prova_$rot" ${1+"$@"} \
      bash "$APLICAR" "$arq" > "$WORK/$rot.log" 2>&1 || r=$?
    echo "$r" > "$WORK/$rot.rc" ) &
}
aplica() { # <arquivo> [--ensaio] — síncrono; ecoa o rc
  local r=0
  ( cd "$REPO_ROOT" && env AFIACAO_PSQL_RW="$SHIM" TMPDIR="$WORK/tmp" bash "$APLICAR" "$@" ) > "$WORK/aplica.log" 2>&1 || r=$?
  echo "$r"
}
espera_rc() { # <rótulo> — ecoa o rc (teto 30 s) ou TRAVOU
  local i=0
  while [ "$i" -lt 300 ]; do
    [ -s "$WORK/$1.rc" ] && { head -1 "$WORK/$1.rc" | tr -d '[:space:]'; return; }
    sleep 0.1; i=$((i + 1))
  done
  echo TRAVOU
}
# Um backend da aplicação <app> ESPERANDO a chave advisory (classid, objid, objsubid)?
esperando() { # <app> <classid> <objid> <objsubid>
  [ "$(Q "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory' AND l.classid = $2 AND l.objid = $3 AND l.objsubid = $4
             AND NOT l.granted AND a.application_name = '$1'")" = "1" ]
}
qual_alvo() { Q "SELECT CASE md5(prosrc) WHEN '$F_PRED' THEN 'pred' WHEN '$F_A' THEN 'A' WHEN '$F_B' THEN 'B'
                   ELSE 'outro' END FROM pg_proc WHERE oid = to_regprocedure('public.corrida_alvo()')"; }
qual_porta() { Q "SELECT CASE md5(prosrc) WHEN '$MD5_V1_PROD' THEN 'v1' WHEN '$MD5_BOOT' THEN 'nova'
                    ELSE 'outro:' || md5(prosrc) END FROM pg_proc WHERE oid = to_regprocedure('public.aplicar_sql(text,text,bigint)')"; }
reset_e() {
  Q "CREATE OR REPLACE FUNCTION public.corrida_alvo() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'predecessor'\$\$;
     DELETE FROM public.db_aplicacoes WHERE arquivo LIKE '%db-aplicar-corrida-%';" > /dev/null
}
# A (com barreira) e B pelo executor real. Ecoa:
#   <B_TERMINOU_COM_A_PARADO|B_NA_FILA>|a_parado=<n>|A=<rc>|B=<rc>|final=<…>|ledgerB=<…>|motivoB=<…>
cenario_e() { # [VAR=valor…] — ambiente extra para B (ex.: PGOPTIONS de isolamento)
  local obs=SEM_VEREDITO i=0 a_parado rca rcb final led motivo
  reset_e
  abre_H "SELECT pg_advisory_xact_lock(731000001);" || { echo "SEM_VEREDITO:segurador_nao_travou"; return; }
  aplica_fundo ea "$FIX_A"
  while [ "$i" -lt 200 ] && ! esperando prova_ea 0 731000001 1; do
    [ -s "$WORK/ea.rc" ] && break
    sleep 0.1; i=$((i + 1))
  done
  if ! esperando prova_ea 0 731000001 1; then
    solta_H; echo "NAO_PAROU:A rc=$(espera_rc ea):$(tail -c 300 "$WORK/ea.log" | tr '\n' ' ')"; return
  fi
  aplica_fundo eb "$FIX_B" ${1+"$@"}
  i=0
  while [ "$i" -lt 200 ]; do
    if [ -s "$WORK/eb.rc" ]; then obs=B_TERMINOU_COM_A_PARADO; break; fi
    if esperando prova_eb 20260909 1 2; then obs=B_NA_FILA; break; fi
    sleep 0.1; i=$((i + 1))
  done
  # Testemunho da ordem: no instante do veredito sobre B, A AINDA estava parado na barreira.
  a_parado="$(Q "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                  WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = 731000001
                    AND NOT l.granted AND a.application_name = 'prova_ea'")"
  solta_H
  rca="$(espera_rc ea)"; rcb="$(espera_rc eb)"
  final="$(qual_alvo)"
  led="$(Q "SELECT estado FROM public.db_aplicacoes WHERE arquivo LIKE '%db-aplicar-corrida-b.sql' ORDER BY id DESC LIMIT 1")"
  # O motivo vem SÓ da 1ª linha de severidade do servidor: o CONTEXT de qualquer erro dentro do
  # EXECUTE ecoa o corpo INTEIRO da fixture, e o literal 'PRE_RECUSOU' dela casaria em todo erro.
  # O executor roda o psql sem VERBOSITY=verbose: a linha não traz SQLSTATE, só a mensagem. Sem
  # marcador conhecido, o veredito carrega o começo da mensagem — erro desconhecido não vira "-".
  local linha; linha="$(grep -E '(ERROR|ERRO): ' "$WORK/eb.log" | head -1 || true)"
  motivo="$(grep -oE 'PRE_RECUSOU|ISOLAMENTO_ERRADO|VEZ_OCUPADA' <<<"$linha" | head -1 || true)"
  if [ -z "$motivo" ] && [ -n "$linha" ]; then
    motivo="outro:$(sed -E 's/^.*(ERROR|ERRO): +//' <<<"$linha" | cut -c1-70)"
  fi
  echo "$obs|a_parado=$a_parado|A=$rca|B=$rcb|final=$final|ledgerB=$led|motivoB=${motivo:--}"
}
# Chamada DIRETA à porta, como claude_rw, numa transação montada aqui. Ecoa:
#   <sqlstate|FIM_APLICACAO_OK>|<marca>|efeito=<t|f>|tentativa=<estado>
porta_direta() { # <rótulo> <corpo (cria public.<rótulo>_t)> <abertura da transação> [lock_timeout]
  local rot="$1" corpo="$2" abre="$3" lt="${4:-}" id st marca
  id="$(RWV -c "INSERT INTO public.db_aplicacoes (arquivo, sha256, estado)
                VALUES ('prova:$rot', encode(sha256(convert_to('$corpo', 'UTF8')), 'hex'), 'tentativa') RETURNING id" 2>&1 || true)"
  case "$id" in ''|*[!0-9]*) echo "SEM_VEREDITO:tentativa:$id"; return ;; esac
  {
    echo "$abre"
    [ -n "$lt" ] && echo "SET LOCAL lock_timeout = '$lt';"
    echo "SELECT public.aplicar_sql('$corpo', encode(sha256(convert_to('$corpo', 'UTF8')), 'hex'), $id);"
    echo "COMMIT;"
  } > "$WORK/porta-$rot.sql"
  RWV -f "$WORK/porta-$rot.sql" > "$WORK/porta-$rot.out" 2>&1 || true
  st="$(sqlstate_de "$WORK/porta-$rot.out")"
  grep -q 'FIM_APLICACAO_OK' "$WORK/porta-$rot.out" && st=FIM_APLICACAO_OK
  marca="$(grep -E '(ERROR|ERRO): ' "$WORK/porta-$rot.out" | head -1 | grep -oE 'VEZ_OCUPADA|ISOLAMENTO_ERRADO' || true)"
  echo "${st:-sem_erro}|${marca:--}|efeito=$(Q "SELECT to_regclass('public.${rot}_t') IS NOT NULL")|tentativa=$(Q "SELECT estado FROM public.db_aplicacoes WHERE id = $id")"
}
# O bloco CREATE OR REPLACE FUNCTION public.aplicar_sql … $funcao$; de um arquivo.
bloco_porta() { awk '/^CREATE OR REPLACE FUNCTION public.aplicar_sql\(/{f=1} f{print} /^\$funcao\$;$/{if(f){exit}}' "$1"; }
# Troca um trecho EXATO num arquivo, exigindo N ocorrências (sabotagem que não casa não sabota).
troca() { # <arquivo> <de> <para> <n>
  python3 - "$@" <<'PY'
import sys
arq, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
s = open(arq, encoding="utf-8").read()
if s.count(de) != n:
    sys.exit("troca: %r ocorre %dx em %s, esperado %d" % (de[:60], s.count(de), arq, n))
open(arq, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Remove o trecho que começa em <início> e termina no 1º <fim> depois dele (inclusive), 1 vez.
corta() { # <arquivo> <início> <fim>
  python3 - "$@" <<'PY'
import sys
arq, ini, fim = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(arq, encoding="utf-8").read()
if s.count(ini) != 1:
    sys.exit("corta: início %r ocorre %dx em %s" % (ini[:60], s.count(ini), arq))
i = s.index(ini); j = s.find(fim, i)
if j < 0:
    sys.exit("corta: fim %r não achado depois do início em %s" % (fim[:60], arq))
open(arq, "w", encoding="utf-8").write(s[:i] + s[j + len(fim):])
PY
}

# R0: a sessão S abre REPEATABLE READ e tira o snapshot; W troca a função e commita; S lê e recria.
cenario_r0() {
  reset_m
  abre_A
  manda_A "BEGIN ISOLATION LEVEL REPEATABLE READ;" "SELECT count(*) FROM pg_class;" "\\! touch $WORK/a.pronta"
  if ! espera_arquivo "$WORK/a.pronta" "$PID_A"; then
    fecha_A; echo "NAO_PAROU:$(tr '\n' ' ' < "$WORK/a.out" | head -c 200)"; return
  fi
  Q "CREATE OR REPLACE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'B'\$\$" > /dev/null
  manda_A "SELECT 'LEU=' || CASE md5(prosrc) WHEN '$F_PRED' THEN 'pred' WHEN '$F_B' THEN 'B' ELSE 'outro' END
             FROM pg_proc WHERE oid = to_regprocedure('public.trava_alvo_f()') LIMIT 1;" \
          "CREATE OR REPLACE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT 'este'\$\$;" \
          "COMMIT;" "SELECT 'A_FIM_OK';"
  fecha_A
  local leu a=ERRO
  leu="$(sed -n 's/^LEU=//p' "$WORK/a.out" | head -1)"
  grep -q '^A_FIM_OK$' "$WORK/a.out" && a=OK
  echo "leu=${leu:-nada}|S=$a|final=$(qual_f)"
}

roda_nivel_executor() { # <C|P>
  local L="$1" v
  echo "── nível EXECUTOR ($L) ──"
  eq "${L}R0" "REPEATABLE READ sem porta: lê o predecessor DEPOIS de B commitar e apaga B sem erro" \
    "$(cenario_r0)" "leu=pred|S=OK|final=este"
  # Âncoras (não são asserts: se falham, não há o que julgar).
  P -f "$REPO_ROOT/$BOOT" > "$CDIR/boot.log" 2>&1 || { echo "ABORTA: bootstrap falhou"; tail -c 400 "$CDIR/boot.log"; exit 3; }
  grep -q 'BOOTSTRAP_OK' "$CDIR/boot.log" || { echo "ABORTA: bootstrap sem BOOTSTRAP_OK"; tail -c 400 "$CDIR/boot.log"; exit 3; }
  MD5_BOOT="$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure")"
  P -f "$REPO_ROOT/$FIX_V1" > /dev/null 2>&1 || { echo "ABORTA: a fixture v1 não cria a função"; exit 3; }
  [ "$(qual_porta)" = "v1" ] || { echo "ABORTA: a fixture v1 não é a prod (md5 $(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='aplicar_sql'")) — o baseline não provaria nada"; exit 3; }

  v="$(cenario_e)"
  eq "${L}E1" "baseline com o corpo REAL de prod: B aplica com A parado e A o apaga — os dois saem 0" \
    "$v" "B_TERMINOU_COM_A_PARADO|a_parado=1|A=0|B=0|final=A|ledgerB=aplicada|motivoB=-"

  reset_e
  eq "${L}E2" "o delta aplica pelo PRÓPRIO executor (auto-substituição)" "$(aplica "$DELTA")" "0"
  eq "${L}E3" "o corpo que o delta deixa = o do bootstrap = o literal do delta" \
    "$(qual_porta)|$(grep -c "$MD5_BOOT" "$REPO_ROOT/$DELTA")" "nova|2"
  eq "${L}E4" "a porta continua fechada (claude_rw sim; PUBLIC e anon não)" \
    "$(Q "SELECT has_function_privilege('claude_rw', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
              || '|' || has_function_privilege('public', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
              || '|' || has_function_privilege('anon', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')")" "true|false|false"

  # Sabotagens da PORTA: recria a função na versão furada, nesta sessão de teste.
  if [ "$SABOTAGEM" = sem_fila ] || [ "$SABOTAGEM" = sem_guarda_isolamento ] || [ "$SABOTAGEM" = espera_generica ]; then
    local sab="$WORK/porta-sabotada.sql"
    bloco_porta "$REPO_ROOT/$BOOT" > "$sab"
    case "$SABOTAGEM" in
      sem_fila) corta "$sab" "  IF NOT pg_try_advisory_xact_lock(20260909, 1) THEN" "    END;
  END IF;
" || exit 3 ;;
      sem_guarda_isolamento) corta "$sab" "  IF current_setting('transaction_isolation') <> 'read committed' THEN" "  END IF;
" || exit 3 ;;
      espera_generica) corta "$sab" "    EXCEPTION WHEN lock_not_available THEN" "        USING ERRCODE = '55P03';
" || exit 3 ;;
    esac
    P -f "$sab" > /dev/null 2>&1 || { echo "ABORTA: a porta sabotada não compila"; exit 3; }
    [ "$(qual_porta)" != "nova" ] || { echo "ABORTA: a sabotagem não mudou a porta"; exit 3; }
  fi

  v="$(cenario_e)"
  eq "${L}E5" "com a fila: B é visto ESPERANDO a vez enquanto A está parado" "$(cut -d'|' -f1,2 <<<"$v")" "B_NA_FILA|a_parado=1"
  eq "${L}E6" "... A sai 0, B sai 4 pela PRE, o corpo final é o de A e o recibo de B é 'falhou'" \
    "$(cut -d'|' -f3- <<<"$v")" "A=0|B=4|final=A|ledgerB=falhou|motivoB=PRE_RECUSOU"
  eq "${L}E7" "a fila é solta no fim" "$(Q "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = 20260909")" "0"

  abre_H "SELECT pg_advisory_xact_lock(20260909, 1);" || { echo "ABORTA: segurador da fila não travou"; exit 3; }
  v="$(porta_direta vez_ocupada "CREATE TABLE public.vez_ocupada_t (x int)" "BEGIN;" "1s")"
  solta_H
  eq "${L}E8" "vez ocupada além do lock_timeout: 55P03 VEZ_OCUPADA, corpo NÃO executado" \
    "$v" "55P03|VEZ_OCUPADA|efeito=f|tentativa=tentativa"

  eq "${L}E9" "REPEATABLE READ é recusado antes do corpo" \
    "$(porta_direta iso_rr "CREATE TABLE public.iso_rr_t (x int)" "BEGIN ISOLATION LEVEL REPEATABLE READ;")" \
    "25000|ISOLAMENTO_ERRADO|efeito=f|tentativa=tentativa"

  v="$(cenario_e "PGOPTIONS=-c default_transaction_isolation=repeatable\\ read")"
  eq "${L}E10" "pelo executor real: B em REPEATABLE READ é recusado e o corpo final é o de A" \
    "$(cut -d'|' -f3- <<<"$v")" "A=0|B=4|final=A|ledgerB=falhou|motivoB=ISOLAMENTO_ERRADO"

  abre_H "SELECT pg_advisory_xact_lock((20260909::bigint << 32) | 1);" || { echo "ABORTA: segurador bigint não travou"; exit 3; }
  v="$(porta_direta chave_bigint "CREATE TABLE public.chave_bigint_t (x int)" "BEGIN;" "1s")"
  solta_H
  eq "${L}E11" "controle: a chave bigint de mesmos números não prende a fila" \
    "$v" "FIM_APLICACAO_OK|-|efeito=t|tentativa=aplicada"

  # A porta real de volta (as sabotagens acima não podem contaminar o delta).
  bloco_porta "$REPO_ROOT/$BOOT" | P -f - > /dev/null 2>&1 || { echo "ABORTA: não consegui restaurar a porta"; exit 3; }
  [ "$(qual_porta)" = "nova" ] || { echo "ABORTA: a porta restaurada não é a do bootstrap"; exit 3; }
  eq "${L}E12" "o delta re-ensaiado sobre si mesmo passa (PRE 'já este' + sonda da PÓS)" "$(aplica "$DELTA" --ensaio)" "0"

  # E13/E14 aplicam CÓPIAS do delta como postgres numa transação: o que se prova é a PRE e a PÓS do
  # arquivo, que não dependem de quem executa — e é onde as sabotagens do delta mordem.
  local d13="$WORK/delta-13.sql" est="$WORK/porta-estranha.sql"
  cp "$REPO_ROOT/$DELTA" "$d13"
  [ "$SABOTAGEM" = delta_pre_aceita_tudo ] && { corta "$d13" "  IF v_vivo NOT IN (" "  END IF;
" || exit 3; }
  bloco_porta "$REPO_ROOT/$FIX_V1" > "$est"
  troca "$est" "  RETURN 'FIM_APLICACAO_OK';" "  RETURN 'FIM_APLICACAO_OK';  -- estranho" 1 || exit 3
  P -f "$est" > /dev/null 2>&1 || { echo "ABORTA: a porta estranha não compila"; exit 3; }
  local md5_estranho; md5_estranho="$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure")"
  printf 'BEGIN;\n\\i %s\nCOMMIT;\n' "$d13" | PV -f - > "$WORK/d13.out" 2>&1 || true
  local marca13=""; grep -q 'PRE FALHOU' "$WORK/d13.out" && marca13=PRE_FALHOU
  local vivo13; vivo13="$(Q "SELECT CASE md5(prosrc) WHEN '$md5_estranho' THEN 'estranho' ELSE 'outro' END FROM pg_proc WHERE oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure")"
  eq "${L}E13" "o delta sobre um corpo ESTRANHO é recusado pela PRE e o estranho fica" \
    "$(sqlstate_de "$WORK/d13.out")|$marca13|vivo=$vivo13" "P0001|PRE_FALHOU|vivo=estranho"

  # E14: a porta nova QUEBRADA (função inexistente no caminho que só roda ao EXECUTAR).
  P -f "$REPO_ROOT/$FIX_V1" > /dev/null 2>&1 || { echo "ABORTA: não consegui reinstalar a v1"; exit 3; }
  local d14="$WORK/delta-14.sql" sonda="$WORK/sonda-md5.sql" md5_quebrada
  cp "$REPO_ROOT/$DELTA" "$d14"
  troca "$d14" "pg_try_advisory_xact_lock(20260909, 1)" "pg_try_advisory_xact_lock_quebrada(20260909, 1)" 1 || exit 3
  bloco_porta "$d14" > "$sonda"
  troca "$sonda" "CREATE OR REPLACE FUNCTION public.aplicar_sql(" "CREATE OR REPLACE FUNCTION public.aplicar_sql_md5_sonda(" 1 || exit 3
  P -f "$sonda" > /dev/null 2>&1 || { echo "ABORTA: a porta quebrada não compila (ela TEM de compilar: late-bound)"; exit 3; }
  md5_quebrada="$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'aplicar_sql_md5_sonda'")"
  Q "DROP FUNCTION public.aplicar_sql_md5_sonda(text, text, bigint)" > /dev/null
  troca "$d14" "$MD5_BOOT" "$md5_quebrada" 2 || exit 3
  [ "$SABOTAGEM" = delta_sem_sonda ] && { corta "$d14" "  BEGIN
    PERFORM public.aplicar_sql('SELECT 1'" "  END;
" || exit 3; }
  printf 'BEGIN;\n\\i %s\nCOMMIT;\n' "$d14" | PV -f - > "$WORK/d14.out" 2>&1 || true
  eq "${L}E14" "o delta com a porta nova QUEBRADA aborta na PÓS e a porta antiga fica" \
    "$(sqlstate_de "$WORK/d14.out")|vivo=$(qual_porta)" "42883|vivo=v1"
}

# ════════════════════════════════════════════════════════════════════════════════════════════
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"
for L in C P; do
  sobe_cluster "$L"
  echo "═══ cluster $L (lc_messages=$LOC_SRV, porta $PORT) ═══"
  case " $NIVEIS " in *" migration "*) roda_nivel_migration "$L" ;; esac
  case " $NIVEIS " in *" executor "*)  roda_nivel_executor "$L" ;; esac
done

echo "PASS=$PASS FAIL=$FAIL (esperados $TOTAL_ESPERADO)"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executou $PASS asserts, o denominador é $TOTAL_ESPERADO — bloco que não rodou é vermelho"
  exit 1
fi
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM_PROVA_OK"
