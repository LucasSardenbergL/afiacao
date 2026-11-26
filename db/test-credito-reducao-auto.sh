#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# PROVA PG17 — crédito-IA fatia 5b: redução automática do limite vigente (só desce), writer único de
# credito_limite, trilha por linha de proposta, caminho de volta pela IA + Lucas, lote do cron.
# Migration sob prova: 20261126150000_credito_reducao_automatica.sql (a MIG5B).
# Base: arranque + zonas 1-2 copiados de db/test-credito-ia-avaliar.sh (prod = PR1 + PR2 + PAGTO
# PARCIAL + fronteira-60 + PR 4 aplicada de verdade).
# Rode: bash db/test-credito-reducao-auto.sh > /tmp/t.log 2>&1; echo $?
# Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-reducao-auto.sh
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"   # PGBIN portátil (Mac brew / CI apt)
PORT="${PGPORT_TEST:-5476}"
SLUG="credito-reducao-auto"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"


SAB="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
cleanup() { exec 3>&- 2>/dev/null || true; "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$SAB"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
PSQL=("$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1)
P()  { "${PSQL[@]}" "$@"; }
Pq() { P -tA -q "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"   # auth.uid() = request.jwt.claims (fiel à prod)
P -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
-- DEFAULT PRIVILEGE do Supabase: objeto novo em public NASCE ABERTO (database.md §4) —
-- sem isto o harness nasce fechado por acidente e os REVOKE não são testados.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
-- … e o papel do builder do Lovable (sandbox_exec_<ref>, BYPASSRLS): INSERT em tabela e EXECUTE em
-- função nova, medido em prod (pg_default_acl, psql-ro 2026-11-21) — P0 Codex diff.
CREATE ROLE sandbox_exec_teste BYPASSRLS;
GRANT USAGE ON SCHEMA public TO sandbox_exec_teste;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO sandbox_exec_teste;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO sandbox_exec_teste;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê mas não cria; helpers de role verbatim de prod)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
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

-- private.cap_credito_escrever: corpo de prod (md5 functiondef 4389a0b7…, psql-ro 2026-11-21)
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_credito_escrever(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;
REVOKE ALL ON FUNCTION private.cap_credito_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_credito_escrever(uuid) TO authenticated, service_role;

CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, omie_codigo_cliente bigint, saldo numeric, status_titulo text, data_vencimento date);
CREATE TABLE public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','conflict')));
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account text NOT NULL, omie_codigo_cliente bigint);
SQL

# usuários: Lucas (master + allowlist), M2 (master FORA da allowlist), G gestor, V vendedor, U customer
L=414a9727-ad1d-4998-914e-9c6ccf26cf50
M2=22222222-2222-2222-2222-222222222222
G=33333333-3333-3333-3333-333333333333
V=44444444-4444-4444-4444-444444444444
U=55555555-5555-5555-5555-555555555555
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$L'),('$M2'),('$G'),('$V'),('$U') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES ('$L','master'),('$M2','master'),('$G','employee'),('$V','employee'),('$U','customer');
INSERT INTO public.commercial_roles VALUES ('$G','gerencial'),('$V','operacional');
SQL

# ══════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (a prod antes da MIG5B; a MIG4 vem logo abaixo, depois das colunas que ela lê)
# ══════════════════════════════════════════════════════════════════
for m in 20260702233000_trava_credito_fase2 20260703140000_trava_credito_gate_excecao_por_par \
         20261121120000_trava_credito_piso_grupo 20261121160000_credito_limite_reserva_decisao \
         20261121200000_credito_piso_pagto_parcial 20261124170000_credito_gate_fronteira_60_inclusiva; do
  P -q -1 -f "$REPO_ROOT/supabase/migrations/$m.sql"
done
echo "base aplicada: PR1 + PR2 + pagto parcial + fronteira-60"

# o que a MIG4 lê e a base não cria (colunas/tabelas de prod, só as usadas; v_titulo_baixas vira tabela)
P -q <<'SQL'
ALTER TABLE public.fin_contas_receber
  ADD COLUMN omie_codigo_lancamento bigint, ADD COLUMN data_emissao date, ADD COLUMN valor_documento numeric,
  ADD COLUMN categoria_codigo text, ADD COLUMN ausente_omie_desde timestamptz,
  ADD COLUMN nome_cliente text, ADD COLUMN observacao text;
CREATE TABLE public.v_titulo_baixas (company text, omie_codigo_lancamento bigint, tipo text,
                                     data_baixa_final date, origem_baixa text);
CREATE TABLE public.sync_state (account text, entity_type text, last_sync_at timestamptz);
CREATE TABLE public.profiles (user_id uuid, name text, razao_social text, document text);
CREATE TABLE public.radar_ingest_state (mes_referencia text, status text, situacao_aplicada_em timestamptz,
                                        situacao_aplicada_fechamento timestamptz, finalizado_em timestamptz);
CREATE TABLE public.radar_situacao_cadastral (cnpj text, lote text, situacao text);
CREATE OR REPLACE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint
LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_nome;
  IF v IS NULL THEN
    v := COALESCE((SELECT max(jobid) FROM cron.job), 0) + 1;
    INSERT INTO cron.job(jobid, jobname, schedule, command, active) VALUES (v, p_nome, p_sched, p_cmd, true);
  ELSE
    UPDATE cron.job SET schedule = p_sched, command = p_cmd WHERE jobid = v;
  END IF;
  RETURN v;
END $f$;
SQL

P -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS
$f$ DELETE FROM cron.job WHERE jobid = p_jobid RETURNING true $f$;
SQL

# a PR 4 real (a prod de hoje), depois a MIG5B
P -q -1 -f "$REPO_ROOT/supabase/migrations/20261126090000_credito_ia_avaliar.sql"
echo "base aplicada: + PR 4 (credito_ia_avaliar)"

MIG5B="$REPO_ROOT/supabase/migrations/20261126150000_credito_reducao_automatica.sql"
QUIETO=0; PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); [ "$QUIETO" = 1 ] || echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); [ "$QUIETO" = 1 ] || echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# casa a MARCA do ramo (ASCII, caixa fixa, sem -i)
tem() { case "$2" in *"$3"*) ok "$1 ($3)";; *) bad "$1 — esperado conter [$3], veio [$2]";; esac; }

