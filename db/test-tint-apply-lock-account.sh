#!/usr/bin/env bash
# PROVA — 20261103222838_tint_apply_keys_snapshot_lock_por_account.sql
#
# O apply do keys-snapshot desativa fórmulas ativas da ACCOUNT inteira, mas só travava por loja. Desde
# 20261103093424 o promote classifica _pulados lendo o oficial da account sob o lock
# 'tint_formulas_account:<account>'. A migration faz o apply tomar o mesmo lock, depois do de loja.
# Esta prova sobe o corpo VIVO do apply (md5 conferido contra prod) e assevera:
#
#   APLICA  a migration aplica (numa transação, como o db:aplicar)
#   MD5     o apply trocado tem o md5 que a migration declara
#   LOCK    com o lock por account preso por outra sessão (promote de outra loja da MESMA account), o
#           apply espera (lock_timeout → BLOQUEADO); solto, passa
#   LOJA    o lock de loja continua valendo (outra sessão com o lock da loja → BLOQUEADO)
#   ACL     anon/authenticated não executam o apply
#   IDEMP   re-aplicar é no-op (md5 igual)
#   GUARDA  re-aplicar sobre um apply de OUTRO corpo ABORTA em vez de trocá-lo
# Controle de não-vacuidade: SEM a migration, o apply NÃO espera o lock por account.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO de
# asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-apply-lock-account.sh   (PGPORT_TEST=<porta>; LOCALE_TESTE=pt_BR.UTF-8 no 2º idioma)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5458}}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-applylock.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261103222838_tint_apply_keys_snapshot_lock_por_account.sql"
MD5_PROD='9d97ef00568816a8f799222cacf0fd18'   # md5(prosrc) do apply em prod, 2026-11-03 (psql-ro)
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
q() { PA -d "$1" -tA -c "$2"; }
echo "  · locale do cluster: $(q postgres "SELECT datcollate FROM pg_database WHERE datname = 'postgres'")"

# ── template = schema de prod (snapshot) com o corpo vivo do apply ───────────────────────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_apply" >/dev/null
T() { PA -d tpl_apply "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_PROD" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_PROD)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"
# o ACL de prod (medido): só postgres/service_role executam. O snapshot pode trazer grants a mais.
T -q -c "REVOKE EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) FROM PUBLIC, anon, authenticated" >/dev/null

# Snapshot da loja BIG (só os metadados: o lock vem logo depois da leitura deles; com 1 de 2 chunks o
# apply devolve 'chunks incompletos' — o desfecho que importa é esperou/não esperou).
T -q <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_l1', true),
       ('aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','automatic_primary','tok_big', true);
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at,
                                 total_chunks, chunk_index, keys)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','bbbbbbbb-0000-0000-0000-000000000001',
        'formulas', now(), 2, 0, '[]'::jsonb);
-- devolve o desfecho em ASCII (o texto do erro é traduzido no pt_BR)
CREATE FUNCTION _tenta_apply() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.tint_apply_keys_snapshot('bbbbbbbb-0000-0000-0000-000000000001');
  RETURN 'PASSOU';
EXCEPTION WHEN lock_not_available THEN
  RETURN 'BLOQUEADO';
END $$;
SQL

# Outra sessão segura um advisory lock por $2 s; o apply tenta com lock_timeout 1 s enquanto ela segura
# e de novo depois que ela solta. Imprime "<durante> <depois>".
tenta_com_lock_preso() {
  local db="$1" chave="$2"
  PA -q -d "$db" -c "BEGIN" -c "SELECT pg_advisory_xact_lock(hashtext('$chave'))" \
     -c "SELECT pg_sleep(3)" -c "COMMIT" >/dev/null 2>&1 &
  local pid=$!
  # espera POSITIVA: o lock está de fato preso antes de tentar
  local i
  for i in $(seq 1 50); do
    [ "$(q "$db" "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")" -ge 1 ] && break
    sleep 0.1
  done
  local v1 v2
  v1="$(PA -tA -d "$db" -c "SET lock_timeout = '1s'" -c "SELECT _tenta_apply()" 2>&1 | tail -n 1)"
  wait "$pid"
  v2="$(q "$db" "SELECT _tenta_apply()" 2>&1)"
  echo "$v1 $v2"
}

