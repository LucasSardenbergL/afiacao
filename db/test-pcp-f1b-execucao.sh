#!/usr/bin/env bash
# Prova PG17 — núcleo de execução F1B-M1 (event-sourcing + FSM na projeção + RPCs).
# Cobre as disposições do painel: C1 lock, C2 1-writer, C3 gate/REVOKE, C4 late-arrival,
# C5 idempotência+payload, C6 invariantes consumo, C7 FSM não-avança.
# Rodar: bash db/test-pcp-f1b-execucao.sh > /tmp/t-f1b.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="pcp-f1b"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# uuids fixos
OP1='a1111111-1111-1111-1111-111111111111'   # FSM feliz
OP2='a2222222-2222-2222-2222-222222222222'   # finalizar sem iniciar
OP3='a3333333-3333-3333-3333-333333333333'   # consumo pós-fecho / late-arrival
OP4='a4444444-4444-4444-4444-444444444444'   # consumo antes de iniciar
OP5='a5555555-5555-5555-5555-555555555555'   # idempotência / governança / gate
OP6='a6666666-6666-6666-6666-666666666666'   # lock (concorrência)
AAAA='00000000-0000-0000-0000-00000000aaaa'  # staff
BBBB='00000000-0000-0000-0000-00000000bbbb'  # não-staff

echo "═══ ZONA 1: stubs (auth, roles) + production_orders mínima + OPs fixture ═══"
P -q <<SQL
DO \$\$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) \$\$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- production_orders mínima (o SQL do M1 faz ALTER ADD COLUMN nela). status/completed_at = donos da edge (C2).
CREATE TABLE public.production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text, completed_at timestamptz);
INSERT INTO public.user_roles VALUES ('${AAAA}','employee');
INSERT INTO public.production_orders (id) VALUES
 ('${OP1}'),('${OP2}'),('${OP3}'),('${OP4}'),('${OP5}'),('${OP6}');
SQL

echo "═══ ZONA 2: aplica o M1 2× (re-colar no SQL Editor é esperado — idempotência DDL) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1b-m1-execucao.sql"
if P -q -f "$REPO_ROOT/db/pcp-f1b-m1-execucao.sql" >/dev/null 2>&1; then ok "M1 re-aplicável (2ª colagem não quebra)"; else bad "M1 re-aplicação QUEBROU"; fi
eq "roteiro da cinta seedado (5 etapas)" "$(Pq -c "SELECT count(*) FROM pcp_etapas_catalogo WHERE familia='cinta'")" "5"
eq "colunas novas em production_orders" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='production_orders' AND column_name IN ('origem','prioridade','roteiro_familia','iniciada_em','estado_projetado')")" "5"

# helper: insere evento CRU (bypassa RPC/gate) para montar cenários de FSM. args: op tipo seq client_ts [cols] [vals]
ins() { P -q -c "INSERT INTO pcp_eventos_producao (id,op_id,tipo,device_id,device_seq,client_ts ${5:-}) VALUES (gen_random_uuid(),'$1','$2','dev1',$3,'$4' ${6:-});"; }

echo "═══ ZONA 3: FSM feliz — iniciar→em_producao ; finalizar→concluida (C2: só colunas próprias) ═══"
ins "$OP1" iniciar_op 1 '2026-07-05 08:00:00'
eq "iniciar ⇒ em_producao"        "$(Pq -c "SELECT fn_pcp_projetar_op('${OP1}')")" "em_producao"
ins "$OP1" finalizar_op 2 '2026-07-05 09:00:00'
eq "finalizar ⇒ concluida"        "$(Pq -c "SELECT fn_pcp_projetar_op('${OP1}')")" "concluida"
eq "iniciada_em gravada"          "$(Pq -c "SELECT iniciada_em IS NOT NULL FROM production_orders WHERE id='${OP1}'")" "t"
eq "C2: projeção NÃO tocou completed_at/status (donos da edge)" "$(Pq -c "SELECT completed_at IS NULL AND status IS NULL FROM production_orders WHERE id='${OP1}'")" "t"
eq "estado_projetado persistido"  "$(Pq -c "SELECT estado_projetado FROM production_orders WHERE id='${OP1}'")" "concluida"

