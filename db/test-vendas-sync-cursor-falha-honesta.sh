#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — falha honesta do vendas_sync_cursor (pendência PROVADA no banco) ║
# ║  Migration: 20261015221700_vendas_sync_cursor_falha_honesta.sql (sobre o        ║
# ║  fencing 20261015221600). Prova: (R) pré-registro e falhos entram só pelo dono, ║
# ║  com dedup por identidade, e a lista é PODADA pelo que existe em sales_orders · ║
# ║  (C) fim real só COMPLETA com a poda vazia; 1ª vez re-arma SEM apagar a lista,  ║
# ║  2ª vez TERMINAL — inclusive os 3 furos do 2º challenge Codex (pedido que some  ║
# ║  da listagem, morte entre pré-registro e gravação, pedido curado) · (E) erro    ║
# ║  persistente: 5× http/error ou 20× qualquer erro sem avançar → terminal ·       ║
# ║  (T) terminal sai do cron/acquire · (S/M) semear e rearmar com gate staff ·     ║
# ║  (L) zumbi da edge velha não rebobina · (V) validador · (G) falsificação.       ║
# ║  Rodar:  bash db/test-vendas-sync-cursor-falha-honesta.sh > "$LOG" 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5462}"
SLUG="vendas-sync-cursor-falha-honesta"
TMPROOT="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPROOT/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPROOT"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPROOT/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHOU  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
mordeu() {  # $1 rotulo  $2 veredito sob sabotagem  $3 veredito VERDE (tem de diferir)
  if [ "$2" != "$3" ]; then ok "$1 ($2)"; else bad "$1 — sabotei e o assert seguiu verde ($2)"; fi
}

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: gate staff (has_role verbatim da prod), schema private, sales_orders com a
# chave REAL do índice que a poda usa (uniq_sales_orders_omie_hash: (account, hash_payload) WHERE
# hash_payload LIKE 'omie\_%', medido por psql-ro 2026-10-15), e stubs cron/net/vault.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.sales_orders (id bigserial PRIMARY KEY, account text, hash_payload text);
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE TABLE public.order_items (id bigserial PRIMARY KEY, sales_order_id bigint REFERENCES public.sales_orders(id));
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  v_id := COALESCE((SELECT max(jobid) FROM cron.job), 0) + 1;
  INSERT INTO cron.job(jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname=$1; SELECT true; $$;
-- assinatura nomeada do pg_cron 1.6 (a migration chama `command :=`)
CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j SET schedule = coalesce($2, j.schedule), command = coalesce($3, j.command),
                        active = coalesce($6, j.active)
   WHERE j.jobid = $1; $$;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._calls (id serial PRIMARY KEY, url text, body jsonb);
CREATE OR REPLACE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net._calls(url, body) VALUES (url, body);
  SELECT count(*)::bigint FROM net._calls; $$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET','test-secret');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS, na ordem de prod: fundação → semear v2 → fencing → a SOB TESTE.
# ══════════════════════════════════════════════════════════════════════════════
MIG_BASE="$REPO_ROOT/supabase/migrations/20260617133633_vendas_sync_cursor.sql"
MIG_SEMEAR="$REPO_ROOT/supabase/migrations/20260726140000_vendas_sync_semear_janela_v2.sql"
MIG_FENCE="$REPO_ROOT/supabase/migrations/20261015221600_vendas_sync_cursor_fencing_token.sql"
MIG="$REPO_ROOT/supabase/migrations/20261015221700_vendas_sync_cursor_falha_honesta.sql"
VALIDA="$REPO_ROOT/db/valida-vendas-sync-cursor-falha-honesta.sql"
VALIDA_FENCE="$REPO_ROOT/db/valida-vendas-sync-cursor-fencing.sql"
quieto() { PGOPTIONS="-c client_min_messages=warning" P -q -f "$1" >/dev/null; }
quieto "$MIG_BASE"; quieto "$MIG_SEMEAR"; quieto "$MIG_FENCE"; quieto "$MIG"
echo "migrations aplicadas: base + semear v2 + fencing + $(basename "$MIG")"

P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'), ('22222222-2222-2222-2222-222222222222','customer');
GRANT SELECT ON public.user_roles TO authenticated;
SQL
STAFF='11111111-1111-1111-1111-111111111111'; CUST='22222222-2222-2222-2222-222222222222'

# ── helpers (janela = oben/<df>/<df+30>; cada cenário usa a sua) ──
J()     { echo "'oben','$1',(DATE '$1' + 30)"; }
seed()  { P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page) VALUES ($(J "$1"),$2);" >/dev/null; }
acq()   { Pq -c "SELECT public.vendas_sync_lease_acquire_fenced($(J "$1"))->>'lease_token';"; }
hb()    { Pq -c "SELECT public.vendas_sync_heartbeat_fenced($(J "$1"),'$2'::uuid,$3);"; }
fin()   { Pq -c "SELECT public.vendas_sync_finish_fenced($(J "$1"),'$2'::uuid,$3,$4,$5);"; }
rel()   { Pq -c "SELECT public.vendas_sync_release_fenced($(J "$1"),'$2'::uuid,$3);"; }
reg()   { Pq -c "SELECT public.vendas_sync_registrar_falhas_fenced($(J "$1"),'$2'::uuid,'$3'::jsonb);"; }
falho() { echo "[{\"codigo_pedido\":$1,\"hash\":\"omie_oben_$1\",\"sqlstate\":\"23505\",\"erro\":\"dup\",\"pagina\":1}]"; }
pre()   { echo "[{\"codigo_pedido\":$1,\"hash\":\"omie_oben_$1\",\"pagina\":1}]"; }      # pré-registro (sem SQLSTATE)
# pedido PROVADO = pai + ≥1 item; órfão = pai SEM item (o reparo que falhou deixa assim)
orfao() { P -q -c "INSERT INTO public.sales_orders(account,hash_payload) VALUES ('oben','omie_oben_$1') ON CONFLICT DO NOTHING;" >/dev/null; }
existe(){ orfao "$1"; P -q -c "INSERT INTO public.order_items(sales_order_id) SELECT id FROM public.sales_orders WHERE account='oben' AND hash_payload='omie_oben_$1';" >/dev/null; }
# estado: completa/terminal/motivo/tentativas/consecutivas/sem_progresso/nfalhos/next_page
est()   { Pq -c "SELECT (completed_at IS NOT NULL)||'/'||(falhou_em IS NOT NULL)||'/'||coalesce(motivo_falha,'-')||'/'||tentativas_falha||'/'||falhas_consecutivas||'/'||pausas_sem_progresso||'/'||jsonb_array_length(pedidos_falhos)||'/'||coalesce(next_page::text,'null')
                FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='$1';"; }
como()  { local uid="$1"; shift; Pq -c "SET test.uid='$uid'; SET ROLE authenticated; $*" | tail -1; }
# uma passada inteira do motor: toma o lease, (registra um falho), chega ao fim real
passada() {  # $1 df  $2 "" ou codigo_pedido falho
  local t; t=$(acq "$1")
  [ -n "$t" ] || return 0   # sem lease (janela completa/terminal): a passada não acontece
  [ -n "$2" ] && reg "$1" "$t" "$(falho "$2")" >/dev/null
  fin "$1" "$t" true NULL NULL >/dev/null
}

# ── cenários reutilizados pela falsificação (deixam o veredito em OUT) ──
cen_rearma_1a()    { seed "$1" 1; passada "$1" "$2"; OUT="$(est "$1")"; }
cen_terminal_2a()  { seed "$1" 1; passada "$1" "$2"; passada "$1" "$2"; OUT="$(est "$1")"; }
cen_cura_entre_passadas() {  # falhou na 1ª, o pedido passa a EXISTIR (cron 2h), 2ª passada sem falho
  seed "$1" 1; passada "$1" "$2"; existe "$2"; passada "$1" ""; OUT="$(est "$1")"
}
cen_some_da_listagem() {     # Codex P1: falhou na 1ª, NUNCA chega ao banco, 2ª passada não o vê
  seed "$1" 1; passada "$1" "$2"; passada "$1" ""; OUT="$(est "$1")"
}
cen_morte_pre_registro() {   # Codex P2: pré-registrou, morreu antes de anotar o failed[]; passadas seguem sem vê-lo
  seed "$1" 1; local t a; t=$(acq "$1"); reg "$1" "$t" "$(pre "$2")" >/dev/null; rel "$1" "$t" "'error'" >/dev/null
  passada "$1" ""; a=$(est "$1"); existe "$2"; passada "$1" ""
  OUT="$a|$(est "$1")"
}
cen_poda_curado() {          # Codex P3: o falho é curado e a próxima escrita da lista o tira dela
  seed "$1" 1; local t; t=$(acq "$1"); reg "$1" "$t" "$(falho "$2")" >/dev/null; existe "$2"
  reg "$1" "$t" "$(pre "$3")" >/dev/null
  OUT="$(Pq -c "SELECT string_agg(e->>'codigo_pedido', ',') FROM public.vendas_sync_cursor c, jsonb_array_elements(c.pedidos_falhos) e WHERE c.date_from='$1';")"
}
cen_rearmar_nao_apaga() {    # Codex P1 via staff: terminal com pendência, rearma, passada sem falho → NÃO completa
  cen_terminal_2a "$1" "$2"
  # sem OUTRA janela em andamento na conta (senão o rearmar recusa, corretamente, com ja_pendente_outra)
  P -q -c "DELETE FROM public.vendas_sync_cursor WHERE account='oben' AND completed_at IS NULL AND falhou_em IS NULL;" >/dev/null
  local r; r=$(como "$STAFF" "SELECT (public.vendas_sync_rearmar_janela($(J "$1")))->>'rearmada';")
  [ "$r" = "true" ] || { OUT="REARMAR_RECUSOU($r)"; return; }
  passada "$1" ""; OUT="$(est "$1")"
}
cen_transitorio_infinito() { # Codex P4: 20 pausas transient sem avançar → terminal
  seed "$1" 3; local t a
  for _ in $(seq 1 19); do t=$(acq "$1"); fin "$1" "$t" false 3 "'transient'" >/dev/null; done
  a=$(est "$1"); t=$(acq "$1"); fin "$1" "$t" false 3 "'transient'" >/dev/null
  OUT="$a|$(est "$1")"
}
cen_cron_pula_terminal() {
  P -q -c "TRUNCATE net._calls; DELETE FROM public.vendas_sync_cursor WHERE account='colacor';" >/dev/null
  P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,falhou_em,motivo_falha)
             VALUES ('colacor','2020-01-01','2020-01-31',now(),'pedidos_falhos'),
                    ('colacor','2024-01-01','2024-01-31',NULL,NULL);" >/dev/null
  P -q -c "DO \$x\$ DECLARE c text; BEGIN SELECT command INTO c FROM cron.job WHERE jobname='vendas-sync-continuacao-6min'; EXECUTE c; END \$x\$;" >/dev/null
  OUT="$(Pq -c "SELECT coalesce(string_agg(body->>'date_from', ','), 'nada') FROM net._calls WHERE body->>'account'='colacor';")"
}
cen_acquire_terminal() {
  seed "$1" 1; P -q -c "UPDATE public.vendas_sync_cursor SET falhou_em=now(), motivo_falha='erro_persistente' WHERE date_from='$1';" >/dev/null
  # o retorno E o estado: o acquire cercado devolve NULL p/ terminal pelo RETURNING — sem o filtro no
  # WHERE ele TOMARIA o lease em silêncio; só o running_since revela (lição da falsificação G4)
  OUT="[$(acq "$1")][$(Pq -c "SELECT public.vendas_sync_lease_acquire($(J "$1"));")]$(Pq -c "SELECT (running_since IS NULL) FROM public.vendas_sync_cursor WHERE date_from='$1';")"
}
cen_semear_ignora_terminal() {  # conta oben com terminal antiga: a mesma janela → ja_falhou; outra → semeada
  P -q -c "DELETE FROM public.vendas_sync_cursor WHERE account='oben' AND completed_at IS NULL AND falhou_em IS NULL;" >/dev/null
  P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,falhou_em,motivo_falha)
             VALUES ('oben','2019-01-01','2019-01-31',now(),'pedidos_falhos');" >/dev/null
  local a b   # b ANTES de a: a janela que `a` cria seria, corretamente, "outra em andamento" para `b`
  b=$(como "$STAFF" "SELECT r->'contas'->0->>'desfecho' FROM public.vendas_sync_semear_janela(DATE '2019-01-01', DATE '2019-01-31', ARRAY['oben']) r;")
  a=$(como "$STAFF" "SELECT r->'contas'->0->>'desfecho' FROM public.vendas_sync_semear_janela(DATE '2025-11-01', DATE '2025-11-30', ARRAY['oben']) r;")
  P -q -c "DELETE FROM public.vendas_sync_cursor WHERE account='oben' AND date_from IN ('2025-11-01','2019-01-01');" >/dev/null
  OUT="$a|$b"
}
cen_rearmar_customer() {
  seed "$1" 1; P -q -c "UPDATE public.vendas_sync_cursor SET falhou_em=now(), motivo_falha='pedidos_falhos' WHERE date_from='$1';" >/dev/null
  OUT=$(P -q -tA 2>&1 <<SQL || true
SET test.uid='$CUST'; SET ROLE authenticated;
DO \$x\$ BEGIN
  PERFORM public.vendas_sync_rearmar_janela('oben','$1',(DATE '$1' + 30));
  RAISE NOTICE 'REARMOU_SEM_GATE';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_BARROU_REARMAR'; END \$x\$;
SQL
)
  case "$OUT" in *GATE_BARROU_REARMAR*) OUT="barrou|$(est "$1")" ;; *REARMOU_SEM_GATE*) OUT="rearmou|$(est "$1")" ;; esac
}
cen_zumbi_edge_velha() {  # 1º challenge P1: A antigo trava; B cercado rouba, avança e pausa; A acorda
  seed "$1" 1
  Pq -c "SELECT public.vendas_sync_lease_acquire($(J "$1"));" >/dev/null
  P -q -c "UPDATE public.vendas_sync_cursor SET heartbeat_at = now() - interval '4 minutes' WHERE date_from='$1';" >/dev/null
  local tb; tb=$(acq "$1")
  hb "$1" "$tb" 13 >/dev/null; fin "$1" "$tb" false 13 NULL >/dev/null
  Pq -c "SELECT public.vendas_sync_finish($(J "$1"),false,3,'http');" >/dev/null
  Pq -c "SELECT public.vendas_sync_release($(J "$1"),'error');" >/dev/null
  OUT="$(Pq -c "SELECT next_page||'/'||coalesce(last_error_kind,'-') FROM public.vendas_sync_cursor WHERE date_from='$1';")"
}
cen_registrar_alheio() {
  seed "$1" 1; local t; t=$(acq "$1"); reg "$1" "$t" "$(falho 1)" >/dev/null
  OUT="$(reg "$1" "00000000-0000-0000-0000-000000000000" "$(falho 2)")|$(est "$1")"
}
cen_reparo_falho() {         # 3º challenge P2: o pai existe mas ÓRFÃO (reparo falhou) → não é prova
  seed "$1" 1; orfao "$2"; passada "$1" "$2"; local a; a=$(est "$1"); existe "$2"; passada "$1" ""
  OUT="$a|$(est "$1")"
}
cen_morte_repetida() {       # 3º challenge P3: worker morre sem finish/release, de novo e de novo
  seed "$1" 3; acq "$1" >/dev/null
  local i r=""
  for i in $(seq 1 20); do
    P -q -c "UPDATE public.vendas_sync_cursor SET heartbeat_at = now() - interval '4 minutes' WHERE date_from='$1';" >/dev/null
    r=$(acq "$1"); [ "$i" = 19 ] && OUT="[$( [ -n "$r" ] && echo lease)]$(est "$1")"
  done
  OUT="$OUT|[$r]$(est "$1")|$(Pq -c "SELECT (running_since IS NULL)||'/'||(lease_token IS NULL) FROM public.vendas_sync_cursor WHERE date_from='$1';")"
}
cen_finish_legado() {        # 3º challenge P4: pendência aberta + edge REVERTIDA (caminho antigo) chega ao fim
  seed "$1" 1; passada "$1" "$2"
  Pq -c "SELECT public.vendas_sync_lease_acquire($(J "$1"));" >/dev/null
  Pq -c "SELECT public.vendas_sync_finish($(J "$1"),true,NULL,NULL);" >/dev/null
  OUT="$(est "$1")"
}
cen_pausa_poda() {           # 3º challenge P6: pré-registrado e gravado; a pausa (orçamento) poda
  seed "$1" 1; local t; t=$(acq "$1"); reg "$1" "$t" "$(pre "$2")" >/dev/null; existe "$2"
  fin "$1" "$t" false 2 NULL >/dev/null; OUT="$(est "$1")"
}
cen_progresso_zera() {
  seed "$1" 4; P -q -c "UPDATE public.vendas_sync_cursor SET falhas_consecutivas=3, pausas_sem_progresso=7 WHERE date_from='$1';" >/dev/null
  local t a; t=$(acq "$1"); hb "$1" "$t" 4 >/dev/null; a=$(est "$1"); hb "$1" "$t" 5 >/dev/null
  OUT="$a|$(est "$1")"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- R: registrar (dono, dedup por identidade, poda pelo banco) --"
seed 2026-01-01 1; T=$(acq 2026-01-01)
eq "R1 dono registra -> true" "$(reg 2026-01-01 "$T" '[{"codigo_pedido":10,"hash":"omie_oben_10","sqlstate":"23505"},{"codigo_pedido":11,"hash":"omie_oben_11","sqlstate":"40P01"}]')" "t"
reg 2026-01-01 "$T" '[{"codigo_pedido":11,"hash":"omie_oben_11","sqlstate":"57014"},{"codigo_pedido":12,"hash":"omie_oben_12","sqlstate":"23502"}]' >/dev/null
eq "R2 dedup por identidade (10,11,12)" "$(est 2026-01-01)" "false/false/-/0/0/0/3/1"
eq "R2 a entrada repetida guarda a ULTIMA falha" "$(Pq -c "SELECT e->>'sqlstate' FROM public.vendas_sync_cursor c, jsonb_array_elements(c.pedidos_falhos) e WHERE c.date_from='2026-01-01' AND e->>'codigo_pedido'='11';")" "57014"
cen_registrar_alheio 2026-01-15; eq "R3 token alheio -> false, lista intacta" "$OUT" "f|false/false/-/0/0/0/1/1"
R=$(P -q -tA 2>&1 <<SQL
DO \$x\$ BEGIN
  PERFORM public.vendas_sync_registrar_falhas_fenced('oben','2026-01-01','2026-01-31','$T'::uuid,'{"x":1}'::jsonb);
  RAISE EXCEPTION 'SABOTAGEM_ACEITOU_OBJETO';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'R4_CONTRATO_BARROU'; WHEN OTHERS THEN RAISE; END \$x\$;
SQL
)
case "$R" in *R4_CONTRATO_BARROU*) ok "R4 p_falhas nao-array -> 22023" ;; *) bad "R4 — veio: $R" ;; esac
cen_poda_curado 2026-01-20 501 502; eq "R5 (Codex P3) pedido curado sai da lista na proxima escrita" "$OUT" "502"