TODOS="APLICA MD5 LOCK LOJA ACL IDEMP GUARDA"
c_este_de() { sed -nE "s/^  c_este constant text := '([^']*)';/\1/p" "$1"; }

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = banco; imprime os asserts que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" r
  cai() { caidos="$caidos $1"; }
  PA -q -d postgres -c "CREATE DATABASE $db TEMPLATE tpl_apply" >/dev/null
  if ! PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.apl" 2>&1; then
    echo "$TODOS"; return
  fi
  [ "$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")" \
    = "$(c_este_de "$mig")" ] || cai MD5
  r="$(tenta_com_lock_preso "$db" 'tint_formulas_account:oben')"
  [ "$r" = "BLOQUEADO PASSOU" ] || { cai LOCK; echo "    (LOCK: $r)" >&2; }
  r="$(tenta_com_lock_preso "$db" 'tint_sync:oben:BIG')"
  [ "$r" = "BLOQUEADO PASSOU" ] || { cai LOJA; echo "    (LOJA: $r)" >&2; }
  [ "$(q "$db" "SELECT has_function_privilege('anon','public.tint_apply_keys_snapshot(uuid)','EXECUTE')
                    OR has_function_privilege('authenticated','public.tint_apply_keys_snapshot(uuid)','EXECUTE')")" = "f" ] || cai ACL
  local antes depois
  antes="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")"
  if PA -q -d "$db" --single-transaction -f "$mig" >/dev/null 2>&1; then
    depois="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")"
    [ "$antes" = "$depois" ] || cai IDEMP
  else
    cai IDEMP
  fi
  # GUARDA: outro corpo (versão posterior simulada: + 1 comentário) → re-aplicar ABORTA e não o troca
  PA -q -d "$db" >/dev/null <<'SQL'
DO $g$
DECLARE v text := pg_get_functiondef('public.tint_apply_keys_snapshot(uuid)'::regprocedure);
BEGIN
  EXECUTE replace(v, 'BEGIN
  -- Metadados do snapshot', 'BEGIN
  -- (versao posterior)
  -- Metadados do snapshot');
END $g$;
SQL
  antes="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")"
  if PA -q -d "$db" --single-transaction -f "$mig" >/dev/null 2>&1; then cai GUARDA
  else
    depois="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure")"
    [ "$antes" = "$depois" ] || cai GUARDA
  fi
  echo "$caidos" | xargs
}

# ── controle de não-vacuidade: SEM a migration o apply não espera o lock por account ──────────────────
PA -q -d postgres -c "CREATE DATABASE ctl TEMPLATE tpl_apply" >/dev/null
r="$(tenta_com_lock_preso ctl 'tint_formulas_account:oben')"
[ "$r" = "PASSOU PASSOU" ] || { echo "✗ controle: sem a migration o apply já esperava o lock por account [$r] — LOCK seria vácuo"; exit 1; }
r="$(tenta_com_lock_preso ctl 'tint_sync:oben:BIG')"
[ "$r" = "BLOQUEADO PASSOU" ] || { echo "✗ controle: sem a migration o apply não esperava o lock de loja [$r]"; exit 1; }
echo "  · controle: sem a migration, lock por account NÃO bloqueia; lock de loja bloqueia"

# ── a migration real ──────────────────────────────────────────────────────────────────────────────
FALHAS=0
caidos="$(suite "$MIG" real)"
if [ -n "$caidos" ]; then
  echo "✗ migration real: caíram [$caidos]"; sed -n 1,20p "$TMP/real.apl"; FALHAS=1
else
  echo "  ✓ migration real: $TODOS"
fi
# Falsificar sem o controle verde é teatro: uma suíte que reprova tudo aprovaria qualquer sabotagem.
[ "$FALHAS" -eq 0 ] || { echo "VERMELHO (migration real) — falsificações não rodadas"; exit 1; }

# ── falsificações: sabota UMA camada por vez numa cópia; exige o conjunto EXATO de asserts vermelhos ──
# A cópia é CONSISTENTE: o c_este dela é o md5 que o próprio banco calcula para o corpo sabotado (lido
# do erro de um ensaio com c_este sentinela), senão MD5 cairia em toda falsificação e mascararia a camada.
FALSIF_ERR=0
cat >"$TMP/sabota.py" <<'PY'
import sys
src, trocas, dst = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read()
for par in open(trocas).read().rstrip('\n').split('\n=====\n'):
    a, b = par.split('\n-----\n')
    if t.count(a) != 1:
        print('ANCORA'); sys.exit(0)
    t = t.replace(a, b)