echo "═══ ZONA 4+5: idempotência (C5) via RPC — replay idêntico no-op ; reuse divergente EXCEPTION ═══"
EVT='c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'
R1=$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_iniciar_apontamento('${EVT}','${OP5}','dev1',1,'2026-07-05 08:00:00');")
eq "1ª chamada ⇒ em_producao" "$R1" "em_producao"
Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_iniciar_apontamento('${EVT}','${OP5}','dev1',1,'2026-07-05 08:00:00');" >/dev/null
eq "replay idêntico ⇒ ainda 1 evento (idempotente)" "$(Pq -c "SELECT count(*) FROM pcp_eventos_producao WHERE id='${EVT}'")" "1"
REUSE=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_finalizar_apontamento('${EVT}','${OP5}','dev1',1,'2026-07-05 08:00:00');" 2>&1 || true)
case "$REUSE" in *idempotency_key_reuse*) ok "reuse de event_id com payload diferente ⇒ EXCEPTION";; *) bad "reuse NÃO barrado: $REUSE";; esac

echo "═══ ZONA 6: FSM falsifica (C7 não-avança) — finalizar sem iniciar / iniciar duplo ═══"
ins "$OP2" finalizar_op 1 '2026-07-05 09:00:00'
eq "finalizar sem iniciar ⇒ aguardando_anomalo (NÃO avança p/ concluida)" "$(Pq -c "SELECT fn_pcp_projetar_op('${OP2}')")" "aguardando_anomalo"
ins "$OP2" iniciar_op 2 '2026-07-05 09:05:00'
ins "$OP2" iniciar_op 3 '2026-07-05 09:06:00'
eq "iniciar duplo ⇒ anomalia (sufixo _anomalo)" "$(Pq -c "SELECT fn_pcp_projetar_op('${OP2}') LIKE '%_anomalo'")" "t"

echo "═══ ZONA 7: C4 late-arrival — consumo com client_ts ANTES do fecho mas server_ts DEPOIS ⇒ anomalia ═══"
ins "$OP3" iniciar_op 1 '2026-07-05 08:00:00' ",server_ts" ",'2026-07-05 08:00:01'"
ins "$OP3" finalizar_op 2 '2026-07-05 08:30:00' ",server_ts,componente_codigo,quantidade,unidade,motivo" ",'2026-07-05 08:30:01',NULL,NULL,NULL,NULL"
eq "OP3 concluída antes do late-arrival" "$(Pq -c "SELECT fn_pcp_projetar_op('${OP3}')")" "concluida"
# consumo com client_ts 08:15 (reordena ANTES do fecho) mas server_ts 09:00 (chegou DEPOIS): relógio atrasado não mascara.
ins "$OP3" consumo_mp 3 '2026-07-05 08:15:00' ",server_ts,componente_codigo,quantidade,unidade,motivo" ",'2026-07-05 09:00:00',900002,1.5,'G','ajuste'"
eq "consumo late-arrival (server_ts > fecho) ⇒ anomalia" "$(Pq -c "SELECT fn_pcp_projetar_op('${OP3}') LIKE '%_anomalo'")" "t"

echo "═══ ZONA 8: C1 advisory lock — fn_pcp_projetar_op RETÉM o lock POR-OP (serializa projeções) ═══"
# Testa o advisory lock DIRETAMENTE (via pg_try_advisory_xact_lock), isolado do row-lock do UPDATE
# — que serializaria de qualquer jeito e mascararia a remoção do PERFORM. Assim o teste é falsificável.
ins "$OP6" iniciar_op 1 '2026-07-05 08:00:00'
# Conexão A: abre txn, projeta (pega pg_advisory_xact_lock da OP6), segura a txn 2s, commita.
( P -q -c "BEGIN; SELECT fn_pcp_projetar_op('${OP6}'); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
LOCK_A=$!
sleep 0.6
# Conexão B: tenta pegar o MESMO advisory lock. A o retém ⇒ f. (Sem o PERFORM no código ⇒ t ⇒ FAIL.)
GOT6=$(Pq -c "SELECT pg_try_advisory_xact_lock(hashtextextended('${OP6}'::uuid::text, 0));")
case "$GOT6" in f) ok "fn_pcp_projetar_op retém o advisory lock da OP (C1)";; *) bad "advisory lock NÃO retido (got=$GOT6) — projeção sem serialização";; esac
# Controle: o lock é POR-OP — o de OUTRA OP está livre (não é lock global).
GOT1=$(Pq -c "SELECT pg_try_advisory_xact_lock(hashtextextended('${OP1}'::uuid::text, 0));")
case "$GOT1" in t) ok "lock é POR-OP (advisory de outra OP está livre)";; *) bad "lock global demais (OP1 travada: got=$GOT1)";; esac
wait "$LOCK_A" 2>/dev/null || true

