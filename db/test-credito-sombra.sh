#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# PROVA PG17 — crédito-IA PR 5: gate v2 em MODO SOMBRA (lote pg_cron + ledger + sensores).
# Migration sob prova: supabase/migrations/20261125200000_credito_gate_v2_sombra.sql (a MIGS5).
# Base = o que está em prod: PR 1 → PR 2 → PAGTO PARCIAL → PR 3 → fronteira 60 (migrations reais).
# Método: um banco-MODELO com a base; cada rodada = banco novo clonado do modelo + a MIGS5 (real ou
# sabotada) + a suíte inteira. Controle verde e sabotagens na MESMA invocação.
# Rode: bash db/test-credito-sombra.sh > /tmp/t.log 2>&1; echo $?
# Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-sombra.sh
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5476}"
SLUG="credito-sombra"
LOC="${LC_ALL_TESTE:-C}"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
SAB="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
export LC_ALL="$LOC" LANG="$LOC"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$SAB"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
echo "locale do banco: $LOC"
DB=modelo
PSQLB=("$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -v ON_ERROR_STOP=1)
P()  { "${PSQLB[@]}" -d "$DB" "$@"; }
Pq() { P -tA -q "$@"; }
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres modelo

MIGS5="$REPO_ROOT/supabase/migrations/20261125200000_credito_gate_v2_sombra.sql"

# ══ ZONA 1 — pré-requisitos (o que as migrations leem e não criam) ═══════════════════════════
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE ROLE sandbox_exec_teste BYPASSRLS;
GRANT USAGE ON SCHEMA public TO sandbox_exec_teste;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO sandbox_exec_teste;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO sandbox_exec_teste;

CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TYPE public.commercial_role AS ENUM
  ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $function$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT has_role(_uid, 'master'::app_role)
    OR (has_role(_uid, 'employee'::app_role)
        AND get_commercial_role(_uid) IN ('gerencial'::commercial_role,'estrategico'::commercial_role,'super_admin'::commercial_role));
$function$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_credito_escrever(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false); $function$;
REVOKE ALL ON FUNCTION private.cap_credito_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_credito_escrever(uuid) TO authenticated, service_role;

-- colunas que a sombra lê, com os tipos de prod (psql-ro 2026-11-25)
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text NOT NULL DEFAULT 'oben',
  status text NOT NULL DEFAULT 'importado', total numeric, items jsonb, customer_user_id uuid,
  omie_numero_pedido text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_condicao_pagamento_catalogo (empresa text NOT NULL, codigo text NOT NULL, descricao text,
  num_parcelas integer, dias_parcelas text, ativo boolean DEFAULT true, ultima_sincronizacao timestamptz, PRIMARY KEY (empresa, codigo));
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, omie_codigo_cliente bigint, saldo numeric, status_titulo text, data_vencimento date,
  numero_pedido text, valor_documento numeric, omie_codigo_lancamento bigint, updated_at timestamptz DEFAULT now());
CREATE TABLE public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','conflict')));
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account text NOT NULL, omie_codigo_cliente bigint);
CREATE TABLE public.sync_state (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL,
  account text, last_sync_at timestamptz);
-- pg_cron não roda no PG local: stub fiel ao contrato usado (schedule/unschedule/job)
-- (schema cron.job vem do stubs-supabase.sql; aqui só schedule/unschedule)
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS
$f$ INSERT INTO cron.job (jobid, jobname, schedule, command, active, username)   -- pg_cron grava o papel que agendou
    VALUES ((SELECT COALESCE(max(jobid), 0) + 1 FROM cron.job), p_jobname, p_schedule, p_command, true, current_user) RETURNING jobid $f$;
CREATE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS
$f$ DELETE FROM cron.job WHERE jobid = p_jobid RETURNING true $f$;
INSERT INTO public.omie_condicao_pagamento_catalogo(empresa, codigo, descricao, num_parcelas, ativo) VALUES
  ('OBEN','A28','Para 28 dias',1,true), ('OBEN','999','Informar o número de parcelas',999,true);
SQL

