#!/usr/bin/env bash
# PROVA PG17 — `scripts/db-aplicar.sh --atestar` + `scripts/db-atestar-poscondicao.ts` (rodada 2 do vigia, M2).
#
# O que prova: recibo `aplicada` de migration aplicada FORA do envelope só nasce com o EFEITO no banco,
# lido em sessão READ ONLY — nunca por declaração. Roda o db-aplicar.sh REAL contra um PG17 descartável:
# o bootstrap real (db/claude-rw-bootstrap.sql), um "psql-rw" (claude_rw) e um "psql-ro" que imita o de
# prod (psqlrc com SESSION READ ONLY; o papel PODE escrever — o read-only é do wrapper, como lá).
#
# Uso: bash db/test-db-atestar.sh                 (LC_TESTE=pt_BR.UTF-8 → servidor e cliente em pt_BR)
#      bash db/test-db-atestar.sh --falsificar    (cada sabotagem tem de deixar o seu cenário VERMELHO,
#                                                   com o CONTROLE verde na mesma invocação)
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5493}"
BOOT="$REPO_ROOT/db/claude-rw-bootstrap.sql"
ALVO_REAL="$REPO_ROOT/scripts/db-aplicar.sh"
PLANO_REAL="$REPO_ROOT/scripts/db-atestar-poscondicao.ts"
WORK="$(mktemp -d "/tmp/pgtest-db-atestar.XXXXXX")"
CDIR="$WORK/cluster"; DATA="$CDIR/data"
export LC_ALL=C LANG=C; unset LANGUAGE
LOC="${LC_TESTE:-C}"
FALSIFICAR=0; [ "${1:-}" = "--falsificar" ] && FALSIFICAR=1
PASS=0; FAIL=0
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$CDIR"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C > "$CDIR/initdb.log" 2>&1 || { echo "ERRO: initdb"; tail -c 600 "$CDIR/initdb.log"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $CDIR -c listen_addresses=localhost -c lc_messages=$LOC" -l "$CDIR/pg.log" -w start > "$CDIR/pgctl.log" 2>&1 \
  || { echo "ERRO: o cluster não subiu (lc_messages=$LOC)"; tail -c 600 "$CDIR/pg.log"; exit 1; }
PSQL="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h localhost -p $PORT -U postgres -d postgres"
q() { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null | tr -d ' \n'; }
$PSQL -q > "$CDIR/fixture.log" 2>&1 <<'SQL' || { echo "ERRO: fixture Supabase"; tail -c 600 "$CDIR/fixture.log"; exit 1; }
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, role public.app_role NOT NULL);
SQL
if ! { $PSQL -f "$BOOT" > "$CDIR/boot.log" 2>&1 && grep -q BOOTSTRAP_OK "$CDIR/boot.log"; }; then echo "ERRO: bootstrap"; tail -c 600 "$CDIR/boot.log"; exit 1; fi
# psql-rw (claude_rw) e psql-ro: o RO entra como POSTGRES (pode escrever!) — só o psqlrc o põe READ ONLY, como em prod
printf '#!/usr/bin/env bash\nexec env PSQLRC=/dev/null %s/psql -h localhost -p %s -U claude_rw -d postgres "$@"\n' "$PGBIN" "$PORT" > "$CDIR/psql-rw"
printf 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n' > "$CDIR/psqlrc-ro"
printf '#!/usr/bin/env bash\nexec env PSQLRC=%s %s/psql -h localhost -p %s -U postgres -d postgres "$@"\n' "$CDIR/psqlrc-ro" "$PGBIN" "$PORT" > "$CDIR/psql-ro"
# o wrapper QUEBRADO (sem psqlrc = sessão READ WRITE): a defesa do script não pode depender do wrapper
printf '#!/usr/bin/env bash\nexec env PSQLRC=/dev/null %s/psql -h localhost -p %s -U postgres -d postgres "$@"\n' "$PGBIN" "$PORT" > "$CDIR/psql-ro-rw"
chmod +x "$CDIR"/psql-*
VIGIA="$WORK/vigia"

