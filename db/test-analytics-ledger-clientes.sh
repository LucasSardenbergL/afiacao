#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261121160100_analytics_ledger_clientes_sensor.sql                ║
# ║      bash db/test-analytics-ledger-clientes.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)  Locale: LOCALE_TESTE=pt_BR.UTF-8 roda    ║
# ║  a mesma prova no outro locale (as sentinelas são ASCII, caixa fixa).             ║
# ║                                                                                  ║
# ║  O ledger é SECURITY DEFINER e plpgsql é late-bound: prova EXECUTANDO. Cadeia:   ║
# ║  base do outbox → corpo VIVO da prod (extraído da 20261121123119_banco_extrato_f1, ║
# ║  md5 0d010ca3… = o lido via psql-ro) → esta. Falsifica a PRE e a PÓS, e roda a   ║
# ║  query de adoção (db/sensor-clientes-adocao.sql) sobre dados semeados.           ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5487}"
SLUG="analytics-ledger-clientes"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/ (resolve o PGBIN no Mac e no CI)
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY, status text NOT NULL, criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(), aprovado_em timestamptz, aprovado_por text,
  cancelado_em timestamptz, condicao_origem text, origem_evento_tipo text
);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true)
  RETURNING jobid;
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; $f$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
-- Supabase dá EXECUTE a PUBLIC por padrão: reproduz para o REVOKE ter trabalho real.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

M_BASE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
M_PRED="$REPO_ROOT/supabase/migrations/20261121123119_banco_extrato_f1.sql"
MIG="$REPO_ROOT/supabase/migrations/20261121160100_analytics_ledger_clientes_sensor.sql"
ADOCAO="$REPO_ROOT/db/sensor-clientes-adocao.sql"
MD5_ESTE="907cc5afe8c36e43f456160da8774260"

P -q -f "$M_BASE"
# Predecessor = o corpo VIVO de prod (o pg_get_functiondef medido é idêntico a este trecho).
PRED=$(mktemp)
# shellcheck disable=SC2016  # o $ é literal do SQL ($function$), não expansão
sed -n '/^CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar/,/^\$function\$;/p' "$M_PRED" > "$PRED"
P -q -f "$PRED"; rm -f "$PRED"
P -q -c "GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text,text,jsonb) TO anon;"  # o REVOKE tem de tirar
eq "A0 predecessor local = md5 da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "0d010ca3cd3e7dac733ae4f93ba90cf5"
P -q -1 -f "$MIG"
eq "A1 corpo novo = md5 declarado na migration" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "$MD5_ESTE"
P -q -1 -f "$MIG"
ok "A2 migration aplica 2x sem erro (a PRE aceita este)"

UID_A='11111111-1111-1111-1111-111111111111'   # master — base completa
UID_B='22222222-2222-2222-2222-222222222222'   # employee — carteira
UID_C='33333333-3333-3333-3333-333333333333'   # employee que só abriu a tela (denominador)
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$UID_A'), ('$UID_B'), ('$UID_C') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$UID_A','master'), ('$UID_B','employee'), ('$UID_C','employee');
SQL

reg() { # $1 uid  $2 evento  $3 chave  $4 props
  Pq -c "SET test.uid='$1'; SET test.role='authenticated'; SELECT public.analytics_ledger_registrar('$2','$3','$4'::jsonb); SELECT count(*) FROM public.analytics_outbox WHERE evento='$2' AND user_id='$1';" | tail -1
}