echo "-- C: completude so com a prova no banco --"
seed 2026-02-01 1; passada 2026-02-01 ""
eq "C1 fim real SEM pendencia completa" "$(est 2026-02-01)" "true/false/-/0/0/0/0/null"
cen_rearma_1a 2026-03-01 777
eq "C2 fim real COM pendencia (1a vez): re-arma SEM apagar a lista" "$OUT" "false/false/-/1/0/0/1/null"
eq "C2 a janela re-armada volta a ser adquirida desde a pagina 1" "$(Pq -c "SELECT public.vendas_sync_lease_acquire_fenced($(J 2026-03-01))->>'resume_page';")" "1"
cen_terminal_2a 2026-04-01 777
eq "C3 2a passada ainda COM pendencia -> TERMINAL com a lista" "$OUT" "false/true/pedidos_falhos/1/0/0/1/null"
cen_cura_entre_passadas 2026-05-01 778
eq "C4 curado (existe em sales_orders) -> completa e a lista zera" "$OUT" "true/false/-/1/0/0/0/null"
cen_some_da_listagem 2026-05-15 779
eq "C5 (Codex P1) falhou e SUMIU da listagem -> NAO completa: terminal" "$OUT" "false/true/pedidos_falhos/1/0/0/1/null"
cen_morte_pre_registro 2026-06-01 780
eq "C6 (Codex P2) morte entre pre-registro e gravacao: pendente ate o pedido existir" "$OUT" "false/false/-/1/0/0/1/null|true/false/-/1/0/0/0/null"

