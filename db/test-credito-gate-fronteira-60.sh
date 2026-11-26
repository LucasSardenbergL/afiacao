#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# PROVA PG17 — piso de crédito com fronteira INCLUSIVA (vencido >= 60 d) nas 3 funções do corte.
# Migration sob prova: 20261124170000_credito_gate_fronteira_60_inclusiva.sql (a MIGF).
# Base: zonas 1-3 copiadas de db/test-credito-piso-pagto-parcial.sh (a prod = MIGS + MIG + MIGN).
# Rode: bash db/test-credito-gate-fronteira-60.sh > /tmp/t.log 2>&1; echo $?
# Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-gate-fronteira-60.sh
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"   # PGBIN portátil (Mac brew / CI apt)
PORT="${PGPORT_TEST:-5472}"
SLUG="credito-gate-fronteira-60"
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

PASS=0; FAIL=0
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

# ════════════════════════════════════════════════════════════════════════
# ZONA 4 — A MIGRATION SOB PROVA + ASSERTS DA FRONTEIRA
# ════════════════════════════════════════════════════════════════════════
MIGF="$REPO_ROOT/supabase/migrations/20261124170000_credito_gate_fronteira_60_inclusiva.sql"
FNS="'public.venda_gate_credito_grupo(uuid,text,bigint)'::regprocedure, 'public.venda_gate_credito(text,bigint,uuid)'::regprocedure, 'private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'::regprocedure"
# Corpos de ANTES (= repo MIGS+MIG+MIGN). Restaurar = reexecutar estes CREATE OR REPLACE.
Pq -c "SELECT string_agg(pg_get_functiondef(f) || ';', E'\n') FROM unnest(ARRAY[$FNS]) f;" > "$SAB/antes.sql"
ACL_ANTES=$(Pq -c "SELECT string_agg(coalesce(proacl::text,'-'), '|' ORDER BY oid) FROM pg_proc WHERE oid IN ($FNS);")
restaura() { P -q -f "$SAB/antes.sql"; limpa; }
QUIETO=0
ok()  { PASS=$((PASS+1)); [ "$QUIETO" = 1 ] || echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); [ "$QUIETO" = 1 ] || echo "  ❌ $1"; }

asserts() {
  limpa
  titulos "oben:101:60:500"
  eq "F1 vencido EXATO 60 d → piso bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  eq "F1b motivo comprovado" "$(piso "$S1" oben 101 | J "['motivo']")" "vencido_60d_sem_excecao"
  titulos "oben:101:59:500"
  eq "F2 vencido 59 d → não bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"
  titulos "colacor_sc:202:60:500"
  eq "F3 60 d em OUTRO par do grupo → bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  titulos "oben:101:60:500:PAGTO PARCIAL"
  eq "F4 PAGTO PARCIAL 60 d → bloqueia (era a fronteira < do P2b)" "$(piso "$S1" oben 101 | J "['bloqueado']")" "True"
  titulos "oben:101:60:NULL"
  eq "F5 saldo NULL 60 d → indeterminado (não some)" "$(piso "$S1" oben 101 | J "['motivo']")" "piso_indeterminado"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "oben:101:60:300"
  eq "F6 PR 2: vencido 60 d → vermelho" "$(gate "$S1" oben 101 r1 1000 28 | J "['faixa']")" "vermelho"
  titulos "oben:101:59:300"
  eq "F7 PR 2: vencido 59 d → verde/dentro_limite" "$(gate "$S1" oben 101 r2 1000 28 | JX "d['faixa']+'/'+d['motivo']")" "verde/dentro_limite"
  limpa
  titulos "oben:101:60:500"
  eq "F8 v1 por par: 60 d → bloqueia" "$(Pq -c "SELECT public.venda_gate_credito('oben', 101, '$S1');" | J "['bloqueado']")" "True"
  # R: a releitura PRÓPRIA do PR 2 (não herdada do piso). PAGTO PARCIAL saldo 0 no dia 60 + exceção
  # válida com log elegível: o piso diz excecao_valida; só o `<=` da privada mantém o vermelho.
  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "oben:101:60:0:PAGTO PARCIAL"; logbloq "$S1" oben "now() - interval '1 hour'"; excecao "$S1" oben 101 "now()"
  eq "R1 piso no dia 60 com exceção válida → excecao_valida" "$(piso "$S1" oben 101 | J "['motivo']")" "excecao_valida"
  eq "R2 PR 2 relê o dia 60 sozinho → vermelho/piso_vencido_60d" "$(gate "$S1" oben 101 r3 1000 28 | JX "d['faixa']+'/'+d['motivo']")" "vermelho/piso_vencido_60d"
  limpa
  titulos "oben:101:60:500"
  eq "F9 ACL das 3 funções inalterado" "$(Pq -c "SELECT string_agg(coalesce(proacl::text,'-'), '|' ORDER BY oid) FROM pg_proc WHERE oid IN ($FNS);")" "$ACL_ANTES"
  limpa
}