open(dst, 'w').write(t)
print('OK')
PY
falsifica() {
  local rot="$1"; shift
  local esperado="$*" copia="$TMP/$rot.sql" python_out
  python_out="$(python3 "$TMP/sabota.py" "$MIG" "$TMP/trocas_$rot" "$copia")"
  if [ "$python_out" != "OK" ]; then echo "  ✗ $rot: sabotagem NÃO aplicou (âncora) — inválida"; FALSIF_ERR=$((FALSIF_ERR + 1)); return; fi
  # md5 consistente: ensaio com sentinela num banco descartável
  local ens="ens_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  sed -i.bak -E "s/^  c_este constant text := '[^']*';/  c_este constant text := 'SENTINELA';/" "$copia"
  PA -q -d postgres -c "CREATE DATABASE $ens TEMPLATE tpl_apply" >/dev/null
  local md5s
  md5s="$(PA -q -d "$ens" --single-transaction -f "$copia" 2>&1 | grep -oE 'md5 do apply e [0-9a-f]{32}' | grep -oE '[0-9a-f]{32}' || true)"
  if [ -n "$md5s" ]; then
    sed -i.bak -E "s/^  c_este constant text := 'SENTINELA';/  c_este constant text := '$md5s';/" "$copia"
  fi
  local db; db="f_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  local got; got="$(suite "$copia" "$db" 2>/dev/null)"
  if [ "$got" = "$esperado" ]; then echo "  ✓ $rot: caíram exatamente [$got]"
  else echo "  ✗ $rot: esperava [$esperado], caíram [$got]"; FALSIF_ERR=$((FALSIF_ERR + 1)); fi
}

# F1: o lock vai para OUTRA chave (não a do promote) → só LOCK cai
cat >"$TMP/trocas_F1" <<'EOF'
  PERFORM pg_advisory_xact_lock(hashtext('tint_formulas_account:' || v_account));
$t1$;
-----
  PERFORM pg_advisory_xact_lock(hashtext('tint_formulas_conta:' || v_account));
$t1$;
=====
  v_conta := position('pg_advisory_xact_lock(hashtext(''tint_formulas_account:'' || v_account))' in v_src);
-----
  v_conta := position('pg_advisory_xact_lock(hashtext(''tint_formulas_conta:'' || v_account))' in v_src);
EOF
falsifica F1 LOCK

# F2: sem a troca (a migration só re-emite o corpo vivo) → LOCK cai; a PÓS o pegaria, então ela é
# desligada junto (camada a camada: aqui a camada é a TROCA)
cat >"$TMP/trocas_F2" <<'EOF'
  EXECUTE replace(v_def, c_busca, c_troca);
-----
  EXECUTE v_def;
=====
  IF v_loja = 0 OR v_conta = 0 OR v_conta < v_loja
     OR position('UPDATE tint_formulas SET desativada_em' in v_src) < v_conta THEN
-----
  IF false THEN
EOF
falsifica F2 LOCK

# F3: sem o no-op por md5 → re-aplicar bate na PRE (o vivo já não é o predecessor) e aborta → IDEMP cai
cat >"$TMP/trocas_F3" <<'EOF'
  IF v_md5 = c_este THEN
-----
  IF false THEN
EOF
falsifica F3 IDEMP

# F4: REVOKE trocado por GRANT a authenticated e a PÓS de ACL desligada → só ACL cai
cat >"$TMP/trocas_F4" <<'EOF'
REVOKE EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) FROM PUBLIC, anon, authenticated;
-----
GRANT EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) TO authenticated;
=====
  IF has_function_privilege('anon', 'public.tint_apply_keys_snapshot(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_apply_keys_snapshot(uuid)', 'EXECUTE') THEN
-----
  IF false THEN
EOF
falsifica F4 ACL

# F5: PRE desligada (aceita qualquer corpo vivo) → sobre o "corpo posterior" a âncora ainda casa e o
# EXECUTE troca; o PÓS-md5 aborta. GUARDA continua verde = a PÓS-md5 é a 2ª camada (redundância
# registrada, não defeito): conjunto esperado VAZIO.
cat >"$TMP/trocas_F5" <<'EOF'
  IF v_md5 <> c_pred THEN
-----
  IF false THEN
EOF
falsifica F5

echo
if [ "$FALHAS" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ]; then
  echo "VERMELHO (falhas=$FALHAS, falsificações erradas=$FALSIF_ERR)"; exit 1
fi
echo "VERDE: $TODOS + 5 falsificações (locale $LOC)"