cen_reparo_falho 2026-06-05 790
eq "C7 (3o P2) pai orfao (reparo falhou) NAO prova; com item, prova" "$OUT" "false/false/-/1/0/0/1/null|true/false/-/1/0/0/0/null"
cen_finish_legado 2026-06-07 792
eq "C8 (3o P4) finish ANTIGO nao completa com pendencia aberta" "$OUT" "false/false/-/1/0/0/1/null"
cen_pausa_poda 2026-06-08 793
eq "C9 (3o P6) a pausa poda o que ja foi gravado (nao vira falha falsa)" "$OUT" "false/false/-/0/0/0/0/2"

echo "-- E: erro persistente --"
seed 2026-06-10 3
for _ in 1 2 3 4; do t=$(acq 2026-06-10); fin 2026-06-10 "$t" false 3 "'http'" >/dev/null; done
eq "E1 4 pausas http seguidas: ainda aberta" "$(est 2026-06-10)" "false/false/-/0/4/4/0/3"
t=$(acq 2026-06-10); fin 2026-06-10 "$t" false 3 "'rate_limit'" >/dev/null
eq "E2 rate_limit nao conta no limite curto (so no longo)" "$(est 2026-06-10)" "false/false/-/0/4/5/0/3"
t=$(acq 2026-06-10); fin 2026-06-10 "$t" false 3 "'http'" >/dev/null
eq "E3 a 5a pausa http -> TERMINAL erro_persistente" "$(est 2026-06-10)" "false/true/erro_persistente/0/5/6/0/3"
seed 2026-06-15 3; P -q -c "UPDATE public.vendas_sync_cursor SET falhas_consecutivas=3, pausas_sem_progresso=9 WHERE date_from='2026-06-15';" >/dev/null
t=$(acq 2026-06-15); fin 2026-06-15 "$t" false 5 NULL >/dev/null
eq "E4 pausa por orcamento (kind NULL) zera as duas" "$(est 2026-06-15)" "false/false/-/0/0/0/0/5"
cen_progresso_zera 2026-07-01
eq "E5 heartbeat sem avancar mantem; avancando zera as duas" "$OUT" "false/false/-/0/3/7/0/4|false/false/-/0/0/0/0/5"
seed 2026-07-15 2
for _ in 1 2 3 4 5; do t=$(acq 2026-07-15); rel 2026-07-15 "$t" "'error'" >/dev/null; done
eq "E6 release por erro inesperado tambem leva ao terminal" "$(est 2026-07-15)" "false/true/erro_persistente/0/5/5/0/2"
cen_transitorio_infinito 2026-07-20
eq "E7 (Codex P4) 19 transient: aberta; a 20a sem avancar -> terminal" "$OUT" "false/false/-/0/0/19/0/3|false/true/erro_persistente/0/0/20/0/3"

