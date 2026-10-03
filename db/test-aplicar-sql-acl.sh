#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — db/aplicar-sql-acl-allowlist.sql (fecho da porta e do ledger por ALLOWLIST) ║
# ║  Rode:  bash db/test-aplicar-sql-acl.sh > /tmp/t.log 2>&1; echo $?                        ║
# ║         bash db/test-aplicar-sql-acl.sh --falsificar   (sabota o delta, exige VERMELHO)  ║
# ╚════════════════════════════════════════════════════════════════════════════════════════╝
#
# O que prova: depois do delta, SÓ o dono e o claude_rw executam a porta e escrevem no ledger —
# inclusive os papéis que o bootstrap não nomeava (service_role, sandbox_exec_<ref>), que é o achado
# medido em prod. E a PÓS do delta tem DENTE: se um GRANT sobra, ela aborta a transação.
#
# Fiel ao que vai pra prod: aplica o ARQUIVO REAL (psql -f), depois do bootstrap REAL e com a deriva
# de prod recriada à mão (GRANT direto a service_role e ao builder). O envelope do db:aplicar (sha +
# transação) é provado em db/test-db-aplicar.sh; aqui a unidade é o SQL do fecho.
set -euo pipefail

# macOS: sem isto o postmaster "became multithreaded during startup" e aborta (template prove-sql).
export LC_ALL=C LANG=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # helper versionado, resolvido em runtime; o gate roda sem -x
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5781}"
BOOT="$REPO_ROOT/db/claude-rw-bootstrap.sql"
DELTA="$REPO_ROOT/db/aplicar-sql-acl-allowlist.sql"
SANDBOX_REF="sandbox_exec_fzvklzpomgnyikkfkzai"
FUNC="public.aplicar_sql(text,text,bigint)"

[ -f "$BOOT" ]  || { echo "ERRO: bootstrap ausente: $BOOT"; exit 1; }
[ -f "$DELTA" ] || { echo "ERRO: delta ausente: $DELTA"; exit 1; }