ALVO="$ALVO_REAL"; PLANO="$PLANO_REAL"; RO="$CDIR/psql-ro"
atestar() {  # <arquivo> [args…] → RC, saída em $WORK/out
  local r=0; mkdir -p "$VIGIA"; echo 0 > "$VIGIA/recibos-aaaa-bbbb"
  ( cd "$REPO_ROOT" && LC_ALL="$LOC" LANG="$LOC" AFIACAO_PSQL_RW="$CDIR/psql-rw" AFIACAO_PSQL_RO="$RO" \
      DB_ATESTAR_PLANO="$PLANO" LP_VIGIA_ESTADO="$VIGIA" TMPDIR="$WORK/" bash "$ALVO" "$1" --atestar --autor 'teste ci' "${@:2}" ) > "$WORK/out" 2>&1 || r=$?
  RC=$r
}
recibos() { q "select count(*) from public.db_aplicacoes where arquivo='$1' and estado='aplicada'"; }
zera()    { $PSQL -q -c "delete from public.db_aplicacoes where arquivo like 'db/fixtures/db-atestar-%'" >/dev/null 2>&1; }
OKF=db/fixtures/db-atestar-ok.sql; DOF=db/fixtures/db-atestar-do-escreve.sql; DMLF=db/fixtures/db-atestar-dml.sql

# ── cenários: cada um devolve 0 = o alvo sob teste se comportou ─────────────────────────────────────
# A1 — aplicada pelo "SQL Editor" (psql cru) → atesta, recibo `aplicada` com ator manual:<autor>, cache do vigia invalidado
c_ok() { zera; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; atestar "$OKF"
  [ "$RC" = 0 ] && [ "$(recibos "$OKF")" = 1 ] && [ "$(q "select ator from public.db_aplicacoes where arquivo='$OKF' and estado='aplicada'")" = "manual:testeci" ] \
    && grep -q 'ATESTADO' "$WORK/out" && [ ! -f "$VIGIA/recibos-aaaa-bbbb" ]; }
# A2 — já atestada → 3, sem 2º recibo
c_dup() { c_ok || return 1; atestar "$OKF"; [ "$RC" = 3 ] && [ "$(recibos "$OKF")" = 1 ]; }
# A3 — função com o corpo VELHO no banco (o drift que "existe?" deixaria passar) → 4, sem recibo
c_corpo() { zera; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1
  $PSQL -q -c "CREATE OR REPLACE FUNCTION public.atestar_soma(p_a numeric, p_b numeric DEFAULT 0) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$fn\$ BEGIN RETURN p_a; END \$fn\$" >/dev/null
  atestar "$OKF"; local r=$RC; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1
  [ "$r" = 4 ] && [ "$(recibos "$OKF")" = 0 ] && grep -q 'FALTA funcao public.atestar_soma' "$WORK/out"; }
# A4 — policy ausente → 4
c_policy() { zera; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; $PSQL -q -c "DROP POLICY atestar_t_le ON public.atestar_t" >/dev/null
  atestar "$OKF"; local r=$RC; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; [ "$r" = 4 ] && [ "$(recibos "$OKF")" = 0 ]; }
# A5 — ACL: o REVOKE de anon não está no banco → 4
c_acl() { zera; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; $PSQL -q -c "GRANT EXECUTE ON FUNCTION public.atestar_soma(numeric, numeric) TO anon" >/dev/null
  atestar "$OKF"; local r=$RC; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; [ "$r" = 4 ] && grep -q 'FALTA acl funcao public.atestar_soma(numeric, numeric) anon' "$WORK/out"; }
# A6 — view sem security_invoker (o replace que RESETA a opção) → 4
c_sinv() { zera; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; $PSQL -q -c "ALTER VIEW public.atestar_v RESET (security_invoker)" >/dev/null
  atestar "$OKF"; local r=$RC; $PSQL -q -f "$REPO_ROOT/$OKF" >/dev/null 2>&1; [ "$r" = 4 ] && [ "$(recibos "$OKF")" = 0 ]; }
# A7 — bloco DO que ESCREVERIA (estado ainda não semeado) → recusa (2), e o banco NÃO foi escrito
c_do() { zera; $PSQL -q -c "DROP TABLE IF EXISTS public.atestar_cfg; CREATE TABLE public.atestar_cfg (k text PRIMARY KEY, v text)" >/dev/null
  atestar "$DOF"; [ "$RC" = 2 ] && [ "$(recibos "$DOF")" = 0 ] && [ "$(q "select count(*) from public.atestar_cfg")" = 0 ] && grep -q 'RECUSA_SEM_PROVA' "$WORK/out"; }