cen_morte_repetida 2026-07-25
eq "E8 (3o P3) 19 mortes sem finish: lease segue; a 20a vira terminal SEM entregar lease" "$OUT" "[lease]false/false/-/0/0/19/0/3|[]false/true/erro_persistente/0/0/20/0/3|true/true"

echo "-- T: o terminal sai do caminho --"
cen_acquire_terminal 2026-08-01; eq "T1 acquire cercado e antigo pulam a janela terminal (e nao tomam o lease)" "$OUT" "[][]t"
cen_cron_pula_terminal; eq "T2 cron pula a terminal e segue para a proxima janela da conta" "$OUT" "01/01/2024"

echo "-- S/M: semear e rearmar --"
cen_semear_ignora_terminal; eq "S1 terminal nao trava semear; mesma janela -> ja_falhou" "$OUT" "semeada|ja_falhou"
R=$(P -q -tA 2>&1 <<SQL || true
SET test.uid='$CUST'; SET ROLE authenticated;
DO \$x\$ BEGIN
  PERFORM public.vendas_sync_semear_janela(DATE '2026-05-01', DATE '2026-05-31');
  RAISE NOTICE 'SEMEOU_SEM_GATE';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_SEMEAR_OK'; END \$x\$;
SQL
)
case "$R" in *GATE_SEMEAR_OK*) ok "S2 semear recriado mantem o gate (customer 42501)" ;; *) bad "S2 — veio: $R" ;; esac
R=$(P -q -tA 2>&1 <<SQL || true
SET test.uid='$STAFF'; SET ROLE authenticated;
DO \$x\$ BEGIN
  PERFORM public.vendas_sync_semear_janela(DATE '2026-05-01', ((now() AT TIME ZONE 'America/Sao_Paulo')::date + 1));
  RAISE EXCEPTION 'SABOTAGEM_ACEITOU_FUTURO';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'FUTURO_SP_BARROU'; WHEN OTHERS THEN RAISE; END \$x\$;
SQL
)
case "$R" in *FUTURO_SP_BARROU*) ok "S3 semear recusa date_to depois do dia de SP (22023)" ;; *) bad "S3 — veio: $R" ;; esac
cen_rearmar_customer 2026-09-01; eq "M1 customer nao rearma (42501), janela segue terminal" "$OUT" "barrou|false/true/pedidos_falhos/0/0/0/0/1"
R=$(como "$STAFF" "SELECT (public.vendas_sync_rearmar_janela($(J 2026-09-01)))->>'rearmada';")
eq "M2 staff rearma a terminal" "$R" "true"
eq "M2 rearmar zera o estado de falha e volta a pagina 1" "$(est 2026-09-01)" "false/false/-/0/0/0/0/null"
R=$(como "$STAFF" "SELECT (public.vendas_sync_rearmar_janela($(J 2026-02-01)))->>'motivo';")
eq "M3 rearmar janela NAO terminal e no-op" "$R" "nao_terminal"
eq "M3 a completa segue completa" "$(est 2026-02-01)" "true/false/-/0/0/0/0/null"
seed 2026-11-01 1   # a OUTRA janela em andamento na conta (aberta, não terminal)
R=$(como "$STAFF" "SELECT (public.vendas_sync_rearmar_janela($(J 2026-04-01)))->>'motivo';")
eq "M4 com OUTRA janela em andamento na conta, rearmar recusa" "$R" "ja_pendente_outra"
eq "M5 anon sem EXECUTE no rearmar" "$(Pq -c "SELECT has_function_privilege('anon','public.vendas_sync_rearmar_janela(text,date,date)','EXECUTE');")" "f"
P -q -c "DELETE FROM public.vendas_sync_cursor WHERE date_from='2026-11-01';" >/dev/null
cen_rearmar_nao_apaga 2026-09-15 781
eq "M6 (Codex P1) rearmar NAO apaga a pendencia: passada sem o pedido nao completa" "$OUT" "false/false/-/1/0/0/1/null"

