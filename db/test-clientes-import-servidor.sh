#!/usr/bin/env bash
# Prova PG17 do IMPORT DE CLIENTES NO SERVIDOR — migration 20261101200000_clientes_import_servidor
# (a rodada com cursor no banco que substitui o laço do navegador em /admin/analytics-sync).
#
# O que prova EXECUTANDO:
#  C1  semear: staff semeia; 2º clique devolve a MESMA rodada (ja_aberta); customer/anon 42501; 1 aberta só
#  C2  lease: acquire entrega o cursor; 2º acquire com lease vivo = NULL; lease vencido (>7 min) é roubado e
#      conta como invocação sem progresso
#  C3  avançar cercado: token errado não escreve; token certo grava cursor/acumulados e LIBERA; o mesmo token
#      reusado não reaplica os deltas
#  C4  20 invocações sem avanço → terminal sem_progresso; acquire passa a devolver NULL
#  C5  5 erros seguidos → terminal erro_persistente
#  C6  re-armar: staff re-arma a falhada mantendo cursor e zerando sequências; com outra aberta → outra_aberta;
#      concluída → nao_rearmavel; customer 42501
#  C7  concluir: concluida_em, cursor zerado; nova semeadura abre outra rodada
#  C8  validação da RPC: slug fora do conjunto, cursor sem conta antes do fim, contador negativo → 22023
#  C9  relatório: só falha que ABANDONOU a conta entra; contas sem credencial deduplicadas
#  C10 RLS/ACL: staff lê, customer não; INSERT direto por authenticated → 42501; 2ª aberta direta → 23505
#  C11 cron de continuação dispara a edge SÓ com rodada aberta, com a ação certa
#  C12 cron semanal semeia (origem cron_semanal) e é no-op com rodada aberta
#  C13 re-apply idempotente preserva as rodadas
#
#   bash db/test-clientes-import-servidor.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-import-servidor.sh
#   bash db/test-clientes-import-servidor.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261101200000_clientes_import_servidor.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="gate_semear:C1c uma_aberta:POST!P2_FALHOU lease_ttl:C2b token_fence:C3a sem_progresso_teto:C4a erro_teto:C5a rearmar_zera:C6b falha_so_abandonada:C9a acl_acquire:POST!P3_FALHOU cron_timeout:POST!P5_FALHOU cron_so_aberta:C11b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-clientes-import.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK clientes-import-servidor" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  grep -E "^PASS=[0-9]+ FAIL=0$" "$LOGDIR/controle.log" || { echo "❌ controle sem recibo PASS/FAIL"; exit 1; }
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [$marca]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5681}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-clientes-import.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cp "$MIG" "$MIG_USADA"