# A7b — o MESMO DO com o estado certo (migration de fato aplicada) → idempotente sob READ ONLY → atesta
c_do_ok() { zera; $PSQL -q -f "$REPO_ROOT/$DOF" >/dev/null 2>&1; atestar "$DOF"; [ "$RC" = 0 ] && [ "$(recibos "$DOF")" = 1 ]; }
# A8 — wrapper read-only QUEBRADO (sessão READ WRITE): o DO que escreveria continua sem escrever nem atestar
c_ro_quebrado() { zera; $PSQL -q -c "DROP TABLE IF EXISTS public.atestar_cfg; CREATE TABLE public.atestar_cfg (k text PRIMARY KEY, v text)" >/dev/null
  RO="$CDIR/psql-ro-rw" atestar "$DOF"; [ "$RC" != 0 ] && [ "$(recibos "$DOF")" = 0 ] && [ "$(q "select count(*) from public.atestar_cfg")" = 0 ]; }
# A9 — DML sem prova automática e sem --pos → 2
c_dml() { zera; atestar "$DMLF"; [ "$RC" = 2 ] && [ "$(recibos "$DMLF")" = 0 ] && grep -q 'NAO_PROVAVEL UPDATE' "$WORK/out"; }
# A10 — com --pos que PROVA o efeito → 0; com --pos que não prova → 4
c_pos() { zera; $PSQL -q -c "DROP TABLE IF EXISTS public.atestar_cfg; CREATE TABLE public.atestar_cfg (k text PRIMARY KEY, v text); INSERT INTO public.atestar_cfg VALUES ('modo','novo')" >/dev/null
  atestar "$DMLF" --pos db/fixtures/db-atestar-pos-nao.sql; [ "$RC" = 4 ] && [ "$(recibos "$DMLF")" = 0 ] || return 1
  atestar "$DMLF" --pos db/fixtures/db-atestar-dml-pos.sql; [ "$RC" = 0 ] && [ "$(recibos "$DMLF")" = 1 ]; }
# A11 — --pos que prova, mas o efeito NÃO está no banco → 4
c_pos_falso() { zera; $PSQL -q -c "DROP TABLE IF EXISTS public.atestar_cfg; CREATE TABLE public.atestar_cfg (k text PRIMARY KEY, v text)" >/dev/null
  atestar "$DMLF" --pos db/fixtures/db-atestar-dml-pos.sql; [ "$RC" = 4 ] && [ "$(recibos "$DMLF")" = 0 ]; }

# ID de cada cenário: o assert que a falsificação nomeia (idioma do falsificar-exige-assert-gate, R1/R2)
CENARIOS="A1:c_ok A2:c_dup A3:c_corpo A4:c_policy A5:c_acl A6:c_sinv A7:c_do A8:c_do_ok A9:c_ro_quebrado A10:c_dml A11:c_pos A12:c_pos_falso"
rodada() {  # roda TODOS os cenários contra o ALVO/PLANO atuais; imprime `  ✓ <ID> ` / `  ✗ <ID> `
  local item id fn
  PASS=0; FAIL=0
  for item in $CENARIOS; do
    id="${item%%:*}"; fn="${item#*:}"
    if "$fn"; then ok "$id $fn"; else nok "$id $fn" "rc=$RC $(tail -c 300 "$WORK/out" | tr '\n' ' ')"; fi
  done
}
# ok/nok imprimem "  ✅ …"/"  ❌ …"; a falsificação casa o ID pela linha exata
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
nok() { FAIL=$((FAIL+1)); printf '  ✗ %s — %s\n' "$1" "$2"; }