espelho() { python3 - "$MIG5B" "$SAB/m.sql" "$1" "$2" <<'PY'
import sys
src, dst, velho, novo = sys.argv[1:5]
t = open(src, encoding="utf-8").read()
n = t.count(velho)
if n != 1:
    sys.exit(f"espelho: '{velho[:60]}' aparece {n}x (precisa 1)")
open(dst, "w", encoding="utf-8").write(t.replace(velho, novo))
PY
}

# ── G: guarda de drift (ANTES da aplicação real; -1 = a transação inteira volta) ──
espelho "'331de37f80c02ad166a559c8ed7c77cb'" "'031de37f80c02ad166a559c8ed7c77cb'"
if P -q -1 -f "$SAB/m.sql" > "$SAB/g.log" 2>&1; then bad "G guarda não pegou drift"
else tem "G guarda aborta com corpo de prod divergente" "$(cat "$SAB/g.log")" "GUARDA credito-reducao-auto"; fi
eq "G nada ficou da tentativa abortada" "$(P -tA -q -c "SELECT to_regclass('public.credito_reducao_verificacao') IS NULL")" "t"

if P -q -1 -f "$MIG5B" > "$SAB/a.log" 2>&1; then ok "A0 migration aplica (guarda + objetos + pós-condição)"
else bad "A0 migration falhou: $(head -c 800 "$SAB/a.log")"; exit 1; fi
tem "A0 pós-condição positiva" "$(cat "$SAB/a.log")" "POSCONDICAO credito-reducao-auto OK"
echo "md5 5b: $(P -tA -q -c "SELECT string_agg(p.proname || '=' || md5(p.prosrc), ' ' ORDER BY p.proname) FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.credito_aprovar_proposta(uuid,text)'), to_regprocedure('private.credito_raizes_elegiveis()'), to_regprocedure('public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)'))")"
if P -q -1 -f "$MIG5B" > "$SAB/a2.log" 2>&1; then ok "A0b re-aplicação idempotente (guarda aceita o corpo 5b)"
else bad "A0b re-aplicar falhou: $(head -c 400 "$SAB/a2.log")"; fi

# ══════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + helpers (mesmo grupo C do PR 4: canônico oben 101 + alias A1 ACTIVE colacor_sc 202)
# ══════════════════════════════════════════════════════════════════
C=c0000000-0000-0000-0000-000000000001
A1=a1000000-0000-0000-0000-000000000001
F=f0000000-0000-0000-0000-000000000001
X=99999999-9999-9999-9999-999999999999
P -q <<SQL
INSERT INTO public.customer_canonical_alias VALUES ('$A1','$C','active');
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('$C','oben',101), ('$A1','colacor_sc',202), ('$F','oben',701);
INSERT INTO public.profiles VALUES ('$C','Cliente C','Razao C','12345678000190'), ('$F','Cliente F',NULL,'11222333000144');
INSERT INTO public.radar_ingest_state VALUES ('2026-10','complete',now(),'2026-11-01','2026-11-01');
INSERT INTO public.radar_situacao_cadastral VALUES ('12345678000190','2026-10','02'), ('11222333000144','2026-10','02');