sabotar() {
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  '') ;;
  gate_semear)         sabotar "RAISE EXCEPTION 'clientes_import_semear: acesso restrito à equipe interna' USING ERRCODE = '42501';" "NULL;" ;;
  uma_aberta)          sabotar "CREATE UNIQUE INDEX IF NOT EXISTS clientes_import_rodada_uma_aberta" "CREATE INDEX IF NOT EXISTS clientes_import_rodada_uma_aberta" ;;
  lease_ttl)           sabotar "heartbeat_at < now() - interval '7 minutes'" "heartbeat_at <= now()" ;;
  token_fence)         sabotar "     AND r.running_since IS NOT NULL
     AND r.lease_token = p_lease_token;" "     AND r.running_since IS NOT NULL;" ;;
  sem_progresso_teto)  sabotar "AND r.invocacoes_sem_progresso + 1 >= 20 THEN now()" "AND r.invocacoes_sem_progresso + 1 >= 2000 THEN now()" ;;
  erro_teto)           sabotar "falhou_em     = CASE WHEN erros_consecutivos + 1 >= 5 THEN now()" "falhou_em     = CASE WHEN erros_consecutivos + 1 >= 500 THEN now()" ;;
  rearmar_zera)        sabotar "           erros_consecutivos = 0, invocacoes_sem_progresso = 0,
           running_since = NULL, lease_token = NULL, atualizado_em = now()
     WHERE id = p_rodada_id AND falhou_em IS NOT NULL" "           running_since = NULL, lease_token = NULL, atualizado_em = now()
     WHERE id = p_rodada_id AND falhou_em IS NOT NULL" ;;
  falha_so_abandonada) sabotar "WHEN p_falha IS NOT NULL AND coalesce((p_falha->>'conta_abandonada')::boolean, false)" "WHEN p_falha IS NOT NULL" ;;
  acl_acquire)         sabotar "REVOKE ALL ON FUNCTION public.clientes_import_lease_acquire() FROM PUBLIC, anon, authenticated;" "" ;;
  cron_timeout)        sabotar "        timeout_milliseconds := 150000
      );" "        timeout_milliseconds := 5000
      );" ;;
  cron_so_aberta)      sabotar "    IF EXISTS (SELECT 1 FROM public.clientes_import_rodada WHERE concluida_em IS NULL AND falhou_em IS NULL) THEN
      PERFORM net.http_post(" "    IF true THEN
      PERFORM net.http_post(" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
M=00000000-0000-0000-0000-0000000000ee; E1=00000000-0000-0000-0000-0000000000e1; CUST=00000000-0000-0000-0000-0000000000cc
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
svc()  { printf "SET ROLE service_role; %s" "$1"; }
semear() { Pq -c "$(como "$1" "SELECT public.clientes_import_semear()->>'desfecho'")"; }
acquire() { Pq -c "$(svc "SELECT coalesce(public.clientes_import_lease_acquire()::text, 'NULL')")"; }
# avancar <rodada> <token> <slug|NULL> <pagina> <teto> <importados> <falha-json|NULL> <sem-cred-json> <concluida>
avancar() {
  local slug="$3"; [ "$slug" = "NULL" ] || slug="'$slug'"
  local falha="$7"; [ "$falha" = "NULL" ] || falha="'$falha'::jsonb"
  Pq -c "$(svc "SELECT public.clientes_import_avancar('$1'::uuid, '$2'::uuid, $slug, $4, $5, $6, 3, 1, 2, $falha, '$8'::jsonb, $9)")"
}
aberta() { Pq -c "SELECT id FROM public.clientes_import_rodada WHERE concluida_em IS NULL AND falhou_em IS NULL"; }
token()  { Pq -c "SELECT lease_token FROM public.clientes_import_rodada WHERE id = '$1'"; }
envelhecer() { P -q -c "UPDATE public.clientes_import_rodada SET heartbeat_at = now() - interval '8 minutes' WHERE id = '$1'"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
GRANT SELECT ON public.user_roles TO authenticated;
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
-- pg_cron / pg_net / vault mínimos
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true
  RETURNING jobid $$;
CREATE SCHEMA net;
CREATE TABLE net.chamadas (id bigserial PRIMARY KEY, url text, body jsonb, timeout_ms int, secret text);
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.chamadas (url, body, timeout_ms, secret) VALUES (url, body, timeout_milliseconds, headers->>'x-cron-secret') RETURNING id $$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'segredo-de-teste');
SQL
P -q <<SQL
INSERT INTO auth.users VALUES ('$M'), ('$E1'), ('$CUST');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$E1','employee'), ('$CUST','customer');
SQL

aplicar() { P -v ON_ERROR_STOP=1 -f "$MIG_USADA" 2>&1; }
SAIDA_APPLY="$(aplicar)" || { echo "$SAIDA_APPLY" | tail -20; echo "POST/APPLY FALHOU"; exit 1; }
printf '%s\n' "$SAIDA_APPLY" | grep -q "clientes_import_rodada pronta" || { echo "APPLY sem NOTICE de postcondição"; exit 1; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# C1 semear
eq "C1a staff semeia" "$(semear "$E1")" "semeada"
R1="$(aberta)"
eq "C1b 2o clique = ja_aberta, mesma rodada, 1 aberta" "$(semear "$M")|$(aberta)|$(Pq -c "SELECT count(*) FROM public.clientes_import_rodada")" "ja_aberta|$R1|1"
eq "C1c customer -> 42501" "$(estado "$(como "$CUST" "SELECT public.clientes_import_semear();")")" "42501"
eq "C1d sem usuario (anon) -> 42501" "$(estado "SET ROLE authenticated; SELECT public.clientes_import_semear();")" "42501"
eq "C1e solicitante e origem gravados" "$(Pq -c "SELECT origem || ':' || solicitado_por FROM public.clientes_import_rodada WHERE id='$R1'")" "manual:$E1"

# C2 lease
A1="$(acquire)"
eq "C2a acquire entrega cursor do inicio" "$(Pq -c "SELECT ('$A1'::jsonb->>'rodada_id') || ':' || coalesce('$A1'::jsonb->>'conta_slug','null') || ':' || ('$A1'::jsonb->>'start_page')")" "$R1:null:1"
eq "C2b 2o acquire com lease vivo = NULL" "$(acquire)" "NULL"
T1="$(token "$R1")"
envelhecer "$R1"
A2="$(acquire)"
eq "C2c lease vencido e roubado (token novo) e conta 1 invocacao sem progresso" "$( [ "$A2" != "NULL" ] && [ "$(token "$R1")" != "$T1" ] && echo novo || echo velho)|$(Pq -c "SELECT invocacoes_sem_progresso || ':' || invocacoes FROM public.clientes_import_rodada WHERE id='$R1'")" "novo|1:2"
T2="$(token "$R1")"

# C3 avançar cercado
eq "C3a token errado nao escreve" "$(avancar "$R1" "$T1" oben 4 120 10 NULL '[]' false)|$(Pq -c "SELECT coalesce(conta_slug,'null') || ':' || importados FROM public.clientes_import_rodada WHERE id='$R1'")" "f|null:0"
eq "C3b token certo grava e libera" "$(avancar "$R1" "$T2" oben 4 120 10 NULL '[]' false)|$(Pq -c "SELECT conta_slug || ':' || start_page || ':' || total_paginas || ':' || importados || ':' || pulados || ':' || erros || ':' || telefones_repostos || ':' || (running_since IS NULL) || ':' || (lease_token IS NULL) || ':' || invocacoes_sem_progresso FROM public.clientes_import_rodada WHERE id='$R1'")" "t|oben:4:120:10:3:1:2:true:true:0"
eq "C3c mesmo token reusado nao reaplica" "$(avancar "$R1" "$T2" oben 5 120 10 NULL '[]' false)|$(Pq -c "SELECT importados FROM public.clientes_import_rodada WHERE id='$R1'")" "f|10"

# C4 sem progresso
for _ in $(seq 1 20); do
  acquire >/dev/null
  T="$(token "$R1")"
  [ -n "$T" ] && avancar "$R1" "$T" oben 4 120 0 NULL '[]' false >/dev/null
done
eq "C4a 20 lotes sem avanco -> terminal sem_progresso" "$(Pq -c "SELECT coalesce(motivo_falha,'aberta') || ':' || (falhou_em IS NOT NULL) FROM public.clientes_import_rodada WHERE id='$R1'")" "sem_progresso:true"
eq "C4b acquire depois do terminal = NULL" "$(acquire)" "NULL"

# C6 re-armar (antes de abrir outra)
eq "C6a customer nao rearma -> 42501" "$(estado "$(como "$CUST" "SELECT public.clientes_import_rearmar('$R1');")")" "42501"
eq "C6b staff rearma: cursor mantido, sequencias zeradas" "$(Pq -c "$(como "$E1" "SELECT public.clientes_import_rearmar('$R1')->>'desfecho'")")|$(Pq -c "SELECT conta_slug || ':' || start_page || ':' || importados || ':' || invocacoes_sem_progresso || ':' || erros_consecutivos || ':' || (falhou_em IS NULL) FROM public.clientes_import_rodada WHERE id='$R1'")" "rearmada|oben:4:10:0:0:true"

# C5 erro persistente
for _ in $(seq 1 5); do
  acquire >/dev/null
  T="$(token "$R1")"
  [ -n "$T" ] && Pq -c "$(svc "SELECT public.clientes_import_liberar_erro('$R1', '$T', 'Omie fora do ar')")" >/dev/null
done
eq "C5a 5 erros seguidos -> terminal erro_persistente" "$(Pq -c "SELECT coalesce(motivo_falha,'aberta') || ':' || (falhou_em IS NOT NULL) || ':' || ultimo_erro FROM public.clientes_import_rodada WHERE id='$R1'")" "erro_persistente:true:Omie fora do ar"

# C7 nova rodada e conclusão; C6c/C6d
eq "C7a semear com a anterior falhada abre outra" "$(semear "$E1")" "semeada"
R2="$(aberta)"
eq "C6c rearmar a falhada com outra aberta -> outra_aberta" "$(Pq -c "$(como "$E1" "SELECT public.clientes_import_rearmar('$R1')->>'desfecho'")")" "outra_aberta"
acquire >/dev/null; T="$(token "$R2")"
eq "C9a falha que nao abandonou NAO entra; contas sem credencial entram" "$(avancar "$R2" "$T" oben 2 50 5 '{"conta":"Oben","conta_abandonada":false}' '[{"account":"colacor","name":"Colacor"}]' false)|$(Pq -c "SELECT jsonb_array_length(falhas) || ':' || jsonb_array_length(contas_sem_credencial) FROM public.clientes_import_rodada WHERE id='$R2'")" "t|0:1"
acquire >/dev/null; T="$(token "$R2")"
eq "C9b falha que abandonou entra; sem credencial deduplicada" "$(avancar "$R2" "$T" colacor 1 0 0 '{"conta":"Oben","conta_abandonada":true,"pagina":3}' '[{"account":"colacor","name":"Colacor"}]' false)|$(Pq -c "SELECT jsonb_array_length(falhas) || ':' || (falhas->0->>'pagina') || ':' || jsonb_array_length(contas_sem_credencial) FROM public.clientes_import_rodada WHERE id='$R2'")" "t|1:3:1"
acquire >/dev/null; T="$(token "$R2")"
eq "C7b concluir: concluida_em, cursor zerado, lease livre" "$(avancar "$R2" "$T" NULL 1 0 7 NULL '[]' true)|$(Pq -c "SELECT (concluida_em IS NOT NULL) || ':' || coalesce(conta_slug,'null') || ':' || importados || ':' || (lease_token IS NULL) FROM public.clientes_import_rodada WHERE id='$R2'")" "t|true:null:12:true"
eq "C6d rearmar concluida -> nao_rearmavel" "$(Pq -c "$(como "$E1" "SELECT public.clientes_import_rearmar('$R2')->>'desfecho'")")" "nao_rearmavel"

# C8 validação
eq "C8a slug fora do conjunto -> 22023" "$(estado "$(svc "SELECT public.clientes_import_avancar('$R2', gen_random_uuid(), 'acme', 1, 0, 0, 0, 0, 0, NULL, '[]', false);")")" "22023"
eq "C8b cursor sem conta antes do fim -> 22023" "$(estado "$(svc "SELECT public.clientes_import_avancar('$R2', gen_random_uuid(), NULL, 1, 0, 0, 0, 0, 0, NULL, '[]', false);")")" "22023"
eq "C8c contador negativo -> 22023" "$(estado "$(svc "SELECT public.clientes_import_avancar('$R2', gen_random_uuid(), 'oben', 1, 0, -1, 0, 0, 0, NULL, '[]', false);")")" "22023"

# C10 RLS/ACL
eq "C10a staff le as rodadas; customer nao" "$(Pq -c "$(como "$E1" "SELECT count(*) FROM public.clientes_import_rodada")")|$(Pq -c "$(como "$CUST" "SELECT count(*) FROM public.clientes_import_rodada")")" "2|0"
eq "C10b INSERT direto por staff -> 42501" "$(estado "$(como "$M" "INSERT INTO public.clientes_import_rodada (origem) VALUES ('manual');")")" "42501"
eq "C10c ACL: internas fechadas a authenticated/anon; semear aberto a authenticated" "$(Pq -c "SELECT has_function_privilege('authenticated','public.clientes_import_lease_acquire()','EXECUTE') || ':' || has_function_privilege('authenticated','private.clientes_import_semear_interno(text,uuid)','EXECUTE') || ':' || has_function_privilege('anon','public.clientes_import_semear()','EXECUTE') || ':' || has_function_privilege('authenticated','public.clientes_import_semear()','EXECUTE')")" "false:false:false:true"
P -q -c "INSERT INTO public.clientes_import_rodada (origem) VALUES ('manual');"
eq "C10d 2a rodada aberta direta -> 23505" "$(estado "INSERT INTO public.clientes_import_rodada (origem) VALUES ('manual');")" "23505"
R3="$(aberta)"

# C11 cron de continuação
CMD_CONT="$(Pq -c "SELECT command FROM cron.job WHERE jobname='clientes-import-continuacao-1min'")"
P -q -c "$CMD_CONT"
eq "C11a com rodada aberta: 1 chamada a omie-cliente com a acao e o segredo" "$(Pq -c "SELECT count(*) || ':' || max(body->>'action') || ':' || max(timeout_ms) || ':' || max(secret) || ':' || (max(url) LIKE '%/functions/v1/omie-cliente') FROM net.chamadas")" "1:continuar_import_clientes:150000:segredo-de-teste:true"
P -q -c "UPDATE public.clientes_import_rodada SET concluida_em = now() WHERE id = '$R3'"
P -q -c "$CMD_CONT"
eq "C11b sem rodada aberta: nenhuma chamada nova" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "1"

# C12 cron semanal
CMD_SEM="$(Pq -c "SELECT command FROM cron.job WHERE jobname='clientes-import-semanal'")"
P -q -c "$CMD_SEM"
eq "C12a semanal semeia com origem cron_semanal" "$(Pq -c "SELECT origem || ':' || coalesce(solicitado_por::text,'null') FROM public.clientes_import_rodada WHERE concluida_em IS NULL AND falhou_em IS NULL")" "cron_semanal:null"
P -q -c "$CMD_SEM"
eq "C12b semanal com rodada aberta e no-op" "$(Pq -c "SELECT count(*) FROM public.clientes_import_rodada WHERE concluida_em IS NULL AND falhou_em IS NULL")|$(Pq -c "SELECT count(*) FROM public.clientes_import_rodada")" "1|4"

# C13 re-apply
SAIDA2="$(aplicar)" || { echo "$SAIDA2" | tail -10; }
eq "C13a re-apply com NOTICE e rodadas preservadas" "$(printf '%s\n' "$SAIDA2" | grep -c "clientes_import_rodada pronta")|$(Pq -c "SELECT count(*) FROM public.clientes_import_rodada")|$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname LIKE 'clientes-import-%'")" "1|4|2"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK clientes-import-servidor"