echo "-- L: zumbi da edge velha (1o challenge, P1) --"
cen_zumbi_edge_velha 2026-10-01; eq "L1 finish/release ANTIGOS sem lease ativo nao rebobinam a pausa do cercado" "$OUT" "13/-"

echo "-- I/V: idempotencia + validadores --"
quieto "$MIG"; ok "I1 re-aplicar a migration (idempotente)"
V=$(Pq -f "$VALIDA");       case "$V" in "✅"*) ok "V1 validador da falha honesta aprova o banco bom" ;; *) bad "V1 — $V" ;; esac
V=$(Pq -f "$VALIDA_FENCE"); case "$V" in "✅"*) ok "V2 validador do fencing segue aprovando" ;; *) bad "V2 — $V" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: sabota UMA coisa → o assert alvo fica VERMELHO → restaura (re-aplica).
# ══════════════════════════════════════════════════════════════════════════════
echo "-- G: falsificacao --"
restaura() { quieto "$MIG"; }
reprova() { local v; v=$(Pq -f "$VALIDA"); case "$v" in *"$2"*) ok "$1" ;; *) bad "$1 — validador disse: $v" ;; esac; }
# reescreve uma função a partir do corpo VIVO trocando um trecho (todas as ocorrências); aborta se não casar
troca() {  # $1 assinatura  $2 trecho  $3 substituto
  P -q -v sig="$1" -v de="$2" -v para="$3" <<'SQL'
SELECT pg_get_functiondef(:'sig'::regprocedure) AS def \gset
SELECT position(:'de' in :'def') > 0 AS casou \gset
\if :casou
SELECT replace(:'def', :'de', :'para') AS nova \gset
SELECT :'nova' \gexec
\else
\echo TROCA_NAO_CASOU
\quit
\endif
SQL
}
FIN='public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)'