CREATE FUNCTION public.t_forca(p_sql text) RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS \$f\$
BEGIN EXECUTE p_sql; END \$f\$;
CREATE FUNCTION public.t_trym(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ':' || SQLERRM; END \$f\$;
GRANT EXECUTE ON FUNCTION public.t_trym(text) TO PUBLIC;
CREATE FUNCTION public.t_registra(p_tok uuid, p_raiz uuid, p_lim numeric, p_prazo int, p_risco text,
                                  p_ficha jsonb DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS \$f\$
BEGIN
  RETURN public.credito_registrar_avaliacao(p_tok, p_raiz, jsonb_build_object(
    'ficha', COALESCE(p_ficha, public.credito_ficha(p_raiz)), 'limite_brl', p_lim, 'prazo_max_dias', p_prazo,
    'risco', p_risco, 'confianca', 0.8, 'saida_ia', '{}'::jsonb, 'travas', '[]'::jsonb,
    'modelo', 'teste', 'versao_politica', 'v1'));
END \$f\$;
CREATE FUNCTION public.t_claim(p_n int, p_tok uuid) RETURNS text LANGUAGE sql AS \$f\$
  SELECT COALESCE(string_agg(r::text, ',' ORDER BY r), '') FROM public.credito_reivindicar_raizes(p_n, p_tok, 300) r \$f\$;
-- proposta de redução forjada (fora do redutor) + writer NA MESMA transação → OK | SQLSTATE:msg
CREATE FUNCTION public.t_auto(p_raiz uuid, p_lim numeric, p_prazo int, p_risco text, p_base int,
                              p_decidido timestamptz DEFAULT now(), p_versao int DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS \$f\$
DECLARE v uuid := gen_random_uuid();
BEGIN
  PERFORM public.t_forca(format(\$i\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura,
    limite_versao_base, limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_em,
    motivo_decisao) VALUES (%L, %L, 'x', %s, %s, %s, %L, '{}'::jsonb, now(), 'aplicada_auto_reducao', %L, 'forjada')\$i\$,
    v, p_raiz, COALESCE(p_base::text, 'NULL'), p_lim, p_prazo, p_risco, p_decidido));
  RETURN public.t_trym(format('SELECT private.credito_limite_gravar(%L, NULL, %s)', v, COALESCE(COALESCE(p_versao, p_base)::text, 'NULL')));
END \$f\$;
SQL

T1=11111111-0000-0000-0000-000000000001
T2=11111111-0000-0000-0000-000000000002
HOJE="((now() AT TIME ZONE 'America/Sao_Paulo')::date)"
q()  { P -tA -q -c "$1"; }
JX() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
reset() { q "SELECT public.t_forca(\$q\$
  DELETE FROM public.credito_limite; DELETE FROM public.credito_limite_proposta; DELETE FROM public.credito_avaliacao;
  DELETE FROM public.credito_reducao_verificacao; DELETE FROM public.credito_reserva; DELETE FROM public.credito_decisao_pedido;
  DELETE FROM public.fin_contas_receber; DELETE FROM public.v_titulo_baixas; DELETE FROM public.sync_state;
  DELETE FROM public.omie_customer_account_map WHERE user_id = '$X' OR (user_id = '$C' AND account <> 'oben')
     OR user_id::text LIKE 'eeeeeeee-%';
  UPDATE public.radar_situacao_cadastral SET situacao = '02';
  INSERT INTO public.sync_state VALUES ('oben','fin_cr_incremental_ok',now()-interval '1 hour'),
    ('colacor','fin_cr_incremental_ok',now()-interval '1 hour'), ('colacor_sc','fin_cr_incremental_ok',now()-interval '1 hour');
\$q\$)" >/dev/null; }
# título: co cod lanc status emis_dias(N=null) venc_dias(neg=futuro) valor saldo(N=null) [cat]
tit() { local e="$HOJE - $5" s="$8"; [ "$5" = N ] && e=NULL; [ "$8" = N ] && s=NULL
  q "SELECT public.t_forca(\$q\$INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente,
    omie_codigo_lancamento, status_titulo, data_emissao, data_vencimento, valor_documento, saldo, categoria_codigo)
    VALUES ('$1',$2,$3,'$4',$e,$HOJE - ($6),$7,$s,'${9:-1.01.03}')\$q\$)" >/dev/null; }
baixa() { q "SELECT public.t_forca(\$q\$INSERT INTO public.v_titulo_baixas VALUES ('$1',$2,'CR',$HOJE - $3,'titulo')\$q\$)" >/dev/null; }
paga() { q "SELECT public.t_forca(\$q\$UPDATE public.fin_contas_receber SET status_titulo = 'RECEBIDO', saldo = 0 WHERE omie_codigo_lancamento = $1\$q\$)" >/dev/null; }
hist() { local i; for i in 1 2 3 4 5 6; do tit "$1" "$2" $(($3+i)) RECEBIDO 30 10 1000 0; baixa "$1" $(($3+i)) 8; done; }
lucas() { P -tA -q -c "SELECT set_config('request.jwt.claims', '{\"sub\":\"$L\"}', false);" -c "$1" | tail -1; }
como() { P -tA -q -c "SELECT pg_catalog.set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);" \
            -c "SET ROLE authenticated;" -c "SELECT public.t_trym(\$q\$$2\$q\$);" | tail -1; }
comorole() { P -tA -q -c "SET ROLE $1;" -c "SELECT public.t_trym(\$q\$$2\$q\$);" | tail -1; }
# C com histórico: 6 pagas na oben + 1 em aberto na colacor_sc (R$ 600) ⇒ teto 3.300 / 21 d
base_c() { reset; hist oben 101 0; tit colacor_sc 202 7 'A VENCER' 5 -25 600 600 1.01.02; }
# vigente de C aprovado pelo Lucas pelo caminho REAL (claim → registro → aprovação); $1 limite, $2 prazo, $3 risco
vig_c() { base_c; q "SELECT public.t_claim(5, '$T1');" >/dev/null
  local pid; pid=$(q "SELECT public.t_registra('$T1', '$C', ${1:-3300}, ${2:-21}, '${3:-baixo}');")
  lucas "SELECT public.credito_aprovar_proposta('$pid')" >/dev/null
  # a ficha aprovada envelhece $4 dias (a base do E2); sem trigger (replica) — só a data
  [ -n "${4:-}" ] && q "SELECT public.t_forca(\$q\$UPDATE public.credito_limite SET ficha_calculada_em = now() - interval '${4} days'\$q\$)" >/dev/null
  return 0; }
red() { q "SELECT private.credito_reduzir_limite('$1')"; }
vg()  { q "SELECT limite_brl::bigint || '/' || prazo_max_dias || '/' || risco || '/v' || versao FROM public.credito_limite WHERE grupo_user_id = '$1'"; }

# ══════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (cada check reseta o próprio estado: re-executável na falsificação)
# ══════════════════════════════════════════════════════════════════
check_sem_vigente() {
  reset
  eq "N1 sem vigente ⇒ inerte" "$(red $C | JX "d['resultado']")" "sem_vigente"
  eq "N1 lote sem vigente não acha raiz (a prod de hoje)" "$(q "SELECT private.credito_reducao_lote(25, 20) ->> 'raizes'")" "0"
  eq "N1 nada gravado" "$(q "SELECT count(*) FROM public.credito_limite_proposta WHERE status = 'aplicada_auto_reducao'")" "0"
}
check_sem_mudanca() {
  vig_c
  eq "N2 grupo saudável ⇒ sem mudança" "$(red $C | JX "d['resultado']")" "sem_mudanca"
  eq "N2 vigente intacto (v1)" "$(vg $C)" "3300/21/baixo/v1"
}
check_regressao_pr4() {
  vig_c
  eq "N3 aprovação do Lucas grava pelo writer (v1, aprovado_por, origem aprovada)" \
     "$(q "SELECT l.versao || '/' || (l.aprovado_por = '$L') || '/' || p.status FROM public.credito_limite l JOIN public.credito_limite_proposta p ON p.id = l.origem_proposta_id WHERE l.grupo_user_id = '$C'")" "1/true/aprovada"
  q "SELECT public.t_forca(\$q\$UPDATE public.credito_avaliacao SET ultima_proposta_em = now() - interval '8 days' WHERE raiz = '$C'\$q\$)" >/dev/null
  eq "N3 vigente aprovado e íntegro continua fora do laço (R7 do PR 4)" "$(q "SELECT public.t_claim(5, '$T2');")" ""
  q "SELECT public.t_forca(\$q\$UPDATE public.credito_avaliacao SET token = '$T2', reivindicada_ate = now() + interval '5 minutes' WHERE raiz = '$C'\$q\$)" >/dev/null
  tem "N3 registrar recusa vigente NÃO revisável (R8 do PR 4)" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.t_registra('$T2', '$C', 3300, 21, 'baixo')\$x\$);")" "grupo_com_limite_vigente"
}
check_piso() {
  vig_c; local fce; fce=$(q "SELECT ficha_calculada_em FROM public.credito_limite WHERE grupo_user_id = '$C'")
  tit oben 101 60 ATRASADO 90 60 100 100
  local r; r=$(red $C)
  eq "E1 piso comprovado ⇒ reduzido" "$(echo "$r" | JX "d['resultado']")" "reduzido"
  eq "E1 vigente 0 / 0 / alto, versão +1" "$(vg $C)" "0/0/alto/v2"
  eq "E1 preserva assinatura, ficha_calculada_em e aprovado_por do vigente" \
     "$(q "SELECT (l.grupo_assinatura = public.credito_grupo_assinatura('$C')) || '/' || (l.ficha_calculada_em = '$fce'::timestamptz) || '/' || (l.aprovado_por = '$L') FROM public.credito_limite l WHERE l.grupo_user_id = '$C'")" "true/true/true"
  eq "E1 trilha: proposta aplicada_auto_reducao é a origem, base = v1, motivo e regra" \
     "$(q "SELECT p.status || '|' || p.limite_versao_base || '|' || p.motivo_decisao || '|' || (p.travas -> 0 ->> 'regra') || '|' || (p.decidido_por IS NULL) FROM public.credito_limite l JOIN public.credito_limite_proposta p ON p.id = l.origem_proposta_id WHERE l.grupo_user_id = '$C'")" \
     "aplicada_auto_reducao|1|reducao_automatica: E1_piso_comprovado|E1_piso_comprovado|true"
  eq "E1 2ª passada não reduz de novo (já está no piso)" "$(red $C | JX "d['resultado']")" "sem_mudanca"
}
check_piso_indet() {
  vig_c; tit oben 101 61 'A VENCER' 3 -20 400 N
  local r; r=$(red $C)
  eq "D1 saldo NULL (piso indeterminado) ⇒ NÃO corta (ausente ≠ fato)" "$(echo "$r" | JX "d['resultado']")" "sem_mudanca"
  tem "D1 motivo registrado" "$(echo "$r" | JX "d['avisos']")" "piso_indeterminado"
  eq "D1 vigente intacto" "$(vg $C)" "3300/21/baixo/v1"
}
check_e2() {
  vig_c 3300 21 baixo 10
  tit oben 101 62 ATRASADO 40 16 1000 1000          # cruzou 15 d DEPOIS da ficha (base = hoje − 10)
  eq "E2 vencido novo ⇒ limite = títulos abertos (600 + 1.000)" "$(red $C | JX "d['resultado']")/$(vg $C)" "reduzido/1600/21/baixo/v2"
  paga 7
  eq "E2 2ª passada: outro título pago com o causador aberto ⇒ desce de novo (1.000)" "$(red $C | JX "d['resultado']")/$(vg $C)" "reduzido/1000/21/baixo/v3"
  paga 62
  eq "E2 causador pago ⇒ fica onde está (nunca sobe sozinho)" "$(red $C | JX "d['resultado']")/$(vg $C)" "sem_mudanca/1000/21/baixo/v3"
}
check_e2_antigo() {
  vig_c 3300 21 baixo 10
  tit oben 101 63 ATRASADO 60 30 1000 1000          # já tinha 20 d de atraso quando o Lucas aprovou
  eq "E2b vencido que o Lucas já viu na aprovação não corta" "$(red $C | JX "d['resultado']")/$(vg $C)" "sem_mudanca/3300/21/baixo/v1"
}
check_e2_fronteira() {
  vig_c 3300 21 baixo 10
  tit oben 101 64 ATRASADO 40 14 1000 1000
  eq "E2c 14 d de atraso: ainda não" "$(red $C | JX "d['resultado']")" "sem_mudanca"
  q "SELECT public.t_forca(\$q\$UPDATE public.fin_contas_receber SET data_vencimento = $HOJE - 15 WHERE omie_codigo_lancamento = 64\$q\$)" >/dev/null
  eq "E2c 15 d de atraso (régua ≥ 15 d da aprovação) ⇒ corta" "$(red $C | JX "d['resultado']")" "reduzido"
}
check_e2_reservas() {
  vig_c 3300 21 baixo 10
  q "SELECT public.t_forca(\$q\$
    INSERT INTO public.credito_decisao_pedido (id, sales_order_id, company, omie_codigo_cliente, modo, grupo_user_id, revisao, valor_brl, faixa, motivo, piso)
    VALUES ('dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 'oben', 101, 'efetivo', '$C', 'r1', 500, 'verde', 'dentro_limite', '{}'),
           ('dddddddd-0000-0000-0000-000000000002', gen_random_uuid(), 'oben', 101, 'sombra', '$C', 'r1', 9999, 'verde', 'dentro_limite', '{}');
    INSERT INTO public.credito_reserva (id, decisao_id, sales_order_id, company, omie_codigo_cliente, modo, grupo_user_id, revisao, valor_brl)
    SELECT gen_random_uuid(), d.id, d.sales_order_id, 'oben', 101, d.modo, '$C', 'r1', d.valor_brl FROM public.credito_decisao_pedido d;
  \$q\$)" >/dev/null
  tit oben 101 65 ATRASADO 40 16 1000 1000
  eq "E2d exposição = títulos (1.600) + reserva EFETIVA (500); a sombra (9.999) fica fora" "$(red $C >/dev/null; vg $C)" "2100/21/baixo/v2"
}
check_e2_exposicao_null() {
  vig_c 3300 21 baixo 10
  tit oben 101 66 ATRASADO 40 16 1000 1000
  tit oben 101 67 'A VENCER' 3 -20 400 N
  local r; r=$(red $C)
  eq "E2e exposição NULL ⇒ não fabrica corte" "$(echo "$r" | JX "d['resultado']")/$(vg $C)" "sem_mudanca/3300/21/baixo/v1"
  tem "E2e motivo registrado" "$(echo "$r" | JX "d['avisos']")" "exposicao_indeterminada"
}
check_nunca_aumenta() {
  vig_c 1000 21 baixo 10
  tit oben 101 68 ATRASADO 40 16 1000 1000          # exposição 1.600 > vigente 1.000
  eq "M1 'nada novo' acima do vigente ⇒ não sobe" "$(red $C | JX "d['resultado']")/$(vg $C)" "sem_mudanca/1000/21/baixo/v1"
}
check_e3() {
  vig_c
  q "SELECT public.t_forca(\$q\$UPDATE public.radar_situacao_cadastral SET situacao = '08' WHERE cnpj = '12345678000190'\$q\$)" >/dev/null
  eq "E3 cadastro irregular ⇒ risco alto, limite intacto" "$(red $C | JX "d['resultado']")/$(vg $C)" "reduzido/3300/21/alto/v2"
}
check_grupo_mudou() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100
  q "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$X','oben',101);" >/dev/null
  eq "I1 titularidade de um par mudou ⇒ não corta pela ficha de outro grupo" "$(red $C | JX "d['resultado']")/$(vg $C)" "grupo_mudou/3300/21/baixo/v1"
  q "DELETE FROM public.omie_customer_account_map WHERE user_id = '$X';" >/dev/null
  q "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$C','colacor',303);" >/dev/null
  eq "I2 composição mudou (assinatura) ⇒ não corta" "$(red $C | JX "d['resultado']")" "grupo_mudou"
  eq "I2 composição mudou ⇒ vigente vira revisável e entra no laço" "$(q "SELECT public.t_claim(5, '$T2');")" "$C"
}
check_recuperacao() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100; red $C >/dev/null
  eq "V1 após a redução o vigente é revisável e entra no laço" "$(q "SELECT public.t_claim(5, '$T2');")" "$C"
  paga 60
  local pid; pid=$(q "SELECT public.t_registra('$T2', '$C', 3300, 21, 'baixo');")
  eq "V1 a IA re-propõe sobre a versão vigente (base v2)" "$(q "SELECT status || '/' || limite_versao_base FROM public.credito_limite_proposta WHERE id = '$pid'")" "pendente/2"
  lucas "SELECT public.credito_aprovar_proposta('$pid')" >/dev/null
  eq "V1 só o clique do Lucas sobe de volta (v3, origem aprovada)" \
     "$(vg $C)/$(q "SELECT p.status FROM public.credito_limite l JOIN public.credito_limite_proposta p ON p.id = l.origem_proposta_id WHERE l.grupo_user_id = '$C'")" "3300/21/baixo/v3/aprovada"
  q "SELECT public.t_forca(\$q\$UPDATE public.credito_avaliacao SET ultima_proposta_em = now() - interval '8 days' WHERE raiz = '$C'\$q\$)" >/dev/null
  eq "V1 de volta a aprovado e íntegro ⇒ sai do laço" "$(q "SELECT public.t_claim(5, gen_random_uuid());")" ""
}
check_registro_base() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100; red $C >/dev/null
  q "SELECT public.t_claim(5, '$T2');" >/dev/null
  tem "V2 ficha calculada sobre a versão ANTERIOR (base v1) não vira proposta de vigente" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.t_registra('$T2', '$C', 0, 0, 'alto', public.credito_ficha('$C') || '{\"limite_versao_base\":1}'::jsonb)\$x\$);")" "grupo_com_limite_vigente"
}
check_aprovar_antiga() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100; red $C >/dev/null
  local pid=eeee0000-0000-0000-0000-000000000001
  q "SELECT public.t_forca(\$q\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_versao_base,
     limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em) SELECT '$pid', '$C', public.credito_grupo_assinatura('$C'), 1,
     3300, 21, 'baixo', public.credito_ficha('$C') || '{\"n_titulos_vencidos_15d\":9}'::jsonb, now()\$q\$)" >/dev/null
  tem "V3 pendente sobre a versão anterior à redução não desfaz o corte" \
      "$(lucas "SELECT public.t_trym(\$x\$SELECT public.credito_aprovar_proposta('$pid')\$x\$)")" "proposta_desatualizada"
  eq "V3 vigente continua reduzido" "$(vg $C)" "0/0/alto/v2"
}
check_writer() {
  vig_c
  tem "W1 redução que AUMENTA o limite" "$(q "SELECT public.t_auto('$C', 9900, 21, 'baixo', 1)")" "P0001:credito_limite_gravar: reducao_aumentaria"
  vig_c 3300 21 medio
  tem "W1b risco medio → baixo é melhora" "$(q "SELECT public.t_auto('$C', 3300, 21, 'baixo', 1)")" "reducao_aumentaria"
  tem "W2 redução idêntica (só versão +1)" "$(q "SELECT public.t_auto('$C', 3300, 21, 'medio', 1)")" "P0001:credito_limite_gravar: reducao_sem_piora"
  tem "W3 versão-base divergente" "$(q "SELECT public.t_auto('$C', 100, 21, 'medio', 7, now(), 1)")" "P0001:credito_limite_gravar: versao_divergente"
  tem "W4 linha de redução de OUTRA transação" "$(q "SELECT public.t_auto('$C', 100, 21, 'medio', 1, now() - interval '1 minute')")" "P0001:credito_limite_gravar: reducao_de_outra_transacao"
  eq "W  vigente intacto depois das 4 recusas" "$(vg $C)" "3300/21/medio/v1"
  reset; hist oben 701 100
  tem "W5 redução sem vigente" "$(q "SELECT public.t_auto('$F', 0, 0, 'alto', NULL)")" "reducao_sem_vigente"
}
check_trigger() {
  vig_c
  tem "T1 UPDATE com portão sem casar com a proposta (sobe o limite)" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.credito_portao('$C'); UPDATE public.credito_limite SET limite_brl = 99999 WHERE grupo_user_id = '$C'\$x\$)")" "42501:credito_limite: linha não casa"
  local aid=eeee0000-0000-0000-0000-000000000002
  q "SELECT public.t_forca(\$q\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_versao_base,
     limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_em, motivo_decisao)
     VALUES ('$aid', '$C', 'x', 1, 9999, 21, 'baixo', '{}', now(), 'aplicada_auto_reducao', now(), 'forjada')\$q\$)" >/dev/null
  tem "T2 origem de redução com valor MAIOR (writer contornado) barrada pelo trigger" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.credito_portao('$C'); UPDATE public.credito_limite SET limite_brl = 9999, versao = 2, origem_proposta_id = '$aid' WHERE grupo_user_id = '$C'\$x\$)")" "42501:credito_limite: redução automática só desce"
  q "SELECT public.t_forca(\$q\$UPDATE public.credito_limite_proposta SET limite_sugerido_brl = 100 WHERE id = '$aid'\$q\$)" >/dev/null
  tem "T3 redução que troca ficha_calculada_em (lavaria limite_desatualizado)" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.credito_portao('$C'); UPDATE public.credito_limite SET limite_brl = 100, versao = 2, origem_proposta_id = '$aid', ficha_calculada_em = now() + interval '1 day' WHERE grupo_user_id = '$C'\$x\$)")" "redução automática só desce"
  tem "T4 INSERT de vigente com origem de redução" \
      "$(q "SELECT public.t_trym(\$x\$SELECT public.credito_portao('$F'); INSERT INTO public.credito_limite (grupo_user_id, limite_brl, prazo_max_dias, risco, versao, grupo_assinatura, ficha_calculada_em, origem_proposta_id, aprovado_por) VALUES ('$F', 100, 21, 'baixo', 1, 'x', now(), '$aid', '$L')\$x\$)")" "42501:credito_limite: linha não casa"
  eq "T  vigente intacto" "$(vg $C)" "3300/21/baixo/v1"
}
check_dml_direto() {
  vig_c
  tem "T5 DML sem portão (SQL na mão) segue barrado pela guarda do PR 2" \
      "$(q "SELECT public.t_trym(\$x\$UPDATE public.credito_limite SET limite_brl = 0 WHERE grupo_user_id = '$C'\$x\$)")" "42501"
}
check_lote() {
  reset; hist oben 101 0; hist oben 701 100
  local i u
  for i in $(seq 1 30); do
    u=$(printf 'eeeeeeee-0000-0000-0000-%012d' "$i")
    q "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$u','oben',$((5000+i)));" >/dev/null
    q "SELECT public.t_forca(\$q\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_versao_base,
       limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_por, decidido_em)
       VALUES ('$u', '$u', public.credito_grupo_assinatura('$u'), NULL, 100, 7, 'medio', '{}', now(), 'aprovada', '$L', now());
       INSERT INTO public.credito_limite VALUES ('$u', 100, 7, 'medio', 1, public.credito_grupo_assinatura('$u'), now(), '$u', '$L', now())\$q\$)" >/dev/null
  done
  eq "L1 1º lote: 25 raízes" "$(q "SELECT private.credito_reducao_lote(25, 20) ->> 'raizes'")" "25"
  eq "L1 2º lote: as 5 que faltavam vêm primeiro (nenhuma fica para trás)" \
     "$(q "SELECT private.credito_reducao_lote(5, 20) ->> 'raizes'"; q "SELECT count(*) FROM public.credito_reducao_verificacao")" "5