echo "── asserts: os 6 eventos gravam, os antigos seguem ──"
eq "B1 lista_aberta"     "$(reg $UID_A clientes.lista_aberta prioridade '{"modo":"prioridade"}')" "1"
eq "B2 modo_trocado"     "$(reg $UID_A clientes.modo_trocado 'prioridade>nome' '{"de":"prioridade","para":"nome","origem":"menu"}')" "1"
eq "B3 filtro_saude"     "$(reg $UID_A clientes.filtro_saude 'nome:critico' '{"modo":"nome","valor":"critico"}')" "1"
eq "B4 busca_usada"      "$(reg $UID_A clientes.busca_usada nome '{"modo":"nome"}')" "1"
eq "B5 cliente_aberto"   "$(reg $UID_A clientes.cliente_aberto 'nome:critico:3' '{"modo":"nome","posicao":3,"filtro_saude":"critico","com_busca":true}')" "1"
eq "B6 pagina_carregada" "$(reg $UID_A clientes.pagina_carregada 'nome:2' '{"modo":"nome","pagina":2}')" "1"
eq "B7 dedup: mesma chave no mesmo dia = 1 linha" "$(reg $UID_A clientes.lista_aberta prioridade '{"modo":"prioridade"}')" "1"
eq "B8 banco.extrato_conferido segue gravando" "$(reg $UID_A banco.extrato_conferido c:d '{}')" "1"
eq "B9 rota_servida segue gravando" "$(reg $UID_C navegacao.rota_servida /admin/customers '{"rota":"/admin/customers"}')" "1"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$UID_A';
DO \$t\$ BEGIN
  PERFORM public.analytics_ledger_registrar('clientes.qualquer_coisa','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ALLOW_FURADO';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENT_ALLOW_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
case "$R" in *SENT_ALLOW_OK*) ok "B10 evento fora da allowlist rejeitado (22023)";; *) bad "B10 allowlist NAO barrou — [$R]";; esac

V=$(Pq -c "SELECT has_function_privilege('anon', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text || ',' || has_function_privilege('public', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text || ',' || has_function_privilege('authenticated', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text;")
eq "B11 ACL: anon e PUBLIC sem EXECUTE, authenticated com" "$V" "false,false,true"

echo "── query de adoção (a versionada) sobre os dados semeados ──"
P -q <<SQL
SET test.uid='$UID_B'; SET test.role='authenticated';
SELECT public.analytics_ledger_registrar('navegacao.rota_servida','/admin/customers','{"rota":"/admin/customers"}');
SELECT public.analytics_ledger_registrar('clientes.lista_aberta','carteira','{"modo":"carteira"}');
SELECT public.analytics_ledger_registrar('clientes.cliente_aberto','carteira:all:1','{"modo":"carteira","posicao":1,"filtro_saude":"all","com_busca":false}');
SET test.uid='$UID_A';
SELECT public.analytics_ledger_registrar('navegacao.rota_servida','/admin/customers','{"rota":"/admin/customers"}');
SQL
OUT=$(P -tA -F'|' -f "$ADOCAO" 2>&1)
printf '    %s\n' "${OUT//$'\n'/$'\n'    }"
# denominador por papel: master 1 (A), employee 2 (B e C abriram a rota)
case "$OUT" in *"denominador|master|1|1"*) ok "D1 denominador master = 1 usuário";; *) bad "D1 denominador master ausente";; esac
case "$OUT" in *"denominador|employee|2|2"*) ok "D2 denominador employee = 2 usuários (C só abriu)";; *) bad "D2 denominador employee ausente";; esac
case "$OUT" in *"clientes.cliente_aberto|employee|1|2"*) ok "D3 cliente_aberto: 1 de 2 employees";; *) bad "D3 adoção cliente_aberto employee errada";; esac
case "$OUT" in *"clientes.modo_trocado|master|1|1"*) ok "D4 modo_trocado: 1 de 1 master";; *) bad "D4 adoção modo_trocado master errada";; esac
case "$OUT" in *"FIM_ADOCAO_OK"*) ok "D5 a query terminou (marcador positivo)";; *) bad "D5 query de adoção sem marcador de fim";; esac

echo "── falsificação: PRE e PÓS têm de abortar a migration sabotada ──"
FALSIF_OK=0; FALSIF_MUDO=0
fals() { # $1 descrição, $2 arquivo sabotado, $3 sentinela esperada
  if R=$(P -q -1 -f "$2" 2>&1); then FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ MUDA: $1 aplicou sem erro"
  else case "$R" in *"$3"*) FALSIF_OK=$((FALSIF_OK+1)); echo "  ✅ detectada: $1";;
                     *) FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ falhou por OUTRO motivo: $1 — [$R]";; esac
  fi
}
md5_do() { python3 -c "import sys,hashlib;s=open(sys.argv[1]).read();i=s.index('AS \$function\$')+len('AS \$function\$');j=s.index('\$function\$;',i);print(hashlib.md5(s[i:j].encode()).hexdigest())" "$1"; }