troca "$FIN" 'WHEN p_complete AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) = 0 THEN now()' \
             'WHEN p_complete AND jsonb_array_length(pedidos_falhos) = 0 THEN now()'
cen_cura_entre_passadas 2027-01-01 901
mordeu "G1 finish sem a poda nao ve a cura (a lista crua manda) — C4 tem dente" "$OUT" "true/false/-/1/0/0/0/null"
reprova "G1b validador reprova completude sem a poda" "sem a poda provada no banco"
restaura

troca "$FIN" 'tentativas_falha < 1' 'tentativas_falha < 99'
troca "$FIN" 'tentativas_falha >= 1' 'tentativas_falha >= 99'
cen_terminal_2a 2027-02-01 902
eq "G2 re-armar sem limite: a 2a passada NAO vira terminal — C3 tem dente (terminal=false)" "$(echo "$OUT" | cut -d/ -f2)" "false"
restaura

P -q -c "UPDATE cron.job SET command = replace(command, 'AND falhou_em IS NULL', '') WHERE jobname='vendas-sync-continuacao-6min';" >/dev/null
cen_cron_pula_terminal; mordeu "G3 cron sem o filtro dispara a terminal antiga — T2 tem dente" "$OUT" "01/01/2024"
reprova "G3b validador reprova o cron sem o filtro" "nao pula janela terminal (ou inativo)"
restaura