L=414a9727-ad1d-4998-914e-9c6ccf26cf50
G=33333333-3333-3333-3333-333333333333
V=44444444-4444-4444-4444-444444444444
C=c0000000-0000-0000-0000-000000000001
A1=a1000000-0000-0000-0000-000000000001
D=d0000000-0000-0000-0000-000000000001
E=e0000000-0000-0000-0000-000000000001
E2=e2000000-0000-0000-0000-000000000001
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$L'),('$G'),('$V') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES ('$L','master'),('$G','employee'),('$V','employee');
INSERT INTO public.commercial_roles VALUES ('$G','gerencial'),('$V','operacional');
-- grupo C: canônico C oben 101 + alias A1 ACTIVE colacor_sc 202 · D oben 501 · E colacor 601 (alias E2 CONFLICT)
INSERT INTO public.customer_canonical_alias VALUES ('$A1','$C','active'), ('$E2','$E','conflict');
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('$C','oben',101), ('$A1','colacor_sc',202), ('$D','oben',501), ('$E','colacor',601), ('$E2','colacor',602);
SQL

# ══ ZONA 2 — base de prod (migrations REAIS, na ordem em que foram aplicadas) ═════════════════
for m in 20260702233000_trava_credito_fase2 20260703140000_trava_credito_gate_excecao_por_par \
         20261121120000_trava_credito_piso_grupo 20261121160000_credito_limite_reserva_decisao \
         20261121200000_credito_piso_pagto_parcial 20261121180000_credito_prazo_revisao \
         20261124170000_credito_gate_fronteira_60_inclusiva; do
  P -q -1 -f "$REPO_ROOT/supabase/migrations/$m.sql" >/dev/null