# S1: allowlist sem um evento novo; PRE/PÓS-md5 intactas → a PÓS por md5 barra.
SAB1=$(mktemp); sed "s/'clientes.pagina_carregada') THEN/'clientes.x') THEN/" "$MIG" > "$SAB1"
cmp -s "$MIG" "$SAB1" && { echo "  ❌ sabotagem 1 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "allowlist SEM pagina_carregada (PÓS por md5)" "$SAB1" "corpo vivo nao e o desta migration"
# S2: mesma sabotagem com o md5 atualizado — sobra a checagem por evento.
SAB2=$(mktemp); sed "s/'clientes.pagina_carregada') THEN/'clientes.x') THEN/" "$MIG" > "$SAB2"
M2=$(md5_do "$SAB2"); sed -i.bak "s/$MD5_ESTE/$M2/g; s/'0d010ca3cd3e7dac733ae4f93ba90cf5', '$M2'/'$MD5_ESTE', '$M2'/" "$SAB2"
fals "allowlist SEM pagina_carregada (por evento)" "$SAB2" "allowlist sem clientes.pagina_carregada"
# S3: recriação que ESQUECE um evento ANTIGO (banco.extrato_conferido), md5 atualizado.
# Só a 1ª ocorrência (o corpo): a mesma linha existe no array da PÓS, e sabotar as duas se anularia.
SAB3=$(mktemp); perl -0pe "s/'banco.extrato_importado', 'banco.extrato_conferido',\n/'banco.extrato_importado',\n/" "$MIG" > "$SAB3"
cmp -s "$MIG" "$SAB3" && { echo "  ❌ sabotagem 3 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
M3=$(md5_do "$SAB3"); sed -i.bak "s/$MD5_ESTE/$M3/g; s/'0d010ca3cd3e7dac733ae4f93ba90cf5', '$M3'/'$MD5_ESTE', '$M3'/" "$SAB3"
fals "recriação que ESQUECE banco.extrato_conferido" "$SAB3" "allowlist sem banco.extrato_conferido"
# S4: o REVOKE de anon some → a PÓS de ACL barra (o setup deu EXECUTE a anon de propósito).
P -q -c "GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text,text,jsonb) TO anon;"
SAB4=$(mktemp); grep -v "FROM anon;" "$MIG" > "$SAB4"
cmp -s "$MIG" "$SAB4" && { echo "  ❌ sabotagem 4 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "sem o REVOKE de anon" "$SAB4" "anon executa o ledger"
rm -f "$SAB1" "$SAB2" "$SAB2.bak" "$SAB3" "$SAB3.bak" "$SAB4"

# Controle: a função boa sobreviveu (rollback das migrations abortadas) e anon continua fora.
P -q -1 -f "$MIG"
eq "C1 após as sabotagens, cliente_aberto ainda grava" "$(reg $UID_A clientes.cliente_aberto 'prioridade:all:9' '{}')" "2"
eq "C2 após as sabotagens, md5 = este" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "$MD5_ESTE"

# S5 (a PRE): outra sessão mudou a função depois do pré-voo → ABORTA em vez de apagar a mudança alheia.
P -q -c "CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(p_evento text, p_chave text, p_props jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$x\$ BEGIN PERFORM 1; /* outra sessao */ END; \$x\$;"
fals "corpo vivo alheio (deriva) — a PRE barra" "$MIG" "PRE FALHOU"
case "$(Pq -c "SELECT prosrc FROM pg_proc WHERE proname='analytics_ledger_registrar'")" in
  *"outra sessao"*) ok "C3 a mudança alheia sobreviveu";;
  *) bad "C3 a migration apagou a mudança alheia";;
esac

echo "  falsificação: $FALSIF_OK detectadas / $FALSIF_MUDO mudas"
[ "$FALSIF_MUDO" = "0" ] && [ "$FALSIF_OK" = "5" ] || FAIL=$((FAIL+1))

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