echo "═══ ZONA 9: C6 governança do consumo_mp (money-path) ═══"
NOCOMP=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_registrar_evento('$(uuidgen|tr A-Z a-z)','${OP5}','consumo_mp','dev1',9,'2026-07-05 08:10:00','producao',NULL,NULL,NULL);" 2>&1 || true)
case "$NOCOMP" in *"componente_codigo, quantidade>0 e unidade"*) ok "consumo_mp sem componente/qtd ⇒ EXCEPTION";; *) bad "consumo sem invariantes NÃO barrado: $NOCOMP";; esac
NOMOTIVO=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_registrar_evento('$(uuidgen|tr A-Z a-z)','${OP5}','consumo_mp','dev1',9,'2026-07-05 08:10:00',NULL,900002,1,'G');" 2>&1 || true)
case "$NOMOTIVO" in *"consumo_mp exige motivo"*) ok "consumo_mp sem motivo ⇒ EXCEPTION";; *) bad "consumo sem motivo NÃO barrado: $NOMOTIVO";; esac
# consumo válido em OP em_producao ⇒ OK (não-anômalo). OP5 está em_producao (ZONA 4).
CONS_OK=$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_registrar_evento('$(uuidgen|tr A-Z a-z)','${OP5}','consumo_mp','dev1',5,'2026-07-05 08:20:00','erro_formula',900003,0.5,'G');")
eq "consumo válido (erro_formula+componente) em produção ⇒ não-anômalo" "$CONS_OK" "em_producao"

echo "═══ ZONA 10: C3 gate fail-closed + RLS + append-only + superfície das funções ═══"
NS=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${BBBB}'; SELECT fn_pcp_iniciar_apontamento('$(uuidgen|tr A-Z a-z)','${OP5}','dev1',1,'2026-07-05 08:00:00');" 2>&1 || true)
case "$NS" in *"apenas staff"*) ok "não-staff barrado (fail-closed)";; *) bad "não-staff NÃO barrado: $NS";; esac
NULLUID=$(P -tA -c "SET ROLE authenticated; SELECT fn_pcp_iniciar_apontamento('$(uuidgen|tr A-Z a-z)','${OP5}','dev1',1,'2026-07-05 08:00:00');" 2>&1 || true)
case "$NULLUID" in *"apenas staff"*) ok "auth.uid() NULL barrado (fail-closed C3)";; *) bad "uid NULL NÃO barrado: $NULLUID";; esac
PROJ=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT fn_pcp_projetar_op('${OP1}');" 2>&1 || true)
case "$PROJ" in *"permission denied"*) ok "fn_pcp_projetar_op sem grant (interna) ⇒ authenticated barrado";; *) bad "projetar_op exposta: $PROJ";; esac
APPEND=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; UPDATE pcp_eventos_producao SET nota='x' WHERE op_id='${OP1}';" 2>&1 || true)
case "$APPEND" in *"permission denied"*) ok "UPDATE cru em pcp_eventos_producao bloqueado (append-only)";; *) bad "append-only furado: $APPEND";; esac
eq "não-staff vê 0 eventos (RLS fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='${BBBB}'; SELECT count(*) FROM pcp_eventos_producao")" "0"
eq "staff vê eventos (RLS)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='${AAAA}'; SELECT count(*)>0 FROM pcp_eventos_producao")" "t"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