# <sabotagem>:<IDs que TÊM de virar vermelhos>:<IDs que têm de ficar verdes — o controle da camada>
SABOTAGENS="corpo_md5:A3:A1
falta:A4:A1
acl:A5:A1
sinv:A6:A1
dos:A7:A8
nao_provavel:A10:A11
pos_marcador:A11:A10
read_only:A9:A7"
# shellcheck disable=SC2016  # os $ das expressões sed são LITERAIS dos fontes sabotados
# sabotagem <nome> → ALVO/PLANO apontam para a cópia sabotada; 3 = o sed não casou (não aplicou)
sabotagem() {
  local qual expr src dst
  case "$1" in
    corpo_md5)    qual=ts;   expr='s/ AND md5(p.prosrc) = \${lit(md5(b\[3\]))}//' ;;
    falta)        qual=bash; expr='s/^  if \[ -n "\$FALTAS" \] || \[ "\$NOK" != "\$NCH" \]; then$/  if false; then/' ;;
    acl)          qual=ts;   expr='s/^  for (const a of acl.values()) checagens.push(checagemAcl(a.kind, a.obj, a.role, a.priv, a.v));$/  void acl;/' ;;
    sinv)         qual=ts;   expr='s/if (si) {/if (false \&\& si) {/' ;;
    dos)          qual=bash; expr='s/^    if ! ro_prova "\$d" DO_OK "\$d.out"; then$/    if false; then/' ;;
    nao_provavel) qual=bash; expr='s/^    3) if \[ -z "\$POS" \]; then$/    3) if false; then/' ;;
    pos_marcador) qual=bash; expr="s/ || ! grep -qx 'POSCONDICAO_OK' \"\$AT_DIR\/pos.out\"//" ;;
    # todas as camadas do READ ONLY de uma vez sob o wrapper quebrado (cada uma sozinha é redundante DE
    # PROPÓSITO: BEGIN READ ONLY, RO_ATIVO:on e o ROLLBACK final — docs/historico/lovable-publish-automatico.md)
    read_only)    qual=bash; expr='s/BEGIN TRANSACTION READ ONLY;/BEGIN;/; s/^    grep -qx .RO_ATIVO:on. "\$3" || return 1$/    true/; s/\\nROLLBACK;\\n"/\\nCOMMIT;\\n"/' ;;
    *) return 3 ;;
  esac
  if [ "$qual" = ts ]; then
    # a cópia mora fora do repo: o alias `@/` não resolve lá — reescrito para o caminho absoluto NA BASE também,
    # para o "o sed casou?" comparar só a sabotagem (sem isto o planner sabotado abortava e tudo ficava vermelho)
    src="$WORK/plano-base.ts"; dst="$WORK/sab-$1.ts"
    sed "s|'@/lib/erro-mensagem'|'$REPO_ROOT/src/lib/erro-mensagem.ts'|" "$PLANO_REAL" > "$src"
  else src="$ALVO_REAL"; dst="$WORK/sab-$1.sh"; fi
  sed "$expr" "$src" > "$dst"
  cmp -s "$src" "$dst" && return 3
  if [ "$qual" = ts ]; then PLANO="$dst"; else ALVO="$dst"; fi
}

if [ "$FALSIFICAR" = 0 ]; then
  echo "▶ db:aplicar --atestar (lc_messages=$LOC)"
  rodada
  echo "PASS=$PASS FAIL=$FAIL"
  [ "$FAIL" = 0 ] && [ "$PASS" -gt 0 ] && echo "DB_ATESTAR_OK"
  [ "$FAIL" = 0 ] && [ "$PASS" -gt 0 ]
  exit $?
fi

# ── --falsificar: CONTROLE verde na MESMA invocação, antes da 1ª sabotagem ─────────────────────────────────
echo "▶ falsificação (lc_messages=$LOC) — CONTROLE (sem sabotagem) tem de ficar VERDE"
ALVO="$ALVO_REAL"; PLANO="$PLANO_REAL"
rodada > "$WORK/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"; tail -c 1500 "$WORK/controle.log"; exit 1
fi
echo "  ✅ controle verde: $PASS asserts"
falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$WORK/sab-$sab.log"; motivo=""
  ALVO="$ALVO_REAL"; PLANO="$PLANO_REAL"
  rc=0; sabotagem "$sab" || rc=$?
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc: o sed não casou)"
  else
    rodada > "$log" 2>&1
    if [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
      motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
    else
      for id in ${verm//,/ }; do
        if ! grep -Eq "^  ✓ ($id) " "$WORK/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
          motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
        fi
      done
      for id in ${verdes//,/ }; do
        grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
      done
    fi
  fi
  ALVO="$ALVO_REAL"; PLANO="$PLANO_REAL"
  if [ -z "$motivo" ]; then echo "  ✅ $sab — vermelho no assert declarado ($verm)"; else falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"; fi
done
total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
echo "PASS=$((total - falhas))  FAIL=$falhas"
[ "$falhas" -eq 0 ] && echo "DB_ATESTAR_OK"
[ "$falhas" -eq 0 ]