troca 'public.vendas_sync_lease_acquire_fenced(text,date,date)' 'AND falhou_em IS NULL' ''
cen_acquire_terminal 2027-03-01; mordeu "G4 acquire sem o filtro roda a janela terminal — T1 tem dente" "$OUT" "[][]t"
reprova "G4b validador reprova acquire sem o filtro" "acquire nao pula janela terminal"
restaura

troca 'public.vendas_sync_semear_janela(date,date,text[])' 'AND c.falhou_em IS NULL' ''
cen_semear_ignora_terminal; mordeu "G5 semear que conta a terminal como em andamento trava a conta — S1 tem dente" "$OUT" "semeada|ja_falhou"
reprova "G5b validador reprova o semear" "semear ainda conta janela terminal"
restaura

troca 'public.vendas_sync_rearmar_janela(text,date,date)' "RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';" 'NULL;'
cen_rearmar_customer 2027-04-01; mordeu "G6 rearmar sem gate deixa o customer mexer — M1 tem dente" "$OUT" "barrou|false/true/pedidos_falhos/0/0/0/0/1"
reprova "G6b validador reprova o gate decorativo (IF sem RAISE)" "sem o gate staff fail-closed"
restaura

troca 'public.vendas_sync_finish(text,date,date,boolean,integer,text)' 'AND running_since IS NOT NULL' ''
cen_zumbi_edge_velha 2027-05-01; mordeu "G7 finish antigo sem lease ativo: o zumbi rebobina — L1 tem dente" "$OUT" "13/-"
reprova "G7b validador reprova o finish antigo" "age sem lease ativo"
restaura