done
P -q <<SQL
CREATE FUNCTION public.t_try(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END \$f\$;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO PUBLIC;
CREATE FUNCTION public.t_forca(p_sql text) RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS \$f\$
BEGIN EXECUTE p_sql; END \$f\$;
CREATE FUNCTION public.t_limite(p_grupo uuid, p_val numeric, p_prazo int, p_risco text)
RETURNS int LANGUAGE plpgsql VOLATILE AS \$f\$
DECLARE v_id uuid;
BEGIN
  v_id := public.credito_propor_limite(p_grupo, p_val, p_prazo, p_risco, 0.9, '{"k":1}'::jsonb, NULL, NULL,
            'teste', 'v1', now(), public.credito_grupo_assinatura(p_grupo),
            (SELECT versao FROM public.credito_limite WHERE grupo_user_id = p_grupo));
  PERFORM set_config('request.jwt.claims', '{"sub":"$L"}', true);
  RETURN (public.credito_aprovar_proposta(v_id, 'teste') ->> 'versao')::int;
END \$f\$;
SQL
# PV que existia ANTES da ativação (carga inicial aberta) e um faturado antigo (fora)
PVC=c0c0c0c0-0000-0000-0000-000000000001
PVF=f0f0f0f0-0000-0000-0000-000000000001
P -q -c "INSERT INTO public.sales_orders(id, account, status, total, items, customer_user_id, omie_numero_pedido, created_at) VALUES
  ('$PVC','oben','separacao',300,'[{\"quantidade\":1,\"valor_unitario\":300}]','$D','9001', now()-interval '3 days'),
  ('$PVF','oben','faturado',999,'[{\"quantidade\":1,\"valor_unitario\":999}]','$D','9002', now()-interval '40 days');"
echo "base de prod montada (7 migrations reais)"

# ══ ZONA 3 — helpers ═════════════════════════════════════════════════════════════════════════
PASS=0; FAIL=0; QUIETO=0
ok()  { PASS=$((PASS+1)); [ "$QUIETO" = 1 ] || echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); [ "$QUIETO" = 1 ] || echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
F() { Pq -c "SELECT public.t_forca(\$q\$$1\$q\$);" >/dev/null; }
# sync de CR: empresa idade_incremental idade_full (intervalos SQL; 'x' = sem linha)
sync() {
  F "DELETE FROM public.sync_state WHERE account = '$1'"
  [ "$2" = x ] || F "INSERT INTO public.sync_state(entity_type, account, last_sync_at) VALUES ('fin_cr_incremental_ok','$1', now() - interval '$2')"
  [ "$3" = x ] || F "INSERT INTO public.sync_state(entity_type, account, last_sync_at) VALUES ('fin_cr_full_ok','$1', now() - interval '$3')"
}
sync_frescos() { sync oben '2 hours' '1 day'; sync colacor '2 hours' '1 day'; sync colacor_sc '2 hours' '1 day'; }
# pv id account status total cliente numero [items]
pv() { local it; it='[{"quantidade":1,"valor_unitario":'"$4"'}]'; [ -n "${7:-}" ] && it="$7"
  F "INSERT INTO public.sales_orders(id, account, status, total, items, customer_user_id, omie_numero_pedido) VALUES ('$1','$2','$3',$4,'$it'::jsonb,'$5','$6')"; }
tit() { # company codigo saldo numero_pv valor_doc lancamento [dias_vencido] [status]
  F "INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento, numero_pedido, valor_documento, omie_codigo_lancamento) VALUES ('$1',$2,$3,'${8:-A VENCER}', (now() AT TIME ZONE 'America/Sao_Paulo')::date - (${7:--10}), NULLIF('$4',''), $5, $6)"; }
lote() { Pq -c "SELECT private.credito_sombra_lote(${1:-100}, 45);"; }
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
dec() { Pq -c "SELECT $2 FROM public.credito_sombra_pv_atual WHERE sales_order_id = '$1';"; }
nres() { Pq -c "SELECT count(*) FROM public.credito_sombra_reserva WHERE sales_order_id = '$1' AND status = '${2:-ativa}';"; }
limpa_dados() { F "DELETE FROM public.credito_sombra_reserva; DELETE FROM public.credito_sombra_decisao;
  DELETE FROM public.credito_sombra_tentativa; DELETE FROM public.credito_sombra_lote;
  DELETE FROM public.credito_limite; DELETE FROM public.credito_limite_proposta;
  DELETE FROM public.fin_contas_receber; DELETE FROM public.sales_orders WHERE id NOT IN ('$PVC','$PVF');
  DELETE FROM public.credito_operacao_revisao;
  UPDATE public.sales_orders SET status = 'cancelado' WHERE id = '$PVC'"; sync_frescos; }   # a carga já foi provada no S4c
como() { Pq -c "SELECT pg_catalog.set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);" \
            -c "SET ROLE authenticated;" -c "$2" | tail -1; }
comorole() { Pq -c "SET ROLE $1;" -c "SELECT public.t_try(\$q\$$2\$q\$);" | tail -1; }

u() { printf '%08x-0000-0000-0000-%012x' "$1" "$2"; }   # uuid de teste

# ══ ZONA 4 — a suíte (roda no banco $DB com a MIGS5 já aplicada) ═════════════════════════════
suite() {
  local a b x
  # ── S0 migration: marco, inventário, cron, gate efetivo intacto ──
  eq "S0.1 1 marco" "$(Pq -c 'SELECT count(*) FROM public.credito_sombra_marco')" "1"
  eq "S0.2 inventário: PV aberto pré-ativação = carga" "$(Pq -c "SELECT aberto FROM public.credito_sombra_carga WHERE sales_order_id='$PVC'")" "t"
  eq "S0.3 inventário: faturado antigo fora" "$(Pq -c "SELECT aberto FROM public.credito_sombra_carga WHERE sales_order_id='$PVF'")" "f"
  eq "S0.4 cron agendado 1×" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='credito-sombra-lote-10min'")" "1"
  sync_frescos
  # ── S4c carga inicial: o PV aberto é avaliado e marcado carga_inicial; o faturado antigo não ──
  lote >/dev/null
  eq "S4c.1 carga aberta avaliada e marcada" "$(dec "$PVC" carga_inicial)" "t"
  eq "S4c.2 faturado antigo não avaliado" "$(dec "$PVF" count\(\*\))" "0"
  eq "S4c.3 importado sem limite → amarelo/sem_limite" "$(dec "$PVC" "faixa||'/'||motivo")" "amarelo/sem_limite"
  eq "S4c.4 reserva sombra do PV real mesmo no amarelo" "$(nres "$PVC")" "1"
  eq "S4c.5 mesma versão não reavalia" "$(lote | J "d['avaliados']")" "0"

  # ── S1 frescor do sync (§9.5) ──
  limpa_dados
  Pq -c "SELECT public.t_limite('$C', 10000, 28, 'baixo');" >/dev/null
  a=$(u 1 1); pv "$a" oben importado 500 "$C" 1001
  lote >/dev/null
  eq "S1.1 importado, sync fresco, com limite → amarelo/prazo_ilegivel (prazo desconhecido nunca 🟢)" "$(dec "$a" "faixa||'/'||motivo")" "amarelo/prazo_ilegivel"
  eq "S1.2 … e sem prazo seria verde/dentro_limite (calibração)" "$(dec "$a" "faixa_sem_prazo||'/'||motivo_sem_prazo")" "verde/dentro_limite"
  limpa_dados; Pq -c "SELECT public.t_limite('$C', 10000, 28, 'baixo');" >/dev/null
  sync colacor_sc '30 hours' '1 day'
  a=$(u 1 2); pv "$a" oben importado 500 "$C" 1002
  lote >/dev/null
  eq "S1.3 UMA empresa irmã com incremental > 26 h → amarelo/sync_defasado" "$(dec "$a" "faixa||'/'||motivo")" "amarelo/sync_defasado"
  limpa_dados; Pq -c "SELECT public.t_limite('$C', 10000, 28, 'baixo');" >/dev/null
  sync colacor_sc x '1 day'
  a=$(u 1 3); pv "$a" oben importado 500 "$C" 1003
  lote >/dev/null
  eq "S1.4 incremental ausente (full fresco) → sync_defasado (ausente ≠ fresco)" "$(dec "$a" motivo)" "sync_defasado"
  limpa_dados; Pq -c "SELECT public.t_limite('$C', 10000, 28, 'baixo');" >/dev/null
  sync oben '2 hours' '9 days'
  a=$(u 1 4); pv "$a" oben importado 500 "$C" 1004
  lote >/dev/null
  eq "S1.5 full > 8 d com incremental fresco → sync_defasado" "$(dec "$a" motivo)" "sync_defasado"
  limpa_dados
  sync oben '-2 hours' '1 day'
  a=$(u 1 5); pv "$a" oben importado 500 "$D" 1005
  Pq -c "SELECT public.t_limite('$D', 10000, 28, 'baixo');" >/dev/null
  lote >/dev/null
  eq "S1.6 marca futura → sync_defasado" "$(dec "$a" motivo)" "sync_defasado"
  limpa_dados; sync oben '30 hours' '1 day'
  tit oben 101 400 '' 400 1 75 ATRASADO
  a=$(u 1 6); pv "$a" oben importado 500 "$C" 1006
  lote >/dev/null
  eq "S1.7 vencido > 60 d prevalece sobre sync defasado → vermelho" "$(dec "$a" "faixa||'/'||motivo")" "vermelho/piso_vencido_60d"

  # ── S2 título do próprio PV não soma 2× ──
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 1000, 28, 'baixo');" >/dev/null
  a=$(u 2 1); pv "$a" oben importado 800 "$D" 2001
  tit oben 501 800 2001 800 11
  lote >/dev/null
  eq "S2.1 título do próprio PV fora da soma → sem prazo seria verde" "$(dec "$a" motivo_sem_prazo)" "dentro_limite"
  eq "S2.2 exposição de títulos = 0 (o PV entra como valor)" "$(dec "$a" "exposicao_titulos_brl::int")" "0"
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 1000, 28, 'baixo');" >/dev/null
  a=$(u 2 2); b=$(u 2 3)
  pv "$a" oben importado 800 "$D" 2002; pv "$b" oben cancelado 5 "$D" 2002   # número repetido na empresa
  tit oben 501 800 2002 800 12
  lote >/dev/null
  eq "S2.3 número de PV ambíguo → título conta → estoura_limite" "$(dec "$a" motivo_sem_prazo)" "estoura_limite"

  # ── S3 conciliação reserva→título ──
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 100000, 28, 'baixo');" >/dev/null
  a=$(u 3 1); pv "$a" oben importado 100 "$D" 3001
  lote >/dev/null
  F "UPDATE public.sales_orders SET status='cancelado' WHERE id='$a'"
  lote >/dev/null
  eq "S3.1 cancelado no Omie → reserva liberada" "$(nres "$a" liberada)" "1"
  b=$(u 3 2); pv "$b" oben importado 100 "$D" 3002
  lote >/dev/null
  F "UPDATE public.sales_orders SET status='faturado' WHERE id='$b'"
  lote >/dev/null
  eq "S3.2 faturado SEM título → reserva continua ativa" "$(nres "$b")" "1"
  tit oben 501 60 3002 60 31
  lote >/dev/null
  eq "S3.3 título parcial (60 de 100) → reserva segue ativa" "$(nres "$b")" "1"
  x=$(u 3 9); pv "$x" oben importado 10 "$D" 3009
  lote >/dev/null
  eq "S3.4 o residual ocupa 40 (+ título 60 em aberto)" "$(dec "$x" "exposicao_reservas_brl::int||'+'||exposicao_titulos_brl::int")" "40+60"
  lote >/dev/null; lote >/dev/null
  x=$(u 3 8); pv "$x" oben importado 10 "$D" 3008
  lote >/dev/null
  eq "S3.5 2 lotes depois o residual ainda é 40 (nunca desconta o mesmo título 2×)" "$(dec "$x" "exposicao_reservas_brl::int")" "50"
  tit oben 501 40 3002 40 32
  lote >/dev/null
  eq "S3.6 títulos cobrem o compromisso → transferida" "$(nres "$b" transferida)" "1"
  c3=$(u 3 3); pv "$c3" oben importado 100 "$D" 3003
  lote >/dev/null
  F "UPDATE public.sales_orders SET deleted_at = now() WHERE id='$c3'"
  lote >/dev/null
  eq "S3.7 deleted_at do app NÃO libera (só cancelamento do Omie)" "$(nres "$c3")" "1"
  c3=$(u 3 4); pv "$c3" oben importado 100 "$D" 3004
  tit oben 501 100 3004 NULL 34
  F "UPDATE public.sales_orders SET status='faturado' WHERE id='$c3'"
  lote >/dev/null; lote >/dev/null
  eq "S3.8 título vinculado sem valor → mantém a cobertura (ativa)" "$(nres "$c3")" "1"

  # ── S4 lote: versões, app, erros, valor ilegível ──
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 100000, 28, 'baixo');" >/dev/null
  a=$(u 4 1); pv "$a" oben importado 100 "$D" 4001
  lote >/dev/null
  F "UPDATE public.sales_orders SET total = 150, items='[{\"quantidade\":1,\"valor_unitario\":150}]' WHERE id='$a'"
  lote >/dev/null
  eq "S4.1 conteúdo mudou → versão omie:2" "$(dec "$a" versao)" "omie:2"
  eq "S4.2 reserva anterior substituída, 1 ativa de 150" "$(nres "$a" substituida)/$(Pq -c "SELECT valor_brl::int FROM public.credito_sombra_reserva WHERE sales_order_id='$a' AND status='ativa'")" "1/150"
  F "UPDATE public.sales_orders SET total = 100, items='[{\"quantidade\":1,\"valor_unitario\":100}]' WHERE id='$a'"
  lote >/dev/null
  eq "S4.3 volta A→B→A também é versão nova (omie:3)" "$(dec "$a" versao)" "omie:3"
  b=$(u 4 2); pv "$b" oben importado 0 "$D" 4002
  pv "$(u 4 3)" oben importado 100 "$D" 4003 '[{"quantidade":1}]'
  lote >/dev/null
  eq "S4.4 total ≤ 0 → tentativa valor_ausente, sem decisão" "$(Pq -c "SELECT resultado FROM public.credito_sombra_tentativa WHERE sales_order_id='$b'")/$(dec "$b" "count(*)")" "valor_ausente/0"
  eq "S4.5 item sem preço → valor_parcial" "$(Pq -c "SELECT resultado FROM public.credito_sombra_tentativa WHERE sales_order_id='$(u 4 3)'")" "valor_parcial"
  eq "S4.6 valor ilegível não repete a cada lote" "$(lote >/dev/null; Pq -c "SELECT count(*) FROM public.credito_sombra_tentativa WHERE sales_order_id='$b'")" "1"
  # erro num PV não aborta o lote; 3 tentativas e para
  x=$(u 4 4); pv "$x" oben importado 100 "$D" 4004
  b=$(u 4 5); pv "$b" oben importado 100 "$D" 4005
  P -q -c "CREATE FUNCTION public.t_explode() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN
             IF NEW.sales_order_id = '$x' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END \$f\$;
           CREATE TRIGGER t_explode BEFORE INSERT ON public.credito_sombra_decisao FOR EACH ROW EXECUTE FUNCTION public.t_explode();"
  eq "S4.7 lote com 1 PV que explode termina ok" "$(lote | J "d['status']+'/'+str(d['erros'])")" "ok/1"
  eq "S4.8 o outro PV do mesmo lote foi avaliado" "$(dec "$b" "count(*)")" "1"
  eq "S4.9 erro vira tentativa com SQLSTATE" "$(Pq -c "SELECT left(detalhe,5) FROM public.credito_sombra_tentativa WHERE sales_order_id='$x' LIMIT 1")" "P0001"
  lote >/dev/null; lote >/dev/null; lote >/dev/null
  eq "S4.10 erro tenta 3× e para" "$(Pq -c "SELECT count(*) FROM public.credito_sombra_tentativa WHERE sales_order_id='$x'")" "3"
  P -q -c "DROP TRIGGER t_explode ON public.credito_sombra_decisao; DROP FUNCTION public.t_explode();"
  # app: revisão do PR 3 (valor e prazo do servidor, devedor congelado)
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 100000, 28, 'baixo');" >/dev/null
  a=$(u 4 6); pv "$a" oben enviado 999 "$D" 4006
  Pq -c "SELECT public.credito_registrar_revisao('$a','oben','criacao',501,'A28','informada','[{\"codigo_produto\":7,\"quantidade\":2,\"valor_unitario\":10}]'::jsonb,NULL);" >/dev/null
  lote >/dev/null
  eq "S4.11 app: origem app, valor e prazo da revisão" "$(dec "$a" "origem||'/'||valor_brl::int||'/'||prazo_dias")" "app/20/28"
  eq "S4.12 app com prazo legível e dentro do limite → verde/dentro_limite" "$(dec "$a" "faixa||'/'||motivo")" "verde/dentro_limite"
  b=$(u 4 9); pv "$b" oben importado 0 "$D" 4009
  a=$(u 4 10); pv "$a" oben enviado 999 "$D" 4010
  Pq -c "SELECT public.credito_registrar_revisao('$a','oben','criacao',501,'A28','informada','[{\"codigo_produto\":7,\"quantidade\":1,\"valor_unitario\":10}]'::jsonb,NULL);" >/dev/null
  lote >/dev/null
  eq "S4.12b irmão em trânsito com valor ilegível → exposicao_indeterminada (ausente ≠ zero)" "$(dec "$a" motivo)" "exposicao_indeterminada"
  # PV em trânsito do grupo sem reserva ainda → exposição indeterminada
  limpa_dados; Pq -c "SELECT public.t_limite('$D', 100000, 28, 'baixo');" >/dev/null
  a=$(u 4 7); b=$(u 4 8); pv "$a" oben importado 100 "$D" 4007; pv "$b" oben importado 100 "$D" 4008
  lote 1 >/dev/null
  eq "S4.13 irmão em trânsito ainda não medido → exposicao_indeterminada" "$(Pq -c "SELECT motivo_sem_prazo FROM public.credito_sombra_decisao ORDER BY avaliado_em LIMIT 1")" "exposicao_indeterminada"
  eq "S4.14 teto do lote deixa pendente para o próximo" "$(Pq -c "SELECT pendentes FROM public.credito_sombra_lote ORDER BY iniciado_em DESC LIMIT 1")" "1"

  # ── S5 o gate efetivo não é tocado ──
  eq "S5.1 nenhuma decisão/reserva/solicitação EFETIVA escrita pela sombra" \
     "$(Pq -c "SELECT (SELECT count(*) FROM public.credito_decisao_pedido)+(SELECT count(*) FROM public.credito_reserva)+(SELECT count(*) FROM public.credito_solicitacao)")" "0"
  eq "S5.2 corpo do núcleo e do piso = prod" "$(Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE oid IN ('private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'::regprocedure,'public.venda_gate_credito_grupo(uuid,text,bigint)'::regprocedure)")" "$CORPOS_PROD"
  eq "S5.3 CHECK de prazo: prazo NULL nunca verde" "$(Pq -c "SELECT count(*) FROM public.credito_sombra_decisao WHERE prazo_dias IS NULL AND faixa='verde'")" "0"

  # ── S6 ACL / RLS ──
  eq "S6.1 authenticated não roda o lote" "$(comorole authenticated 'SELECT private.credito_sombra_lote(1,1)')" "42501"
  eq "S6.2 service_role não roda o lote" "$(comorole service_role 'SELECT private.credito_sombra_lote(1,1)')" "42501"
  eq "S6.3 sandbox_exec não roda o avaliador" "$(comorole sandbox_exec_teste "SELECT private.credito_sombra_avaliar('$a','oben',501,1,1)")" "42501"
  eq "S6.4 service_role não escreve no ledger" "$(comorole service_role "INSERT INTO public.credito_sombra_lote(id) VALUES (gen_random_uuid())")" "42501"
  eq "S6.5 gestor lê as decisões" "$(como "$G" 'SELECT (count(*) > 0)::text FROM public.credito_sombra_pv_atual')" "true"
  eq "S6.6 vendedor lê 0" "$(como "$V" 'SELECT count(*) FROM public.credito_sombra_decisao')" "0"
  eq "S6.7 saúde: 0 lotes presos" "$(como "$G" 'SELECT lotes_presos FROM public.credito_sombra_saude')" "0"

  # ── S7 concorrência: lote em voo não segura o caminho do pedido ──
  local fifo="$SAB/fifo"; rm -f "$fifo"; mkfifo "$fifo"
  ( "${PSQLB[@]}" -d "$DB" -q < "$fifo" > "$SAB/sessaoA.log" 2>&1 ) &
  local pa=$!
  exec 3>"$fifo"
  echo "BEGIN; SELECT private.credito_sombra_lote(100,45); SELECT pg_sleep(4); COMMIT;" >&3
  sleep 1
  eq "S7.1 2º lote concorrente → ocupado (não empilha)" "$(lote | J "d['status']")" "ocupado"
  eq "S7.2 piso do pedido real responde com lote em voo (timeout 1 s)" \
     "$(Pq -c "SET statement_timeout = '1s'; SELECT (public.venda_gate_credito_grupo('$(u 9 9)','oben',501) ? 'bloqueado')::text;")" "true"
  eq "S7.3 núcleo efetivo do grupo não espera a sombra (timeout 1 s)" \
     "$(Pq -c "SET statement_timeout = '1s'; SELECT pg_advisory_xact_lock(hashtextextended('credito_grupo:' || '$D', 0)); SELECT 'livre';" | tail -1)" "livre"
  exec 3>&-; wait "$pa" || true
}