30"
}
check_lote_erro() {
  vig_c; local SP=eeeeeeee-0000-0000-0000-999999999999
  q "SELECT public.t_forca(\$q\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_versao_base,
     limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_por, decidido_em)
     VALUES ('$SP', '$SP', public.credito_grupo_assinatura('$SP'), NULL, 100, 7, 'medio', '{}', now(), 'aprovada', '$L', now());
     INSERT INTO public.credito_limite VALUES ('$SP', 100, 7, 'medio', 1, public.credito_grupo_assinatura('$SP'), now(), '$SP', '$L', now())\$q\$)" >/dev/null
  tit oben 101 60 ATRASADO 90 60 100 100
  q "SELECT private.credito_reducao_lote(25, 20)" >/dev/null
  eq "L2 raiz que falha (ficha: grupo sem par) fica registrada como erro, a outra é reduzida no mesmo lote" \
     "$(q "SELECT string_agg(resultado, ',' ORDER BY resultado) FROM public.credito_reducao_verificacao")/$(vg $C)" "erro,reduzido/0/0/alto/v2"
}
# 2 sessões: A segura o lock do grupo C; o lote em B não espera (lock_timeout) e segue para F
check_ocupado() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100
  hist oben 701 100
  q "SELECT public.t_forca(\$q\$INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_versao_base,
     limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_por, decidido_em)
     VALUES ('$F', '$F', public.credito_grupo_assinatura('$F'), NULL, 100, 7, 'medio', '{}', now(), 'aprovada', '$L', now());
     INSERT INTO public.credito_limite VALUES ('$F', 100, 7, 'medio', 1, public.credito_grupo_assinatura('$F'), now(), '$F', '$L', now())\$q\$)" >/dev/null
  tit oben 701 160 ATRASADO 90 60 100 100
  rm -f "$SAB"/a.out "$SAB"/a.fifo; mkfifo "$SAB/a.fifo"
  "${PSQL[@]}" -tA -q < "$SAB/a.fifo" > "$SAB/a.out" 2>&1 &
  local apsql=$!
  exec 3>"$SAB/a.fifo"
  echo "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('credito_grupo:$C', 0)); SELECT 'A:lock';" >&3
  local i=0; until grep -q '^A:lock' "$SAB/a.out" 2>/dev/null; do i=$((i+1)); [ $i -gt 200 ] && break; sleep 0.05; done
  local t0 t1; t0=$(date +%s)
  q "SELECT private.credito_reducao_lote(25, 20)" >/dev/null
  t1=$(date +%s)
  echo "COMMIT;" >&3; exec 3>&-; wait "$apsql" || true
  eq "C1 grupo ocupado: o lote não espera (≤ 4 s) e registra 55P03" \
     "$([ $((t1-t0)) -le 4 ] && echo rapido)/$(q "SELECT left(erro, 5) FROM public.credito_reducao_verificacao WHERE raiz = '$C'")" "rapido/55P03"
  eq "C1 o outro grupo do lote foi reduzido" "$(vg $F)" "0/0/alto/v2"
  eq "C1 C intacto (volta na próxima)" "$(vg $C)" "3300/21/baixo/v1"
}
# 2 sessões: duas reduções do MESMO grupo serializam — a 2ª relê o vigente já cortado e não corta de novo
check_serializa() {
  vig_c; tit oben 101 60 ATRASADO 90 60 100 100
  rm -f "$SAB"/a.out "$SAB"/b.out "$SAB"/a.fifo; mkfifo "$SAB/a.fifo"
  "${PSQL[@]}" -tA -q < "$SAB/a.fifo" > "$SAB/a.out" 2>&1 &
  local apsql=$!
  exec 3>"$SAB/a.fifo"
  echo "BEGIN; SELECT 'A:' || (private.credito_reduzir_limite('$C') ->> 'resultado');" >&3
  local i=0; until grep -q '^A:' "$SAB/a.out" 2>/dev/null; do i=$((i+1)); [ $i -gt 200 ] && break; sleep 0.05; done
  ( q "SELECT 'B:' || (private.credito_reduzir_limite('$C') ->> 'resultado');" > "$SAB/b.out" 2>&1 ) &
  local bjob=$! bloq=0 n
  for i in $(seq 1 100); do
    n=$(q "SELECT count(*) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%B:%';")
    if [ "$n" -ge 1 ]; then bloq=1; break; fi
    sleep 0.05
  done
  echo "COMMIT;" >&3; exec 3>&-; wait "$apsql" || true; wait "$bjob" || true
  eq "C2 B esperou A, e só A cortou" "$bloq/$(grep -o 'A:[a-z_]*' "$SAB/a.out")/$(grep -o 'B:[a-z_]*' "$SAB/b.out")/$(vg $C)" "1/A:reduzido/B:sem_mudanca/0/0/alto/v2"
}
check_acl() {
  vig_c
  tem "ACL authenticated não chama o redutor" "$(como "$L" "SELECT private.credito_reduzir_limite('$C')")" "42501"
  tem "ACL authenticated não chama o writer" "$(como "$L" "SELECT private.credito_limite_gravar(gen_random_uuid(), NULL, NULL)")" "42501"
  tem "ACL service_role não chama o lote" "$(comorole service_role "SELECT private.credito_reducao_lote(1, 1)")" "42501"
  tem "ACL service_role não chama o writer" "$(comorole service_role "SELECT private.credito_limite_gravar(gen_random_uuid(), NULL, NULL)")" "42501"
  tem "ACL authenticated não lê a verificação" "$(como "$L" "SELECT count(*) FROM public.credito_reducao_verificacao")" "42501"
  eq "ACL builder do Lovable sem EXECUTE nas funções novas" \
     "$(q "SELECT bool_or(has_function_privilege('sandbox_exec_teste', f, 'EXECUTE')) FROM unnest(ARRAY['private.credito_reduzir_limite(uuid)','private.credito_limite_gravar(uuid,uuid,integer)','private.credito_reducao_lote(integer,integer)']) f")" "f"
  eq "ACL aprovar segue só authenticated" "$(q "SELECT has_function_privilege('authenticated','public.credito_aprovar_proposta(uuid,text)','EXECUTE') AND NOT has_function_privilege('service_role','public.credito_aprovar_proposta(uuid,text)','EXECUTE')")" "t"
}
check_cron() {
  eq "CR cron a cada 5 min com statement_timeout" \
     "$(q "SELECT count(*) FROM cron.job WHERE jobname = 'credito-reducao-auto' AND schedule = '2-59/5 * * * *' AND command LIKE '%statement_timeout%' AND command LIKE '%credito_reducao_lote(25, 20)%'")" "1"
}

TODOS=(check_sem_vigente check_sem_mudanca check_regressao_pr4 check_piso check_piso_indet check_e2 check_e2_antigo
       check_e2_fronteira check_e2_reservas check_e2_exposicao_null check_nunca_aumenta check_e3 check_grupo_mudou
       check_recuperacao check_registro_base check_aprovar_antiga check_writer check_trigger check_dml_direto
       check_lote check_lote_erro check_ocupado check_serializa check_acl check_cron)
echo "· asserts"
for c in "${TODOS[@]}"; do "$c"; done
echo "controle: PASS=$PASS FAIL=$FAIL"