# As sabotagens do delta, como funções reusáveis: a falsificação as usa para provar o dente dos
# asserts de ESTADO (fecho furado → papel sobrevive), e o modo limpo as usa para provar o dente da
# PÓS (fecho furado + PÓS intacta → a transação ABORTA). Cada uma troca um pedaço e devolve 0 só se o
# regex casou (fail-closed: sabotagem que não altera nada é teatro).
gap_func()   { perl -0pi -e "s/  FOR r IN\n    SELECT DISTINCT a\.grantee::regrole.*?\n  END LOOP;\n\n  FOR r IN\n    SELECT a\.grantee::regrole AS papel,/  REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM anon;\n\n  FOR r IN\n    SELECT a.grantee::regrole AS papel,/s" "$1"; }
gap_ledger() { perl -0pi -e "s/  FOR r IN\n    SELECT a\.grantee::regrole AS papel,.*?\n  END LOOP;\nEND\n\\\$fecho\\\$;/  NULL;\nEND\n\\\$fecho\\\$;/s" "$1"; }
cega_pos_porta()  { perl -0pi -e "s/  IF v_porta IS NOT NULL THEN\n    RAISE EXCEPTION 'POS FALHOU: ainda executam a porta: %', v_porta;\n  END IF;/  NULL;/s" "$1"; }
cega_pos_ledger() { perl -0pi -e "s/  IF v_ledger IS NOT NULL THEN\n    RAISE EXCEPTION 'POS FALHOU: ainda escrevem no ledger: %', v_ledger;\n  END IF;/  NULL;/s" "$1"; }

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: o CONTROLE roda primeiro, na MESMA invocação (suíte que já falha aprovaria toda
# sabotagem). Cada sabotagem declara os asserts que TÊM de ficar vermelhos. Formato: <sab>:<vermelhos>.
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="fecho_so_nome:A1,A2,A6
              ledger_sem_fecho:A3,A4,A7"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-acl.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (delta limpo) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar"; tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; verm="${item#*:}"
    porta=$((porta + 1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte VERDE com a sabotagem ativa: o assert NÃO tem dente"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO aplicou: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|NÃO' "$log" | head -3 | sed 's/^/       /'; falhas=$((falhas+1)); continue
    fi
    faltou=""
    for x in ${verm//,/ }; do grep -Eq "(^|[^A-Z0-9])${x} " "$log" && grep -Eq "❌ ${x} " "$log" || faltou="$faltou $x"; done
    if [ -z "$faltou" ]; then
      echo "  ✅ $sab — vermelha em [$verm]"
    else
      echo "  ❌ $sab — devia ficar vermelha em:$faltou"; falhas=$((falhas+1))
    fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "═══ falsificação OK: controle verde + $total sabotagens no assert certo ═══"; rm -rf "$LOGDIR"; exit 0; fi
  echo "═══ FALSIFICAÇÃO FALHOU: $falhas ═══"; exit 1
fi

# ── cluster descartável ──────────────────────────────────────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-acl.XXXXXX")"
DATA="$WORK/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

PSQL="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h localhost -p $PORT -U postgres -d postgres"
q() { "$PGBIN/psql" -X -A -t -h localhost -p "$PORT" -U postgres -d postgres -c "$1" 2>/dev/null | tr -d ' \n'; }
# aplica <arquivo> <log> — como o EXECUTOR: o arquivo inteiro numa transação (BEGIN/COMMIT), para
# que a PÓS que aborta DESFAÇA o fecho. Sem isso, cada DO block autocommita e a PÓS vira decorativa.
aplica() { { printf 'BEGIN;\n'; cat "$1"; printf '\nCOMMIT;\n'; } | $PSQL > "$2" 2>&1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
nok() { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$1"; }
# asserta <id> <esperado> <obtido> <descrição>
asserta() { if [ "$2" = "$3" ]; then ok "$1 OK — $4"; else nok "$1 FALHOU — $4: esperado '$2', obtido '$3'"; fi; }

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C > "$WORK/initdb.log" 2>&1 \
  || { echo "ERRO: initdb falhou"; tail -c 800 "$WORK/initdb.log"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $WORK -c listen_addresses=localhost" -l "$WORK/pg.log" -w start > "$WORK/pgctl.log" 2>&1 \
  || { echo "ERRO: cluster não subiu"; tail -c 800 "$WORK/pg.log"; exit 1; }

# fixture: o mínimo do Supabase + os papéis da deriva de prod (LOGIN/BYPASSRLS como lá)
$PSQL > "$WORK/fixture.log" 2>&1 <<SQL || { echo "ERRO: fixture falhou"; tail -c 800 "$WORK/fixture.log"; exit 1; }
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE $SANDBOX_REF LOGIN BYPASSRLS PASSWORD 'x';
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULL::uuid \$\$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, role public.app_role NOT NULL);
SQL

echo "▶ bootstrap"
if $PSQL -f "$BOOT" > "$WORK/boot.log" 2>&1 && grep -q 'BOOTSTRAP_OK' "$WORK/boot.log"; then
  ok "bootstrap aplica e devolve BOOTSTRAP_OK (allowlist embutida)"
else
  nok "bootstrap sem BOOTSTRAP_OK: $(tail -c 300 "$WORK/boot.log")"; echo "PASS=$PASS FAIL=$FAIL"; exit 3
fi

# recria a DERIVA de prod: GRANT direto a service_role e ao builder
$PSQL > "$WORK/deriva.log" 2>&1 <<SQL || { echo "ERRO: deriva falhou"; tail -c 800 "$WORK/deriva.log"; exit 1; }
GRANT EXECUTE ON FUNCTION $FUNC TO service_role, $SANDBOX_REF;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.db_aplicacoes TO service_role;
GRANT INSERT ON public.db_aplicacoes TO $SANDBOX_REF;
SQL
asserta D0a t "$(q "SELECT has_function_privilege('service_role','$FUNC','EXECUTE')")" "a deriva colou: service_role executa a porta ANTES do fecho"

# sabotagem opcional do delta
ALVO="$DELTA"
if [ -n "${SABOTAGEM:-}" ]; then
  ALVO="$WORK/delta-sabotado.sql"; cp "$DELTA" "$ALVO"
  case "$SABOTAGEM" in
    fecho_so_nome)     gap_func "$ALVO" ;;
    ledger_sem_fecho)  gap_ledger "$ALVO" ;;
    *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
  esac
  if cmp -s "$DELTA" "$ALVO"; then echo "❌ SABOTAGEM '$SABOTAGEM' NÃO alterou o delta (regex não casou)"; exit 9; fi
  echo "SABOTAGEM ativa: $SABOTAGEM"
fi

echo "▶ aplica o delta"
RC=0; aplica "$ALVO" "$WORK/delta.log" || RC=$?
[ -z "${SABOTAGEM:-}" ] && asserta A0 0 "$RC" "o delta limpo aplica sem erro (PÓS verde)"

# estado FINAL — a verdade é a ACL depois do fecho
asserta A1 f "$(q "SELECT has_function_privilege('service_role','$FUNC','EXECUTE')")" "service_role NÃO executa mais a porta"
asserta A2 f "$(q "SELECT has_function_privilege('$SANDBOX_REF','$FUNC','EXECUTE')")" "o builder NÃO executa mais a porta"
asserta A3 f "$(q "SELECT has_table_privilege('service_role','public.db_aplicacoes','INSERT')")" "service_role NÃO insere mais no ledger"
asserta A4 f "$(q "SELECT has_table_privilege('$SANDBOX_REF','public.db_aplicacoes','INSERT')")" "o builder NÃO insere mais no ledger"
asserta A5 f "$(q "SELECT has_function_privilege('public','$FUNC','EXECUTE')")" "PUBLIC não executa a porta"
PINTRU="$(q "SELECT count(*) FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%' AND r.rolname<>'claude_rw' AND r.oid<>(SELECT proowner FROM pg_proc WHERE oid='$FUNC'::regprocedure) AND has_function_privilege(r.oid,'$FUNC'::regprocedure,'EXECUTE')")"
asserta A6 0 "$PINTRU" "ninguém fora do dono/claude_rw executa a porta"
LINTRU="$(q "SELECT count(DISTINCT r.rolname) FROM pg_roles r CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv) WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%' AND r.rolname<>'claude_rw' AND r.oid<>(SELECT relowner FROM pg_class WHERE oid='public.db_aplicacoes'::regclass) AND has_table_privilege(r.oid,'public.db_aplicacoes'::regclass,p.priv)")"
asserta A7 0 "$LINTRU" "ninguém fora do dono/claude_rw escreve no ledger"

# o fecho não pode trancar quem deve
asserta A8 t "$(q "SELECT has_function_privilege('claude_rw','$FUNC','EXECUTE')")" "claude_rw AINDA executa a porta"
asserta A9 t "$(q "SELECT has_table_privilege('claude_rw','public.db_aplicacoes','INSERT') AND has_table_privilege('claude_rw','public.db_aplicacoes','UPDATE') AND has_table_privilege('claude_rw','public.db_aplicacoes','SELECT')")" "claude_rw AINDA escreve e lê o ledger"
asserta A10 t "$(q "SELECT has_table_privilege('authenticated','public.db_aplicacoes','SELECT')")" "o staff AINDA lê o ledger"

# idempotência, PRE fail-closed, PÓS-dente positivo — só no modo limpo
if [ -z "${SABOTAGEM:-}" ]; then
  RC2=0; aplica "$DELTA" "$WORK/delta2.log" || RC2=$?
  asserta A11 0 "$RC2" "recolar o delta é idempotente (PÓS verde de novo)"

  # A PÓS tem DENTE: com o fecho furado mas a PÓS intacta, a transação ABORTA com a marca certa —
  # e, como abortou, o resíduo NÃO fica (a fila estaria aberta de novo). Recria a deriva antes.
  $PSQL > /dev/null 2>&1 <<SQL
GRANT EXECUTE ON FUNCTION $FUNC TO service_role;
GRANT INSERT ON public.db_aplicacoes TO service_role;
SQL
  GAPF="$WORK/gap-func.sql"; cp "$DELTA" "$GAPF"; gap_func "$GAPF"
  RCF=0; aplica "$GAPF" "$WORK/gapf.log" || RCF=$?
  if [ "$RCF" != 0 ] && grep -q 'POS FALHOU: ainda executam a porta' "$WORK/gapf.log" \
     && [ "$(q "SELECT has_function_privilege('service_role','$FUNC','EXECUTE')")" = t ]; then
    ok "A13 OK — fecho furado na porta + PÓS intacta: a PÓS aborta (resíduo segue, transação desfeita)"
  else nok "A13 FALHOU — a PÓS não pegou o resíduo da porta (rc=$RCF)"; fi

  GAPL="$WORK/gap-ledger.sql"; cp "$DELTA" "$GAPL"; gap_ledger "$GAPL"
  RCL=0; aplica "$GAPL" "$WORK/gapl.log" || RCL=$?
  if [ "$RCL" != 0 ] && grep -q 'POS FALHOU: ainda escrevem no ledger' "$WORK/gapl.log"; then
    ok "A14 OK — fecho furado no ledger + PÓS intacta: a PÓS aborta"
  else nok "A14 FALHOU — a PÓS não pegou o resíduo do ledger (rc=$RCL)"; fi

  # a porta de fato: o delta LIMPO fecha mesmo o resíduo que o A13/A14 deixaram (abortados)
  RC4=0; aplica "$DELTA" "$WORK/delta4.log" || RC4=$?
  asserta A15 0 "$RC4" "o delta limpo fecha o resíduo que as sabotagens deixaram"

  $PSQL -c "DROP FUNCTION $FUNC" > /dev/null 2>&1
  RC3=0; aplica "$DELTA" "$WORK/delta3.log" || RC3=$?
  if [ "$RC3" != 0 ] && grep -q 'PRE_RECUSOU' "$WORK/delta3.log"; then ok "A12 OK — sem a porta, a PRE recusa (PRE_RECUSOU), não erro solto"
  else nok "A12 FALHOU — esperava PRE_RECUSOU com rc≠0; rc=$RC3"; fi
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 3