echo "· controle: ANTES da migration a fronteira é estrita (60 d passa)"
titulos "oben:101:60:500"
eq "C0 antes: 60 d → não bloqueia" "$(piso "$S1" oben 101 | J "['bloqueado']")" "False"
limpa

echo "· aplica a migration (transação única, como o db:aplicar)"
if P -q -1 -f "$MIGF" > "$SAB/a.log" 2>&1; then ok "A0 migration aplica (guarda + 3 replaces + pós-condição)"; else bad "A0 migration falhou: $(head -c 400 "$SAB/a.log")"; fi
asserts

# ════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (espelho em $SAB; nunca supabase/migrations/; controle verde na MESMA invocação)
# ════════════════════════════════════════════════════════════════════════
echo "· falsificação"
[ "$FAIL" = 0 ] || { echo "controle vermelho: falsificação não roda"; exit 1; }
espelho() { python3 - "$MIGF" "$SAB/m.sql" "$@" <<'PY'
import sys
src, dst, *ops = sys.argv[1:]
t = open(src).read()
for op in ops:
    if op == 'sem_pos':
        i = t.index('DO $pos$'); t = t[:i]
    elif op == 'grupo_estrito':   # desfaz SÓ no piso (1º bloco CREATE)
        a = t.index('CREATE OR REPLACE FUNCTION public.venda_gate_credito_grupo')
        b = t.index('$function$;', a)
        t = t[:a] + t[a:b].replace('data_vencimento <= v_corte', 'data_vencimento < v_corte') + t[b:]
    elif op == 'reserva_estrita':   # desfaz SÓ na privada do PR 2
        a = t.index('CREATE OR REPLACE FUNCTION private.credito_avaliar_reservar')
        b = t.index('$function$;', a)
        t = t[:a] + t[a:b].replace('data_vencimento <= v_corte', 'data_vencimento < v_corte') + t[b:]
    elif op == 'um_estrito':
        t = t.replace('data_vencimento <= v_corte', 'data_vencimento < v_corte', 1)
    else:
        raise SystemExit('op desconhecida ' + op)
open(dst, 'w').write(t)
PY
}

restaura
espelho sem_pos grupo_estrito
P -q -1 -f "$SAB/m.sql" >/dev/null 2>&1
F0=$FAIL; QUIETO=1; asserts; QUIETO=0; D=$((FAIL-F0)); FAIL=$F0
if [ "$D" -gt 0 ]; then ok "S1 piso de volta a < (sem pós-condição) → asserts VERMELHOS ($D)"; else bad "S1 sabotagem do piso passou verde"; fi

restaura
espelho sem_pos reserva_estrita
P -q -1 -f "$SAB/m.sql" >/dev/null 2>&1
F0=$FAIL; QUIETO=1; asserts; QUIETO=0; D=$((FAIL-F0)); FAIL=$F0
if [ "$D" -gt 0 ]; then ok "S3 SÓ o PR 2 de volta a < (piso inclusivo) → asserts VERMELHOS ($D)"; else bad "S3 sabotagem isolada do PR 2 passou verde"; fi

restaura
espelho um_estrito
if P -q -1 -f "$SAB/m.sql" > "$SAB/s2.log" 2>&1; then bad "S2 pós-condição não pegou 1 comparação estrita"
elif grep -q "POSCONDICAO fronteira-60: sobrou" "$SAB/s2.log"; then ok "S2 1 comparação estrita → pós-condição aborta"
else bad "S2 outro erro: $(head -c 300 "$SAB/s2.log")"; fi
eq "S2b rollback: piso segue estrito" "$(titulos "oben:101:60:500"; piso "$S1" oben 101 | J "['bloqueado']")" "False"

restaura
# drift: o corpo da v1 em "prod" difere do pre-flight (mesma assinatura, outro corpo)
P -q -c "CREATE OR REPLACE FUNCTION public.venda_gate_credito(p_company text, p_codigo bigint, p_sales_order_id uuid) RETURNS jsonb LANGUAGE sql AS \$f\$ SELECT '{}'::jsonb \$f\$;"
if P -q -1 -f "$MIGF" > "$SAB/g.log" 2>&1; then bad "G guarda não pegou drift"
elif grep -q "GUARDA fronteira-60: corpo de public.venda_gate_credito" "$SAB/g.log"; then ok "G corpo de prod diferente do pre-flight → guarda aborta"
else bad "G outro erro: $(head -c 300 "$SAB/g.log")"; fi

restaura
echo "── re-prova pós-restauração ──"
P -q -1 -f "$MIGF" >/dev/null
asserts

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "PROVA-CREDITO-GATE-FRONTEIRA-60-OK"
