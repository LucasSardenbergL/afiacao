#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Piso de crédito do grupo enxerga PAGTO PARCIAL e saldo ausente   ║
# ║  Migration: 20261121200000_credito_piso_pagto_parcial.sql (a MIGN)             ║
# ║  Histórico: docs/historico/credito-piso-grupo-2026-11.md                       ║
# ║  Rode: bash db/test-credito-piso-pagto-parcial.sh > /tmp/t.log 2>&1; echo $?   ║
# ║  Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-piso-pagto-parcial.sh   ║
# ║  Zonas 0-3 = as de db/test-credito-limite-reserva.sh (PR 2 + antecedentes)     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5541}"
SLUG="credito-piso-pagto-parcial"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

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

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (PR 1 e antecedentes; a nova é a sob prova)
# ══════════════════════════════════════════════════════════════════════════════
MIGS=("$REPO_ROOT/supabase/migrations/20260702233000_trava_credito_fase2.sql"
      "$REPO_ROOT/supabase/migrations/20260703140000_trava_credito_gate_excecao_por_par.sql"
      "$REPO_ROOT/supabase/migrations/20261121120000_trava_credito_piso_grupo.sql")
MIG="$REPO_ROOT/supabase/migrations/20261121160000_credito_limite_reserva_decisao.sql"
for m in "${MIGS[@]}"; do P -q -f "$m"; done
# ISCA: em prod há credito_* de OUTRA feature com grant legítimo a authenticated (credito_vinculo_aviso,
# medido no ensaio 2026-11-21). A migration não pode mexer nela nem contá-la na postcondição.
P -q -c "CREATE FUNCTION public.credito_vinculo_aviso(text) RETURNS text LANGUAGE sql AS \$f\$ SELECT \$1 \$f\$;
         REVOKE ALL ON FUNCTION public.credito_vinculo_aviso(text) FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION public.credito_vinculo_aviso(text) TO authenticated, service_role, sandbox_exec_teste;"
P -q -f "$MIG"
# 20261121200000 (piso vê PAGTO PARCIAL/indeterminado) REESCREVE private.credito_avaliar_reservar: a
# prod é MIG + MIGN, então toda aplicação/restauração aqui aplica as duas (Codex desenho P3-5).
MIGN="$REPO_ROOT/supabase/migrations/20261121200000_credito_piso_pagto_parcial.sql"
P -q -f "$MIGN"
echo "migrations aplicadas: ${#MIGS[@]} antecedentes + $(basename "$MIG") + $(basename "$MIGN")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + helpers SQL do harness (o t_gate simula o wrapper do PR 5)
# grupo C: canônico C oben 101 + alias A1 ACTIVE colacor_sc 202
# grupo D: oben 501 (independente) · grupo E: colacor 601 com alias E2 CONFLICT colacor 602
# par oben 999: sem dono no mapa
# ══════════════════════════════════════════════════════════════════════════════
C=c0000000-0000-0000-0000-000000000001
A1=a1000000-0000-0000-0000-000000000001
D=d0000000-0000-0000-0000-000000000001
E=e0000000-0000-0000-0000-000000000001
E2=e2000000-0000-0000-0000-000000000001
S1=aaaaaaaa-0000-0000-0000-000000000001
S2=aaaaaaaa-0000-0000-0000-000000000002
S3=aaaaaaaa-0000-0000-0000-000000000003
P -q <<SQL
INSERT INTO public.customer_canonical_alias VALUES ('$A1','$C','active'), ('$E2','$E','conflict');
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('$C','oben',101), ('$A1','colacor_sc',202), ('$D','oben',501), ('$E','colacor',601), ('$E2','colacor',602);