troca 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)' 'AND c.lease_token = p_lease_token' ''
cen_registrar_alheio 2027-06-01; mordeu "G8 registrar sem cerca aceita token alheio — R3 tem dente" "$OUT" "f|false/false/-/0/0/0/1/1"
reprova "G8b validador reprova registrar sem cerca" "sem o token do dono no UPDATE"
restaura

troca 'public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)' \
  'CASE WHEN p_page > COALESCE(next_page, 1) THEN 0 ELSE falhas_consecutivas END' 'falhas_consecutivas'
cen_progresso_zera 2027-07-01; mordeu "G9 heartbeat que nao zera ao avancar — E5 tem dente" "$OUT" "false/false/-/0/3/7/0/4|false/false/-/0/0/0/0/5"
reprova "G9b (Codex P7) validador reprova o heartbeat sem o reset" "nao zera as sequencias"
restaura

troca 'public.vendas_sync_rearmar_janela(text,date,date)' 'SET falhou_em = NULL, motivo_falha = NULL,' \
  "SET falhou_em = NULL, motivo_falha = NULL, pedidos_falhos = '[]'::jsonb,"
cen_rearmar_nao_apaga 2027-08-01 903; mordeu "G10 rearmar que apaga a lista completa sem o pedido — M6 tem dente" "$OUT" "false/false/-/1/0/0/1/null"
reprova "G10b validador reprova o rearmar que apaga" "rearmar apaga a pendencia"
restaura

troca 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)' \
  'private.vendas_sync_falhos_pendentes(c.account, ' 'coalesce('
cen_poda_curado 2027-09-01 904 905; mordeu "G11 registrar sem a poda guarda o curado — R5 tem dente" "$OUT" "905"
reprova "G11b validador reprova registrar sem poda" "registrar nao poda"
restaura

troca "$FIN" 'pausas_sem_progresso + 1 >= 20' 'pausas_sem_progresso + 1 >= 9999'
cen_transitorio_infinito 2027-10-01; mordeu "G12 sem o limite longo o transient re-tenta para sempre — E7 tem dente" "$OUT" "false/false/-/0/0/19/0/3|false/true/erro_persistente/0/0/20/0/3"
restaura

troca 'private.vendas_sync_falhos_pendentes(text,jsonb)' 'AND EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.sales_order_id = so.id)' ''
cen_reparo_falho 2027-12-01 907; mordeu "G13 poda sem exigir itens aceita o pai orfao — C7 tem dente" "$OUT" "false/false/-/1/0/0/1/null|true/false/-/1/0/0/0/null"
reprova "G13b validador reprova a poda sem itens" "pai sem itens como prova"
restaura

troca 'public.vendas_sync_lease_acquire_fenced(text,date,date)' \
  'pausas_sem_progresso = CASE WHEN running_since IS NOT NULL THEN pausas_sem_progresso + 1 ELSE pausas_sem_progresso END' \
  'pausas_sem_progresso = pausas_sem_progresso'
cen_morte_repetida 2027-12-05; mordeu "G14 roubo de lease morto sem contar: a janela nunca sai — E8 tem dente" "$OUT" "[lease]false/false/-/0/0/19/0/3|[]false/true/erro_persistente/0/0/20/0/3|true/true"
reprova "G14b validador reprova o acquire que nao conta" "roubar lease morto nao conta"
restaura

troca 'public.vendas_sync_finish(text,date,date,boolean,integer,text)' \
  'AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) = 0' ''
cen_finish_legado 2027-12-10 908; mordeu "G15 finish antigo sem a poda completa com pendencia — C8 tem dente" "$OUT" "false/false/-/1/0/0/1/null"
reprova "G15b validador reprova o finish antigo sem a poda" "finish antigo completa sem a poda"
restaura

troca "$FIN" 'pedidos_falhos = private.vendas_sync_falhos_pendentes(account, pedidos_falhos),' 'pedidos_falhos = pedidos_falhos,'
cen_pausa_poda 2027-12-15 909; mordeu "G16 pausa sem poda deixa o gravado como falha — C9 tem dente" "$OUT" "false/false/-/0/0/0/0/2"
restaura

V=$(Pq -f "$VALIDA"); case "$V" in "✅"*) ok "POS validador aprova depois de restaurar" ;; *) bad "POS restauracao incompleta: $V" ;; esac
cen_some_da_listagem 2027-11-01 906; eq "POS C5 volta ao comportamento real" "$OUT" "false/true/pedidos_falhos/1/0/0/1/null"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