CORPOS_PROD=$(Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE oid IN ('private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'::regprocedure,'public.venda_gate_credito_grupo(uuid,text,bigint)'::regprocedure)")

# rodada: banco novo clonado do modelo + migration (real ou sabotada) + suíte
rodada() {   # $1 = arquivo da migration
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T modelo prove
  DB=prove
  P -q -1 -f "$1" > "$SAB/apl.log" 2>&1 || { echo "  (migration falhou: $(grep -v NOTICE "$SAB/apl.log" | head -c 900))"; return 1; }
  suite
}

echo "· controle (migration REAL)"
if rodada "$MIGS5"; then ok "A0 migration aplica com pós-condição"; else bad "A0 migration falhou"; fi
if P -q -f "$REPO_ROOT/db/medir-credito-sombra.sql" > "$SAB/medir.log" 2>&1 && ! grep -q ERROR "$SAB/medir.log"; then ok "M1 db/medir-credito-sombra.sql roda sobre o ledger"; else bad "M1 medição quebrou: $(grep ERROR "$SAB/medir.log" | head -c 300)"; fi
echo "· re-aplicar é idempotente (marco não move, cron não duplica)"
M0=$(Pq -c "SELECT ativado_em FROM public.credito_sombra_marco")
if P -q -1 -f "$MIGS5" >/dev/null 2>&1; then ok "A1 2ª aplicação passa"; else bad "A1 2ª aplicação falhou"; fi
eq "A2 marco intacto" "$(Pq -c "SELECT ativado_em FROM public.credito_sombra_marco")" "$M0"
eq "A3 1 cron" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='credito-sombra-lote-10min'")" "1"

# ══ ZONA 5 — falsificação: uma camada por vez, sempre depois do controle verde ═══════════════
[ "$FAIL" = 0 ] || { echo "controle vermelho: falsificação não roda"; echo "RESULTADO: $PASS ok / $FAIL fail"; exit 1; }
echo "· falsificação"
sabota() {   # $1 = rótulo · $2 = asserts que TÊM de ficar vermelhos (regex) · $3.. = trocas python
  local rot="$1" alvo="$2"; shift 2
  python3 - "$MIGS5" "$SAB/m.sql" "$@" <<'PY'
import sys
src, dst, *ops = sys.argv[1:]
t = open(src).read()
for op in ops:
    de, para = op.split('=>', 1)
    if de not in t: raise SystemExit('trecho não encontrado: ' + de)
    t = t.replace(de, para, 1)
open(dst, 'w').write(t)
PY
  local p0=$PASS f0=$FAIL out
  QUIETO=0; out=$(rodada "$SAB/m.sql" 2>&1 || true); PASS=$p0; FAIL=$f0
  if echo "$out" | grep -E "❌ ($alvo)" >/dev/null; then ok "$rot → vermelho em $(echo "$out" | grep -cE '❌') assert(s), incl. $alvo"
  else bad "$rot passou sem derrubar $alvo"; echo "$out" | grep -E "❌|falhou" | head -5; fi
}
sabota "F1 sem veto de sync" "S1\.3|S1\.4|S1\.5" \
  "  ELSIF NOT COALESCE((v_sync ->> 'ok')::boolean, false) THEN=>  ELSIF false THEN"
sabota "F2 full fresco basta (greatest)" "S1\.4" \
  "v_ok_c := v_n_inc = 1 AND v_n_full = 1=>v_ok_c := v_n_full = 1" \
  "AND v_inc <= now() + interval '5 minutes' AND v_inc > now() - interval '26 hours'=>"
sabota "F3 título do próprio PV soma" "S2\.1|S2\.2" \
  "  v_titulos := v_titulos - v_titulos_pv;=>"
sabota "F4 transfere sem título (faturado basta)" "S3\.2|S3\.3" \
  "AND private.credito_sombra_titulos_pv(r.company, r.omie_codigo_cliente, r.num) >= r.valor_brl THEN=>THEN"
sabota "F5 deleted_at libera" "S3\.7" \
  "    IF r.st = 'cancelado' THEN=>    IF r.st = 'cancelado' OR EXISTS (SELECT 1 FROM public.sales_orders z WHERE z.id = r.sales_order_id AND z.deleted_at IS NOT NULL) THEN"
sabota "F6 sem sub-bloco (1 erro aborta o lote)" "S4\.7|S4\.8" \
  "    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS=>    EXCEPTION WHEN division_by_zero THEN
      GET STACKED DIAGNOSTICS"
sabota "F7 residual gravado (desconta título 2×)" "S3\.5" \
  "SELECT COALESCE(sum(private.credito_sombra_residual(r.valor_brl, r.company, r.omie_codigo_cliente, r.sales_order_id)), 0)=>SELECT COALESCE(sum(greatest(private.credito_sombra_residual(r.valor_brl, r.company, r.omie_codigo_cliente, r.sales_order_id) - COALESCE(private.credito_sombra_titulos_pv(r.company, r.omie_codigo_cliente, (SELECT s.omie_numero_pedido FROM public.sales_orders s WHERE s.id = r.sales_order_id)),0), 0)), 0)"
# pós-condição pega o gate efetivo alterado (a sombra não pode mexer no núcleo)
python3 - "$MIGS5" "$SAB/m.sql" <<'PY'
import sys
t = open(sys.argv[1]).read()
i = t.index('-- ── 9. pós-condição')
t = t[:i] + "CREATE OR REPLACE FUNCTION public.venda_gate_credito_grupo(p_sales_order_id uuid, p_company text, p_codigo bigint) RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;\n" + t[i:]
open(sys.argv[2], 'w').write(t)
PY
"$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T modelo prove
DB=prove
if P -q -1 -f "$SAB/m.sql" > "$SAB/pos.log" 2>&1; then bad "F8 pós-condição não pegou o piso alterado"
elif grep -q "POSCONDICAO credito-sombra: gate efetivo alterado" "$SAB/pos.log"; then ok "F8 piso alterado na mesma transação → pós-condição aborta"
else bad "F8 outro erro: $(head -c 300 "$SAB/pos.log")"; fi
eq "F8b rollback: nada da sombra ficou" "$(Pq -c "SELECT to_regclass('public.credito_sombra_lote') IS NULL")" "t"

echo "── re-prova pós-falsificação (migration REAL) ──"
QUIETO=1; p0=$FAIL; rodada "$MIGS5" >/dev/null 2>&1 || true; QUIETO=0
if [ "$FAIL" = "$p0" ]; then ok "R re-prova verde"; else bad "R re-prova vermelha ($((FAIL-p0)))"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail (locale $LOC)"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "PROVA-CREDITO-SOMBRA-OK"