CREATE FUNCTION public.t_try(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END \$f\$;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO PUBLIC;

CREATE FUNCTION public.t_gate(p_so uuid, p_co text, p_cod bigint, p_rev text, p_val numeric, p_prazo int,
                              p_modo text DEFAULT 'efetivo')
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS \$f\$
  SELECT private.credito_avaliar_reservar(p_so, p_co, p_cod, p_rev, p_val, p_prazo, p_modo, NULL) \$f\$;

-- propõe (como a edge do PR 4) e aprova como o Lucas; devolve a versão vigente
CREATE FUNCTION public.t_limite(p_grupo uuid, p_val numeric, p_prazo int, p_risco text,
                                p_ficha_em timestamptz DEFAULT now())
RETURNS int LANGUAGE plpgsql VOLATILE AS \$f\$
DECLARE v_id uuid;
BEGIN
  v_id := public.credito_propor_limite(p_grupo, p_val, p_prazo, p_risco, 0.9, '{"k":1}'::jsonb, NULL, NULL,
            'teste', 'v1', p_ficha_em, public.credito_grupo_assinatura(p_grupo),
            (SELECT versao FROM public.credito_limite WHERE grupo_user_id = p_grupo));
  PERFORM set_config('request.jwt.claims', '{"sub":"$L"}', true);
  RETURN (public.credito_aprovar_proposta(v_id, 'teste') ->> 'versao')::int;
END \$f\$;

-- limpeza do harness (triggers desligados só aqui)
CREATE FUNCTION public.t_limpa() RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS \$f\$
BEGIN
  DELETE FROM public.credito_autorizacao; DELETE FROM public.credito_solicitacao;
  DELETE FROM public.credito_reserva; DELETE FROM public.credito_decisao_pedido;
  DELETE FROM public.credito_limite; DELETE FROM public.credito_limite_proposta;
  DELETE FROM public.fin_contas_receber; DELETE FROM public.venda_excecao_credito;
  DELETE FROM public.omie_customer_account_map WHERE omie_codigo_cliente = 105;
END \$f\$;
CREATE FUNCTION public.t_forca(p_sql text) RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS \$f\$
BEGIN EXECUTE p_sql; END \$f\$;

-- papel de teste COM DML e BYPASSRLS: isola o TRIGGER das outras barreiras (P1-9 Codex)
CREATE ROLE escritor_teste BYPASSRLS;
GRANT USAGE ON SCHEMA public TO escritor_teste;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO escritor_teste, sandbox_exec_teste;
SQL
# o papel de teste perde o DML a cada aplicação da migration (a allowlist o revoga — certo!):
# re-conceder DEPOIS de cada aplicação, senão o 42501 do R4/F5 vem do privilégio e não do trigger.
grant_escritor() { P -q <<'SQL'
DO $g$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['credito_limite','credito_decisao_pedido','credito_reserva','credito_solicitacao',
                           'credito_autorizacao','credito_limite_proposta','credito_aprovador'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.%I TO escritor_teste', t);
  END LOOP; END $g$;
SQL
}
grant_escritor
aplica_real() { P -q -f "$MIG"; P -q -f "$MIGN"; grant_escritor; }

limpa() { Pq -c "SELECT public.t_limpa();" >/dev/null; }
# títulos: reseta e semeia "company:codigo:dias_vencido:saldo[:status]" (saldo NULL aceito; dias<0 = a vencer)
titulos() {
  local sql="SELECT public.t_forca('DELETE FROM public.fin_contas_receber');"
  local t co cod dias saldo st
  for t in "$@"; do
    IFS=: read -r co cod dias saldo st <<<"$t"
    sql+="INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento) VALUES ('$co', $cod, $saldo, '${st:-ATRASADO}', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($dias)));"
  done
  Pq -c "$sql" >/dev/null
}
limite() { Pq -c "SELECT public.t_limite('$1', $2, $3, '$4'${5:+, $5});"; }
# gate: pedido company codigo revisao valor prazo [modo]
gate() { local m=""; [ -n "${7:-}" ] && m=", '$7'"; Pq -c "SELECT public.t_gate('$1', '$2', $3, '$4', $5, $6$m);"; }
J() { python3 -c "import sys,json; d=json.load(sys.stdin); v=d$1; print(v)"; }
# executa SQL como usuário autenticado (JWT de prod: request.jwt.claims) e devolve OK|SQLSTATE
como() { Pq -c "SELECT pg_catalog.set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);" \
            -c "SET ROLE authenticated;" -c "SELECT public.t_try(\$q\$$2\$q\$);" | tail -1; }
comoval() { Pq -c "SELECT pg_catalog.set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);" \
               -c "SET ROLE authenticated;" -c "$2" | tail -1; }
comorole() { Pq -c "SET ROLE $1;" -c "SELECT public.t_try(\$q\$$2\$q\$);" | tail -1; }
ativas() { Pq -c "SELECT COALESCE(sum(valor_brl),0)::bigint FROM public.credito_reserva WHERE status='ativa' AND modo='${1:-efetivo}';"; }


# piso direto (como a edge omie-vendas-sync chama): pedido company codigo
JX() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
piso() { Pq -c "SELECT public.venda_gate_credito_grupo('$1', '$2', $3);"; }
# exceção do (pedido, par) gravada direto (RLS/aprovação já provadas na v1); $4 = created_at (SQL)
excecao() { Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_excecao_credito (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por, created_at) VALUES ('$1', '$2', $3, 'teste', now() + interval '3 days', '$G', $4)\$q\$);" >/dev/null; }
# log de bloqueio do pedido (o que a edge grava ao bloquear); $3 = created_at (SQL)
logbloq() { Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_bloqueio_credito_log (company, omie_codigo_cliente, sales_order_id, acao, created_at) VALUES ('$2', 101, '$1', 'bloqueado', $3)\$q\$);" >/dev/null; }
# limpa também os logs de bloqueio (o t_limpa do PR 2 não os toca)
limpa() { Pq -c "SELECT public.t_limpa(); SELECT public.t_forca('DELETE FROM public.venda_bloqueio_credito_log');" >/dev/null; }
# título com vencimento NULL (o helper titulos() sempre grava data)
sem_vencimento() { Pq -c "SELECT public.t_forca(\$q\$DELETE FROM public.fin_contas_receber; INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento) VALUES ('oben', 101, $1, 'ATRASADO', NULL)\$q\$);" >/dev/null; }
# marcos: PR 1 há 2 dias; ESTA virada há 1 dia → exceção "entre" = criada há 36 h
P -q -c "UPDATE public.credito_virada_grupo SET aplicada_em = now() - interval '2 days';
         UPDATE public.credito_virada_piso_parcial SET aplicada_em = now() - interval '1 day';"
ENTRE="now() - interval '36 hours'"
NOVA="now()"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# grupo C = oben 101 (canônico) + colacor_sc 202 (alias active) · oben 999 sem dono
# ══════════════════════════════════════════════════════════════════════════════
asserts() {
  local g f
  limpa

  echo "· PAGTO PARCIAL (bloqueio determinado, valor indeterminado)"
  titulos "oben:101:75:500:PAGTO PARCIAL"
  g=$(piso "$S1" oben 101)
  eq "P1 PAGTO PARCIAL vencido 75 d → bloqueia" "$(echo "$g" | J "['bloqueado']")" "True"
  eq "P1b motivo = vencido comprovado" "$(echo "$g" | J "['motivo']")" "vencido_60d_sem_excecao"
  eq "P1c valor NÃO é o cheio: vencido null" "$(echo "$g" | J "['vencido']")" "None"
  eq "P1d valor_indeterminado" "$(echo "$g" | J "['valor_indeterminado']")" "True"
  eq "P1e titulos_comprovados = 1" "$(echo "$g" | J "['titulos_comprovados']")" "1"
  eq "P1f par listado com vencido null" "$(echo "$g" | J "['pares'][0]['vencido']")" "None"
  titulos "colacor_sc:202:75:500:PAGTO PARCIAL"
  eq "P1g PAGTO PARCIAL só no ALIAS, pedido na oben → bloqueia (grupo)" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  titulos "oben:999:75:500:PAGTO PARCIAL"
  eq "P1h PAGTO PARCIAL em par sem dono → bloqueia o próprio par" "$(piso "$S1" oben 999 | J "['bloqueado']")" "True"
  titulos "oben:101:75:0:PAGTO PARCIAL"
  eq "P1i PAGTO PARCIAL vencido com saldo espelhado 0 → bloqueia (o status prova resíduo)" "$(piso "$S1" oben 101 | J "['motivo']")" "vencido_60d_sem_excecao"
  titulos "oben:101:75:NULL:PAGTO PARCIAL"
  eq "P1j PAGTO PARCIAL vencido com saldo NULL → bloqueia comprovado" "$(piso "$S1" oben 101 | J "['motivo']")" "vencido_60d_sem_excecao"
  Pq -c "SELECT public.t_forca(\$q\$DELETE FROM public.fin_contas_receber; INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento) VALUES ('oben', 101, 0, 'PAGTO PARCIAL', NULL)\$q\$);" >/dev/null
  eq "P1k PAGTO PARCIAL sem vencimento (saldo 0) → piso_indeterminado" "$(piso "$S1" oben 101 | J "['motivo']")" "piso_indeterminado"
  titulos "oben:101:-5:500:PAGTO PARCIAL"
  eq "P2 PAGTO PARCIAL a vencer → não bloqueia" "$(piso "$S1" oben 101 | J "['motivo']")" "sem_vencido_60d"
  titulos "oben:101:60:500:PAGTO PARCIAL"
  eq "P2b PAGTO PARCIAL vencido EXATO 60 d → não bloqueia (fronteira <)" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"

  titulos "oben:101:75:300" "colacor_sc:202:75:500:PAGTO PARCIAL"
  g=$(piso "$S1" oben 101)
  eq "P3 mistura: total null (não soma 300 nem 800)" "$(echo "$g" | J "['vencido']")" "None"
  eq "P3b par comprovado mantém o número" "$(echo "$g" | JX "[p['vencido'] for p in d['pares'] if p['company']=='oben'][0]")" "300"
  eq "P3c par parcial sai null" "$(echo "$g" | JX "[p['vencido'] for p in d['pares'] if p['company']=='colacor_sc'][0]")" "None"
  eq "P3d títulos = 2" "$(echo "$g" | J "['titulos']")" "2"
  eq "P3e titulos_indeterminados = 1" "$(echo "$g" | J "['titulos_indeterminados']")" "1"
  titulos "oben:101:75:300" "colacor_sc:202:80:50"
  g=$(piso "$S1" oben 101)
  eq "P3f só comprovados: total numérico (350)" "$(echo "$g" | J "['vencido']")" "350"
  eq "P3g … valor_indeterminado false" "$(echo "$g" | J "['valor_indeterminado']")" "False"

  echo "· saldo/vencimento ausentes (indeterminado SEGURA)"
  titulos "colacor_sc:202:70:NULL"
  g=$(piso "$S1" oben 101)
  eq "P4 saldo NULL vencido 70 d → bloqueia" "$(echo "$g" | J "['bloqueado']")" "True"
  eq "P4b motivo piso_indeterminado" "$(echo "$g" | J "['motivo']")" "piso_indeterminado"
  eq "P4c titulos_comprovados = 0" "$(echo "$g" | J "['titulos_comprovados']")" "0"
  eq "P4d vencido null (nunca 0)" "$(echo "$g" | J "['vencido']")" "None"
  titulos "oben:101:-5:NULL:A VENCER"
  eq "P4e saldo NULL a vencer → não bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"
  sem_vencimento 300
  eq "P4f saldo 300 sem vencimento → piso_indeterminado" "$(piso "$S1" oben 101 | J "['motivo']")" "piso_indeterminado"
  sem_vencimento NULL
  eq "P4g saldo e vencimento NULL → piso_indeterminado" "$(piso "$S1" oben 101 | J "['motivo']")" "piso_indeterminado"
  titulos "oben:101:75:0"
  eq "P4h saldo 0 vencido → não bloqueia (quitado)" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"
  titulos "oben:101:75:NULL:RECEBIDO"
  eq "P4i saldo NULL fora do vocabulário (RECEBIDO) → não bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"
  titulos "oben:101:75:300" "colacor_sc:202:70:NULL"
  g=$(piso "$S1" oben 101)
  eq "P4j comprovado + indeterminado → motivo comprovado" "$(echo "$g" | J "['motivo']")" "vencido_60d_sem_excecao"
  eq "P4k … e o total NÃO esconde o saldo NULL (null, não 300)" "$(echo "$g" | J "['vencido']")" "None"
  eq "P4l … titulos_indeterminados = 1" "$(echo "$g" | J "['titulos_indeterminados']")" "1"
  titulos "oben:101:75:300" "oben:101:70:NULL"
  g=$(piso "$S1" oben 101)
  eq "P4m MESMO par: 300 + saldo NULL → par e total null (não 300)" "$(echo "$g" | J "['pares'][0]['vencido']")$(echo "$g" | J "['vencido']")" "NoneNone"

  echo "· exceção e as duas viradas"
  # aprovação DEPOIS de um bloqueio já avaliado pelo piso novo (log entre a virada e a exceção)
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
  eq "P5 exceção aprovada após bloqueio NOVO cobre PAGTO PARCIAL" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_valida"
  titulos "oben:101:70:NULL"
  eq "P5b … e cobre indeterminado" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_valida"
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; excecao "$S1" oben 101 "$NOVA"
  eq "P5c exceção NOVA sem log de bloqueio pós-virada (gestor leu o log antigo) → não cobre" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_anterior_nao_cobre_parcial"
  logbloq "$S1" oben "now() + interval '1 minute'"
  eq "P5d log pós-virada mas DEPOIS da aprovação → não cobre" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '30 hours'"; excecao "$S1" oben 101 "$NOVA"
  eq "P5e só log ANTERIOR à virada → não cobre" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 day' + interval '2 minutes'"; excecao "$S1" oben 101 "$NOVA"
  eq "P5g log nos 5 min após a virada (corrida do deploy: piso antigo) → não cobre" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" colacor_sc "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
  eq "P5f log de OUTRA empresa do mesmo pedido não vale → não cobre" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; excecao "$S1" oben 101 "$ENTRE"
  eq "P6 exceção ANTERIOR a esta virada + PAGTO PARCIAL no MESMO par → não cobre" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_anterior_nao_cobre_parcial"
  titulos "oben:101:75:300"
  eq "P6b … sem título omitido pela regra antiga → cobre (sem log, como antes)" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_valida"
  titulos "oben:101:70:NULL"
  eq "P6c exceção anterior + saldo NULL → não cobre" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  limpa; titulos "oben:101:75:300" "colacor_sc:202:75:500:PAGTO PARCIAL"
  excecao "$S1" oben 101 "now() - interval '3 days'"
  eq "P7 exceção anterior ao PR 1 + dívida de valor null em OUTRO par → regra do grupo (EXISTS, não soma)" \
     "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_anterior_nao_cobre_grupo"
  limpa

  echo "· PR 2 (private.credito_avaliar_reservar) sobre o piso novo"
  limite "$C" 10000 28 baixo >/dev/null
  titulos "colacor_sc:202:70:NULL"
  eq "P8 saldo NULL vencido → PR 2 segue amarelo piso_indeterminado (não vermelho)" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "piso_indeterminado"
  titulos "colacor_sc:202:75:300:PAGTO PARCIAL"
  eq "P8b PAGTO PARCIAL vencido → PR 2 vermelho" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "piso_vencido_60d"
  titulos "oben:101:75:300"
  eq "P8c vencido comum → PR 2 vermelho" "$(gate "$S1" oben 101 r1 1000 28 | J "['faixa']")" "vermelho"
  titulos "oben:101:70:NULL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  # par com DOIS donos no mapa: o PR 2 não resolve raiz (relê só o par); o piso expande os 2 grupos
  Pq -c "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$D', 'oben', 105), ('$C', 'oben', 105);" >/dev/null
  titulos "colacor_sc:202:70:NULL"
  eq "P8e par de 2 donos + indeterminado só na conta irmã → PR 2 piso_indeterminado (guarda do piso.bloqueado)" "$(gate "$S1" oben 105 r1 1000 28 | J "['motivo']")" "piso_indeterminado"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "oben:101:75:0:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
  eq "P8f PAGTO PARCIAL saldo 0 vencido + exceção válida → PR 2 segue vermelho (nunca verde)" "$(gate "$S1" oben 101 r1 1000 28 | J "['faixa']")" "vermelho"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "oben:101:70:NULL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
  eq "P8d piso indeterminado coberto por exceção → PR 2 segue amarelo" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "piso_indeterminado"
  limpa

  echo "· ACL (allowlist owner + service_role; privilégio efetivo)"
  for f in "credito_grupo_pares(uuid)" "venda_gate_credito_grupo(uuid,text,bigint)" "venda_gate_credito(text,bigint,uuid)"; do
    eq "P9 sandbox_exec NÃO executa $f" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_teste','public.$f','EXECUTE');")" "f"
    eq "P9 anon NÃO executa $f" "$(Pq -c "SELECT has_function_privilege('anon','public.$f','EXECUTE');")" "f"
    eq "P9 authenticated NÃO executa $f" "$(Pq -c "SELECT has_function_privilege('authenticated','public.$f','EXECUTE');")" "f"
    eq "P9 service_role executa $f" "$(Pq -c "SELECT has_function_privilege('service_role','public.$f','EXECUTE');")" "t"
  done
  eq "P9b avaliar_reservar: nenhum grantee além do owner" \
     "$(Pq -c "SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid = 'private.credito_avaliar_reservar'::regproc AND a.grantee <> p.proowner;")" "0"
  eq "P9c virada nova: 1 linha, RLS ligada, sandbox sem SELECT" \
     "$(Pq -c "SELECT (SELECT count(*) FROM public.credito_virada_piso_parcial)::text || (SELECT relrowsecurity FROM pg_class WHERE oid='public.credito_virada_piso_parcial'::regclass)::text || has_table_privilege('sandbox_exec_teste','public.credito_virada_piso_parcial','SELECT')::text;")" "1truefalse"
  eq "P9f sandbox_exec não escreve exceção; anon/authenticated sem TRUNCATE no log/exceção" \
     "$(Pq -c "SELECT has_table_privilege('sandbox_exec_teste','public.venda_excecao_credito','INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('anon','public.venda_bloqueio_credito_log','TRUNCATE') OR has_table_privilege('authenticated','public.venda_excecao_credito','TRUNCATE');")" "f"
  eq "P9e sandbox_exec não escreve no log de bloqueio (forjaria o 'gestor viu')" \
     "$(Pq -c "SELECT has_table_privilege('sandbox_exec_teste','public.venda_bloqueio_credito_log','INSERT,UPDATE,DELETE,TRUNCATE');")" "f"
  eq "P9d marco do PR 1: anon/authenticated/sandbox sem acesso (TRUNCATE incluído)" \
     "$(Pq -c "SELECT bool_or(has_table_privilege(r, 'public.credito_virada_grupo', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) FROM unnest(ARRAY['anon','authenticated','sandbox_exec_teste']) r;")" "f"
}

echo "── asserts (controle) ──"
asserts
if [ "$FAIL" != "0" ]; then
  echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ HARNESS VERMELHO (controle) — falsificação não roda"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (uma camada por vez; controle verde acima na MESMA invocação)
# Cada sabotagem aplica uma cópia adulterada da migration NOVA, exige o assert-alvo VERMELHO
# e re-aplica a real. A defesa "piso bloqueado que a releitura do PR 2 não viu → amarelo" é
# INALCANÇÁVEL sem corrida entre 2 comandos (o PR 2 conta um superconjunto) — não falsificada.
# ══════════════════════════════════════════════════════════════════════════════
sabota() { # $1 rótulo · $2 python que transforma o texto · $3 comando do assert-alvo · $4 valor que o assert SÃO exige
  python3 - "$MIGN" "$SAB/m.sql" "$2" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read(); n = eval(expr)
assert n != t, "sabotagem não alterou o texto"
open(dst, "w").write(n)
PY
  P -q -f "$SAB/m.sql"
  local v; v=$(eval "$3")
  if [ "$v" != "$4" ]; then ok "$1 → assert-alvo ficou vermelho (veio $v)"; else bad "$1 → sabotei e o assert continuou verde ($v): sem dente"; fi
  P -q -f "$MIGN"
}

echo "── falsificação ──"
limpa; titulos "oben:101:75:500:PAGTO PARCIAL"
sabota "F1 vocabulário sem PAGTO PARCIAL (o furo)" \
  "t.replace(\"'PARCIAL', 'PAGTO PARCIAL')\n\", \"'PARCIAL')\n\", 1)" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"
sabota "F2 valor de PAGTO PARCIAL tratado como conhecido (saldo cheio)" \
  "t.replace(\"\n            AND f.status_titulo <> 'PAGTO PARCIAL', false) AS valor_conhecido\", \", false) AS valor_conhecido\")" \
  "piso '$S1' oben 101 | J \"['vencido']\"" "None"

titulos "oben:101:75:300" "oben:101:70:NULL"
sabota "F2b sem o COALESCE (NULL some do bool_and → total 300 esconde o saldo NULL)" \
  "t.replace(\"COALESCE(f.saldo > 0 AND f.data_vencimento < v_corte\n            AND f.status_titulo <> 'PAGTO PARCIAL', false) AS valor_conhecido\", \"(f.saldo > 0 AND f.data_vencimento < v_corte\n            AND f.status_titulo <> 'PAGTO PARCIAL') AS valor_conhecido\")" \
  "piso '$S1' oben 101 | J \"['vencido']\"" "None"

titulos "oben:101:75:300" "colacor_sc:202:75:500:PAGTO PARCIAL"
sabota "F3 total soma os pares conhecidos (esconde o indeterminado)" \
  "t.replace(\"SELECT CASE WHEN bool_and(pp.vencido IS NOT NULL) THEN sum(pp.vencido) END,\", \"SELECT sum(pp.vencido),\")" \
  "piso '$S1' oben 101 | J \"['vencido']\"" "None"

titulos "colacor_sc:202:70:NULL"
sabota "F4 sem o ramo saldo NULL (fail-open antigo)" \
  "t.replace(\"          OR (f.saldo IS NULL AND (f.data_vencimento IS NULL OR f.data_vencimento < v_corte)) -- saldo ausente\n\", \"\")" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"

sem_vencimento 300
sabota "F5 sem o ramo vencimento NULL" \
  "t.replace(\"          OR (f.saldo > 0 AND f.data_vencimento IS NULL)                                   -- vencimento ausente\n\", \"\")" \
  "piso '$S1' oben 101 | J \"['motivo']\"" "piso_indeterminado"

limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; excecao "$S1" oben 101 "$ENTRE"
sabota "F6 sem a exigência de bloqueio pós-virada (exceção antiga cobre PAGTO PARCIAL)" \
  "t.replace(\"          OR NOT EXISTS (SELECT 1 FROM public.venda_bloqueio_credito_log l\", \"          OR false AND NOT EXISTS (SELECT 1 FROM public.venda_bloqueio_credito_log l\")" \
  "piso '$S1' oben 101 | J \"['motivo']\"" "excecao_anterior_nao_cobre_parcial"

limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; excecao "$S1" oben 101 "$NOVA"; logbloq "$S1" oben "now() + interval '1 minute'"
sabota "F6b log DEPOIS da aprovação aceito (gestor não viu o bloqueio)" \
  "t.replace(\"                            AND l.created_at <= v_excecao_criada)) THEN\", \"                            )) THEN\")" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"
limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" colacor_sc "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
sabota "F6c log de outra empresa do pedido aceito" \
  "t.replace(\"                            AND l.company = p_company\n\", \"\")" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"
limpa; titulos "oben:101:75:500:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 day' + interval '2 minutes'"; excecao "$S1" oben 101 "$NOVA"
sabota "F6d sem a margem de 5 min (log da corrida do deploy aceito)" \
  "t.replace(\"AND l.created_at >= v_virada_parcial + interval '5 minutes'\", \"AND l.created_at >= v_virada_parcial\")" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"
limpa; limite "$C" 10000 28 baixo >/dev/null; titulos "oben:101:75:0:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "$NOVA"
sabota "F8b PR 2 relê PAGTO PARCIAL só com saldo > 0 (saldo 0 + exceção vira verde)" \
  "t.replace(\"count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL') AND f.data_vencimento < v_corte\n\", \"count(*) FILTER (WHERE f.saldo > 0 AND f.data_vencimento < v_corte\n\")" \
  "gate '$S1' oben 101 r1 1000 28 | J \"['faixa']\"" "vermelho"
limpa; titulos "oben:101:75:0:PAGTO PARCIAL"
sabota "F1b PAGTO PARCIAL de saldo 0 some (só saldo > 0 entra)" \
  "t.replace(\"          OR (f.status_titulo = 'PAGTO PARCIAL'\n              AND (f.data_vencimento IS NULL OR f.data_vencimento < v_corte))              -- parcial, qualquer saldo\n\", \"\")" \
  "piso '$S1' oben 101 | J \"['bloqueado']\"" "True"
limpa; limite "$C" 10000 28 baixo >/dev/null
Pq -c "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$D', 'oben', 105), ('$C', 'oben', 105);" >/dev/null
titulos "colacor_sc:202:70:NULL"
sabota "F10 PR 2 sem a guarda do piso.bloqueado (par de 2 donos cai em sem_grupo)" \
  "t.replace(\"        OR (v_piso ->> 'bloqueado')::boolean  -- piso indeterminado que a releitura não viu: nunca libera\n\", \"\")" \
  "gate '$S1' oben 105 r1 1000 28 | J \"['motivo']\"" "piso_indeterminado"

limpa; titulos "oben:101:75:300" "colacor_sc:202:75:500:PAGTO PARCIAL"; excecao "$S1" oben 101 "now() - interval '3 days'"
sabota "F7 virada do grupo volta a SOMAR — REDUNDANTE: a virada própria ainda segura, só o motivo muda" \
  "t.replace(\"SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(v_pares) e\n                  WHERE NOT (e->>'company' = p_company AND (e->>'codigo')::bigint = p_codigo))\", \"SELECT COALESCE(sum((e->>'vencido')::numeric), 0) > 0 FROM jsonb_array_elements(v_pares) e\n                  WHERE NOT (e->>'company' = p_company AND (e->>'codigo')::bigint = p_codigo)\")" \
  "piso '$S1' oben 101 | J \"['motivo']\"" "excecao_anterior_nao_cobre_grupo"

limpa; limite "$C" 10000 28 baixo >/dev/null; titulos "colacor_sc:202:70:NULL"
sabota "F8 PR 2 sem a condição (indeterminado vira vermelho)" \
  "t.replace(\"AND COALESCE((v_piso ->> 'titulos_comprovados')::integer, 1) > 0)\", \"AND COALESCE((v_piso ->> 'titulos_comprovados')::integer, 1) >= 0)\")" \
  "gate '$S1' oben 101 r1 1000 28 | J \"['motivo']\"" "piso_indeterminado"
limpa

# F9: allowlist sem o REVOKE por grantee → a POSTCONDIÇÃO aborta (o sandbox fica com EXECUTE)
python3 - "$MIGN" "$SAB/m.sql" <<'PY2'
import sys
t = open(sys.argv[1]).read()
a = "        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.sig, g.papel);"
assert t.count(a) == 1, "alvo F9 ausente"
open(sys.argv[2], "w").write(t.replace(a, "        NULL;", 1))
PY2
P -q -c "GRANT EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid,text,bigint) TO sandbox_exec_teste;"
if P -q -f "$SAB/m.sql" > "$SAB/f9.log" 2>&1; then
  bad "F9 allowlist sem REVOKE → a migration APLICOU (postcondição sem dente)"
elif grep -q "POS FALHOU: public.venda_gate_credito_grupo(uuid,text,bigint) tem EXECUTE fora da allowlist" "$SAB/f9.log"; then
  ok "F9 allowlist sem REVOKE → postcondição abortou a aplicação"
else
  bad "F9 falhou por OUTRO motivo: $(head -c 300 "$SAB/f9.log")"
fi
P -q -f "$MIGN"

# F11: sem o REVOKE de escrita do sandbox no log → a POSTCONDIÇÃO aborta
python3 - "$MIGN" "$SAB/m.sql" <<'PY3'
import sys
t = open(sys.argv[1]).read()
a = "      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %s FROM %I', tb, r.rolname);"
assert t.count(a) == 1, "alvo F11 ausente"
open(sys.argv[2], "w").write(t.replace(a, "      NULL;", 1))
PY3
P -q -c "GRANT INSERT ON public.venda_bloqueio_credito_log TO sandbox_exec_teste;"
if P -q -f "$SAB/m.sql" > "$SAB/f11.log" 2>&1; then
  bad "F11 sandbox escreve no log → a migration APLICOU (postcondição sem dente)"
elif grep -q "POS FALHOU: sandbox_exec_teste ainda escreve em venda_bloqueio_credito_log" "$SAB/f11.log"; then
  ok "F11 sandbox escreve no log → postcondição abortou a aplicação"
else
  bad "F11 falhou por OUTRO motivo: $(head -c 300 "$SAB/f11.log")"
fi
P -q -f "$MIGN"

echo "── verificação de prod (db/verifica-credito-piso-pagto-parcial.sql) EXECUTADA ──"
VER="$REPO_ROOT/db/verifica-credito-piso-pagto-parcial.sql"
limpa; titulos "oben:101:75:500:PAGTO PARCIAL" "colacor_sc:202:80:90:PAGTO PARCIAL" "oben:101:75:300"
if P -q -f "$VER" > "$SAB/v.log" 2>&1 && grep -q "VERIFICA OK: 2 pares PAGTO PARCIAL vencido > 60 d · 2 bloqueados · 2 com vencido null" "$SAB/v.log"; then
  ok "V1 verificação passa com o piso novo (2 pares)"
else bad "V1 verificação: $(head -c 300 "$SAB/v.log")"; fi
limpa
if P -q -f "$VER" > "$SAB/v.log" 2>&1; then bad "V2 verificação passou com 0 pares (ausente virou ok)"
elif grep -q "VERIFICA FALHOU: 0 pares" "$SAB/v.log"; then ok "V2 0 pares → verificação FALHA (ausente ≠ ok)"
else bad "V2 outro erro: $(head -c 300 "$SAB/v.log")"; fi
titulos "oben:101:75:500:PAGTO PARCIAL"
P -q -f "$REPO_ROOT/supabase/migrations/20261121120000_trava_credito_piso_grupo.sql"
if P -q -f "$VER" > "$SAB/v.log" 2>&1; then bad "V3 verificação passou com o piso ANTIGO"
elif grep -q "VERIFICA FALHOU: oben/101 não bloqueou" "$SAB/v.log"; then ok "V3 piso antigo → verificação FALHA (tem dente)"
else bad "V3 outro erro: $(head -c 300 "$SAB/v.log")"; fi
P -q -f "$MIGN"
P -q -c "CREATE OR REPLACE FUNCTION public.venda_gate_credito_grupo(p_sales_order_id uuid, p_company text, p_codigo bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$f\$ SELECT '{}'::jsonb \$f\$;"
if P -q -f "$VER" > "$SAB/v.log" 2>&1; then bad "V4 verificação passou com o gate devolvendo {}"
elif grep -q "VERIFICA FALHOU: oben/101 não bloqueou" "$SAB/v.log"; then ok "V4 gate devolvendo {} → verificação FALHA (IS DISTINCT FROM)"
else bad "V4 outro erro: $(head -c 300 "$SAB/v.log")"; fi
P -q -f "$MIGN"; limpa

echo "── re-prova pós-restauração ──"
asserts

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "FIM-OK"
