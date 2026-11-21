#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Crédito-IA PR 2: limite do grupo, reserva, decisão, aprovação   ║
# ║  Migration: 20261121160000_credito_limite_reserva_decisao.sql                 ║
# ║  Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9/§10          ║
# ║  Rode: bash db/test-credito-limite-reserva.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-limite-reserva.sh      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5539}"
SLUG="credito-limite-reserva"
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

# ── corrida: 2 sessões de verdade. A segura a transação; o orquestrador OBSERVA B bloqueada. ──
# saída: "<faixa B>|<bloqueio observado 0/1>|<R$ em reservas ativas>|<B terminou com A aberta 0/1>"
corrida() {
  limpa; limite "$C" 10000 28 baixo >/dev/null
  rm -f "$SAB"/a.out "$SAB"/b.out "$SAB"/b.done "$SAB"/b.rc "$SAB"/a.fifo; mkfifo "$SAB/a.fifo"
  "${PSQL[@]}" -tA -q < "$SAB/a.fifo" > "$SAB/a.out" 2>&1 &
  local apsql=$!
  exec 3>"$SAB/a.fifo"
  echo "SELECT 'PID:' || pg_backend_pid();" >&3
  echo "BEGIN;" >&3
  echo "SELECT 'A:' || (public.t_gate('$S1','oben',101,'r1',7000,28) ->> 'faixa');" >&3
  local i=0; until grep -q '^A:' "$SAB/a.out" 2>/dev/null; do i=$((i+1)); [ $i -gt 200 ] && break; sleep 0.05; done
  local apid; apid=$(grep '^PID:' "$SAB/a.out" | cut -d: -f2)
  ( rcb=0; Pq -c "SELECT 'B:' || (public.t_gate('$S2','colacor_sc',202,'r1',7000,28) ->> 'faixa');" > "$SAB/b.out" 2>&1 || rcb=$?; echo "$rcb" > "$SAB/b.rc"; touch "$SAB/b.done" ) &
  local bjob=$! bloq=0 n
  for i in $(seq 1 100); do
    n=$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE $apid = ANY(pg_blocking_pids(pid));")
    if [ "$n" -ge 1 ]; then bloq=1; break; fi
    [ -f "$SAB/b.done" ] && break
    sleep 0.05
  done
  local b_antes=0; [ -f "$SAB/b.done" ] && b_antes=1
  echo "COMMIT;" >&3; exec 3>&-
  local rca=0; wait "$apsql" || rca=$?; wait "$bjob" || true
  echo "$(grep -o 'B:[a-z]*' "$SAB/b.out" | cut -d: -f2)|$bloq|$(ativas)|$b_antes|$(grep -o 'A:[a-z]*' "$SAB/a.out" | cut -d: -f2)|$rca|$(cat "$SAB/b.rc")"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (função: a falsificação re-roda alvos do MESMO conjunto)
# ══════════════════════════════════════════════════════════════════════════════
asserts() {
  local g s

  echo "· concorrência"
  eq "C1 2×R\$7k com R\$10k em 2 sessões → A verde, B amarelo, B bloqueada OBSERVADA, R\$7k reservados" \
     "$(corrida)" "amarelo|1|7000|0|verde|0|0"

  echo "· faixas"
  limpa
  g=$(gate "$S1" oben 101 r1 7000 28)
  eq "D1 sem limite → amarelo sem_limite" "$(echo "$g" | J "['motivo']")" "sem_limite"
  eq "D1b … e abre solicitação" "$(echo "$g" | J "['solicitacao_id'] is not None")" "True"
  limite "$C" 10000 28 baixo >/dev/null
  g=$(gate "$S1" oben 101 r1 7000 28)
  eq "D2 dentro do limite → verde" "$(echo "$g" | J "['motivo']")" "dentro_limite"
  eq "D2b reserva R\$7k" "$(ativas)" "7000"
  eq "D3 2º pedido de R\$7k no ALIAS (colacor_sc) soma no grupo → estoura" "$(gate "$S2" colacor_sc 202 r1 7000 28 | J "['motivo']")" "estoura_limite"
  eq "D3b grupo D independente não é afetado" "$(limite "$D" 5000 28 baixo >/dev/null; gate "$S3" oben 501 r1 4000 28 | J "['faixa']")" "verde"

  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "colacor_sc:202:-10:5000:A VENCER"
  eq "D4 título aberto do alias (5k) + pedido 6k > 10k → estoura" "$(gate "$S1" oben 101 r1 6000 28 | J "['motivo']")" "estoura_limite"
  eq "D4b título 5k + pedido 4k → verde" "$(gate "$S1" oben 101 r2 4000 28 | J "['faixa']")" "verde"

  limpa; limite "$C" 10000 28 baixo >/dev/null
  titulos "oben:101:-5:NULL:A VENCER"
  eq "D5 título a vencer com saldo NULL → exposicao_indeterminada (ausente ≠ zero)" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "exposicao_indeterminada"
  titulos "colacor_sc:202:70:NULL"
  g=$(gate "$S1" oben 101 r1 1000 28)
  eq "D5b vencido 70 d com saldo NULL → piso_indeterminado" "$(echo "$g" | J "['motivo']")" "piso_indeterminado"
  eq "D5c … pendência cadastral não vai à fila" "$(echo "$g" | J "[\"solicitacao_id\"]")" "None"

  titulos "colacor:601:-5:100:A VENCER"
  titulos "oben:101:75:300:PAGTO PARCIAL"
  eq "D6 PAGTO PARCIAL vencido 75 d (piso do PR 1 não lê) → vermelho" "$(gate "$S1" oben 101 r1 1000 28 | J "['faixa']")" "vermelho"
  titulos "oben:101:-5:9500:PAGTO PARCIAL"
  eq "D6b PAGTO PARCIAL a vencer entra na exposição (9,5k + 1k > 10k)" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "estoura_limite"
  titulos "oben:999:75:300:PAGTO PARCIAL"
  eq "D6c PAGTO PARCIAL vencido num par SEM dono → vermelho (não sem_grupo)" "$(gate "$S1" oben 999 r1 1000 28 | J "['faixa']")" "vermelho"
  titulos "colacor_sc:202:75:300"
  g=$(gate "$S1" oben 101 r1 1000 28)
  eq "D7 piso (vencido > 60 d no grupo) → vermelho piso_vencido_60d" "$(echo "$g" | J "['motivo']")" "piso_vencido_60d"
  eq "D7b vermelho não abre solicitação" "$(echo "$g" | J "['solicitacao_id']")" "None"
  titulos

  eq "D8 prazo NULL → prazo_ilegivel" "$(gate "$S1" oben 101 r1 1000 NULL | J "['motivo']")" "prazo_ilegivel"
  eq "D8b prazo 35 > 28 → prazo_acima" "$(gate "$S1" oben 101 r1 1000 35 | J "['motivo']")" "prazo_acima"
  limite "$C" 10000 28 alto >/dev/null
  eq "D9 risco alto → amarelo mesmo dentro do limite" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "risco_alto"
  limite "$C" 10000 28 baixo "now() - interval '15 days'" >/dev/null
  eq "D10 ficha > 14 d → limite_desatualizado" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "limite_desatualizado"
  limite "$C" 10000 28 baixo >/dev/null
  Pq -c "INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$C','colacor',105);" >/dev/null
  eq "D11 composição do grupo mudou desde a aprovação → grupo_mudou" "$(gate "$S1" oben 101 r1 1000 28 | J "['motivo']")" "grupo_mudou"

  limpa
  g=$(gate "$S1" oben 999 r1 1000 28)
  eq "D12 par sem dono → sem_grupo" "$(echo "$g" | J "['motivo']")" "sem_grupo"
  eq "D12b … pendência cadastral, sem solicitação" "$(echo "$g" | J "[\"pendencia_cadastral\"], d[\"solicitacao_id\"]")" "(True, None)"
  eq "D12c grupo com alias CONFLICT → grupo_conflito" "$(gate "$S1" colacor 601 r1 1000 28 | J "['motivo']")" "grupo_conflito"

  limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
  Pq -c "UPDATE public.omie_customer_account_map SET omie_codigo_cliente = 107 WHERE omie_codigo_cliente = 101;" >/dev/null
  limite "$C" 10000 28 baixo >/dev/null
  eq "D13 troca do código Omie (101→107) não some com a reserva ativa → estoura" "$(gate "$S2" oben 107 r1 7000 28 | J "['motivo']")" "estoura_limite"
  Pq -c "UPDATE public.omie_customer_account_map SET omie_codigo_cliente = 101 WHERE omie_codigo_cliente = 107;" >/dev/null

  echo "· não finito"
  eq "N1 proposta com limite NaN → 23514" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_propor_limite('$C','NaN',28,'baixo',NULL,'{}'::jsonb,NULL,NULL,'m','v',now(),public.credito_grupo_assinatura('$C'),NULL)\$q\$);")" "23514"
  eq "N1b proposta com limite Infinity → 23514" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_propor_limite('$C','Infinity',28,'baixo',NULL,'{}'::jsonb,NULL,NULL,'m','v',now(),public.credito_grupo_assinatura('$C'),NULL)\$q\$);")" "23514"
  eq "N2 pedido de valor Infinity → 22023" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_gate('$S3','oben',101,'r9','Infinity',28)\$q\$);")" "22023"

  echo "· retry, edição, modo"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  gate "$S1" oben 101 r1 7000 28 >/dev/null
  eq "E1 retry da mesma revisão → reserva_existente" "$(gate "$S1" oben 101 r1 7000 28 | J "['motivo']")" "reserva_existente"
  eq "E1b … sem reserva duplicada" "$(ativas)" "7000"
  eq "E2 edição r2 R\$9k (acréscimo cabe) → verde" "$(gate "$S1" oben 101 r2 9000 28 | J "['faixa']")" "verde"
  eq "E2b … r1 substituída, ativa = R\$9k" "$(ativas)|$(Pq -c "SELECT status FROM public.credito_reserva WHERE revisao='r1';")" "9000|substituida"
  eq "E3 edição r3 R\$12k → estoura" "$(gate "$S1" oben 101 r3 12000 28 | J "['motivo']")" "estoura_limite"
  eq "E3b … 🟡 na edição mantém a reserva r2 intacta" "$(ativas)" "9000"
  eq "E4 edição r4 que REDUZ para R\$5k → verde" "$(gate "$S1" oben 101 r4 5000 28 | J "['faixa']")" "verde"
  eq "E4b … reserva fica no maior (R\$9k) até o Omie confirmar" "$(ativas)" "9000"
  eq "E5 revisão superada (r1) não volta a reservar → P0001" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_gate('$S1','oben',101,'r1',7000,28)\$q\$);")" "P0001"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  gate "$S1" oben 101 r1 7000 28 sombra >/dev/null
  eq "E6 reserva SOMBRA não ocupa o limite efetivo" "$(gate "$S2" oben 101 r1 7000 28 | J "['faixa']")" "verde"
  eq "E6b sombra 🟡 não abre solicitação" "$(gate "$S3" oben 101 r1 7000 28 sombra | J "['motivo'], d['solicitacao_id']")" "('estoura_limite', None)"
  eq "E7 exige READ COMMITTED (REPEATABLE READ → 25000)" \
     "$(Pq -c "BEGIN ISOLATION LEVEL REPEATABLE READ;" -c "SELECT public.t_try(\$q\$SELECT public.t_gate('$S3','oben',101,'r9',1,28)\$q\$);" -c "ROLLBACK;" | tail -1)" "25000"
  eq "E8 valor 0 → 22023" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_gate('$S3','oben',101,'r9',0,28)\$q\$);")" "22023"

  echo "· solicitar ≠ autorizar"
  limpa; limite "$C" 10000 28 baixo >/dev/null
  gate "$S1" oben 101 r1 7000 28 >/dev/null
  local sol; sol=$(gate "$S2" oben 101 r1 7000 28 | J "['solicitacao_id']")
  eq "S1 repetir o gate com a solicitação aberta segue 🟡 (solicitar não autoriza)" "$(gate "$S2" oben 101 r1 7000 28 | J "['faixa']")" "amarelo"
  eq "S1b … uma solicitação aberta só" "$(Pq -c "SELECT count(*) FROM public.credito_solicitacao WHERE sales_order_id='$S2';")" "1"
  eq "S2 M2 (master FORA da allowlist) autoriza → 42501" "$(como "$M2" "SELECT public.credito_autorizar_solicitacao('$sol', true, 'ok pra mim')")" "42501"
  eq "S2b gestor autoriza → 42501" "$(como "$G" "SELECT public.credito_autorizar_solicitacao('$sol', true, 'ok pra mim')")" "42501"
  eq "S2c sem JWT (uid nulo) → 42501" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_autorizar_solicitacao('$sol', true, 'ok')\$q\$);")" "42501"
  eq "S3 Lucas autoriza" "$(como "$L" "SELECT public.credito_autorizar_solicitacao('$sol', true, 'cliente bom pagador')")" "OK"
  eq "S3b autorizar 2× → P0001" "$(como "$L" "SELECT public.credito_autorizar_solicitacao('$sol', true, 'de novo')")" "P0001"
  eq "S4 autorização não cobre valor maior" "$(gate "$S2" oben 101 r1 7500 28 | J "['faixa']")" "amarelo"
  eq "S4b autorização não cobre revisão nova" "$(gate "$S2" oben 101 r2 7000 28 | J "['faixa']")" "amarelo"
  titulos "colacor_sc:202:75:300"
  eq "S5 autorização não cobre o piso" "$(gate "$S2" oben 101 r1 7000 28 | J "['faixa']")" "vermelho"
  titulos "colacor_sc:202:70:NULL"
  eq "S5b autorização não pula piso indeterminado" "$(gate "$S2" oben 101 r1 7000 28 | J "['motivo']")" "piso_indeterminado"
  titulos
  eq "S6 com a autorização → verde autorizado" "$(gate "$S2" oben 101 r1 7000 28 | J "['motivo']")" "autorizado"
  eq "S6b … e reserva acima do limite (R\$14k)" "$(ativas)" "14000"
  Pq -c "SELECT public.t_forca('UPDATE public.credito_autorizacao SET valido_ate = now() - interval ''1 minute''');" >/dev/null
  eq "S7 autorização vencida: retry não reusa a reserva dela" "$(gate "$S2" oben 101 r1 7000 28 | J "['motivo']")" "estoura_limite"

  # autorização de r1 não vira crédito para r2 (Codex diff P1-5)
  limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
  s=$(gate "$S2" oben 101 r1 7000 14 | J "['solicitacao_id']")
  como "$L" "SELECT public.credito_autorizar_solicitacao('$s', true, 'só r1')" >/dev/null
  gate "$S2" oben 101 r1 7000 14 >/dev/null
  eq "S8 r2 (mesmo valor, prazo maior) NÃO herda a autorização de r1 → estoura" "$(gate "$S2" oben 101 r2 7000 28 | J "['motivo']")" "estoura_limite"
  # revisão reavaliada continua retentável (Codex diff P1-6)
  Pq -c "SELECT public.t_forca('UPDATE public.credito_autorizacao SET valido_ate = now() - interval ''1 minute''');" >/dev/null
  limite "$C" 20000 28 baixo >/dev/null
  eq "S9 r1 com autorização vencida e limite maior → reavaliada dentro_limite" "$(gate "$S2" oben 101 r1 7000 14 | J "['motivo']")" "dentro_limite"
  eq "S9b retry de r1 → reserva_existente (não P0001)" "$(gate "$S2" oben 101 r1 7000 14 | J "['motivo']")" "reserva_existente"

  echo "· aprovação de limite (allowlist)"
  limpa
  local p1 p2
  p1=$(Pq -c "SELECT public.credito_propor_limite('$C',10000,28,'baixo',0.9,'{}'::jsonb,NULL,NULL,'m','v1',now(),public.credito_grupo_assinatura('$C'),NULL);")
  p2=$(Pq -c "SELECT public.credito_propor_limite('$C',20000,28,'baixo',0.9,'{}'::jsonb,NULL,NULL,'m','v1',now(),public.credito_grupo_assinatura('$C'),NULL);")
  eq "A1 M2 (master FORA da allowlist) aprova → 42501" "$(como "$M2" "SELECT public.credito_aprovar_proposta('$p1')")" "42501"
  eq "A1b gestor aprova → 42501" "$(como "$G" "SELECT public.credito_aprovar_proposta('$p1')")" "42501"
  eq "A1c sem JWT → 42501" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_aprovar_proposta('$p1')\$q\$);")" "42501"
  eq "A1d M2 recusa → 42501" "$(como "$M2" "SELECT public.credito_recusar_proposta('$p1','não quero')")" "42501"
  eq "A2 Lucas aprova" "$(como "$L" "SELECT public.credito_aprovar_proposta('$p1')")" "OK"
  eq "A2b limite vigente v1 = 10k" "$(Pq -c "SELECT versao||':'||limite_brl::bigint FROM public.credito_limite WHERE grupo_user_id='$C';")" "1:10000"
  eq "A3 proposta com versão-base velha → proposta_desatualizada (P0001)" "$(como "$L" "SELECT public.credito_aprovar_proposta('$p2')")" "P0001"
  eq "A3b aprovar a mesma 2× → P0001" "$(como "$L" "SELECT public.credito_aprovar_proposta('$p1')")" "P0001"
  eq "A4 recusar sem motivo → 22023" "$(como "$L" "SELECT public.credito_recusar_proposta('$p2','')")" "22023"
  eq "A5 sou_aprovador: Lucas t · M2 f" "$(comoval "$L" "SELECT public.credito_sou_aprovador();")·$(comoval "$M2" "SELECT public.credito_sou_aprovador();")" "t·f"
  eq "A6 proposta para ALIAS → 22023" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_propor_limite('$A1',1,28,'baixo',NULL,'{}'::jsonb,NULL,NULL,'m','v',now(),'x',NULL)\$q\$);")" "22023"
  eq "A6b versão-base do futuro → 22023" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.credito_propor_limite('$C',1,28,'baixo',NULL,'{}'::jsonb,NULL,NULL,'m','v',now(),'x',7)\$q\$);")" "22023"

  echo "· RLS e escrita direta"
  gate "$S1" oben 101 r1 1000 28 >/dev/null
  eq "R1 gestor lê decisões" "$(comoval "$G" "SELECT count(*) > 0 FROM public.credito_decisao_pedido;")" "t"
  eq "R1b vendedor (operacional) lê 0" "$(comoval "$V" "SELECT count(*) FROM public.credito_decisao_pedido;")" "0"
  eq "R1c customer lê 0" "$(comoval "$U" "SELECT count(*) FROM public.credito_limite;")" "0"
  eq "R1d anon não lê (42501)" "$(comorole anon "SELECT 1 FROM public.credito_limite")" "42501"
  eq "R1e authenticated não lê a allowlist (42501)" "$(como "$L" "SELECT 1 FROM public.credito_aprovador")" "42501"
  eq "R2 master grava limite direto → 42501" "$(como "$L" "UPDATE public.credito_limite SET limite_brl = 999999")" "42501"
  eq "R2b master se inclui na allowlist → 42501" "$(como "$M2" "INSERT INTO public.credito_aprovador VALUES ('$M2','eu')")" "42501"
  eq "R3 service_role insere decisão direto → 42501" "$(comorole service_role "INSERT INTO public.credito_decisao_pedido(id,sales_order_id,company,modo,revisao,valor_brl,faixa,motivo,piso) VALUES (gen_random_uuid(),'$S3','oben','efetivo','x',1,'verde','dentro_limite','{}')")" "42501"
  eq "R3b service_role apaga reserva → 42501" "$(comorole service_role "DELETE FROM public.credito_reserva")" "42501"
  eq "R4 TRIGGER (papel com DML) insere decisão sem portão → 42501" "$(comorole escritor_teste "INSERT INTO public.credito_decisao_pedido(id,sales_order_id,company,modo,revisao,valor_brl,faixa,motivo,piso) VALUES (gen_random_uuid(),'$S3','oben','efetivo','x',1,'verde','dentro_limite','{}')")" "42501"
  eq "R4b TRIGGER: UPDATE de decisão (append-only) → 42501" "$(comorole escritor_teste "UPDATE public.credito_decisao_pedido SET faixa='verde'")" "42501"
  eq "R4c TRIGGER: valor da reserva não muda → 42501" "$(comorole escritor_teste "UPDATE public.credito_reserva SET valor_brl = 1")" "42501"
  eq "R4d TRIGGER: TRUNCATE → 42501" "$(comorole escritor_teste "TRUNCATE public.credito_decisao_pedido CASCADE")" "42501"
  eq "R4e TRIGGER: master na allowlist via DML → 42501" "$(comorole escritor_teste "INSERT INTO public.credito_aprovador VALUES ('$M2','eu')")" "42501"

  eq "R4f TRIGGER: DELETE da trilha mesmo COM portão → 42501" "$(comorole escritor_teste "SELECT pg_catalog.set_config('credito.portao', (SELECT id::text FROM public.credito_decisao_pedido LIMIT 1), false); DELETE FROM public.credito_decisao_pedido WHERE id = (SELECT id FROM public.credito_decisao_pedido LIMIT 1)")" "42501"
  eq "R5 papel do builder (sandbox_exec, BYPASSRLS) insere limite → 42501" "$(comorole sandbox_exec_teste "INSERT INTO public.credito_limite VALUES ('$D',100000,28,'baixo',1,'x',now(),(SELECT id FROM public.credito_limite_proposta LIMIT 1),'$L',now())")" "42501"
  eq "R5b … nem executa a proposta/aprovação" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_teste','public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamptz,text,integer)','EXECUTE')::text || has_function_privilege('sandbox_exec_teste','public.credito_aprovar_proposta(uuid,text)','EXECUTE')::text;")" "falsefalse"

  echo "· ACL"
  local f
  f="private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)"
  eq "X1 ninguém executa o núcleo do gate (anon/authenticated/service_role)" \
     "$(Pq -c "SELECT has_function_privilege('anon','$f','EXECUTE')::text||has_function_privilege('authenticated','$f','EXECUTE')::text||has_function_privilege('service_role','$f','EXECUTE')::text;")" "falsefalsefalse"
  for f in "public.credito_grupo_raiz(text,bigint)" "public.credito_grupo_assinatura(uuid)" \
           "public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamptz,text,integer)"; do
    eq "X2 só service_role: $f" "$(Pq -c "SELECT has_function_privilege('anon','$f','EXECUTE')::text||has_function_privilege('authenticated','$f','EXECUTE')::text||has_function_privilege('service_role','$f','EXECUTE')::text;")" "falsefalsetrue"
  done
  for f in "public.credito_aprovar_proposta(uuid,text)" "public.credito_autorizar_solicitacao(uuid,boolean,text,integer)"; do
    eq "X3 authenticated (com gate), não anon: $f" "$(Pq -c "SELECT has_function_privilege('anon','$f','EXECUTE')::text||has_function_privilege('authenticated','$f','EXECUTE')::text;")" "falsetrue"
  done
  eq "X5 isca de outra feature (credito_vinculo_aviso) intacta" "$(Pq -c "SELECT has_function_privilege('authenticated','public.credito_vinculo_aviso(text)','EXECUTE')::text||has_function_privilege('sandbox_exec_teste','public.credito_vinculo_aviso(text)','EXECUTE')::text;")" "truetrue"
  eq "X4 allowlist = {Lucas}" "$(Pq -c "SELECT string_agg(user_id::text, ',') FROM public.credito_aprovador;")" "$L"
}

echo "── asserts (controle) ──"
asserts
if [ "$FAIL" != "0" ]; then
  echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ HARNESS VERMELHO (controle) — falsificação não roda"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (uma camada por vez; controle verde acima na MESMA invocação)
# Cada sabotagem aplica uma cópia adulterada da migration, exige o assert-alvo VERMELHO,
# e re-aplica a migration real.
# ══════════════════════════════════════════════════════════════════════════════
sabota() { # $1 rótulo · $2 python que transforma o texto · $3 comando do assert-alvo · $4 valor que o assert SÃO exige
  python3 - "$MIG" "$SAB/m.sql" "$2" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read(); n = eval(expr)
assert n != t, "sabotagem não alterou o texto"
open(dst, "w").write(n)
PY
  # a MESMA sabotagem na cópia de credito_avaliar_reservar da MIGN (sem exigir mudança: o alvo pode
  # ser de outra função) — senão a MIGN reinstala a definição sã por cima do mutante
  python3 - "$MIGN" "$SAB/n.sql" "$2" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read(); open(dst, "w").write(eval(expr))
PY
  P -q -f "$SAB/m.sql"; P -q -f "$SAB/n.sql"; grant_escritor
  local v; v=$(eval "$3")
  if [ -n "${5:-}" ] && [ "$v" != "$5" ]; then bad "$1 → mutante saiu [$v], esperado exatamente [$5]"
  elif [ "$v" != "$4" ]; then ok "$1 → assert-alvo ficou vermelho (veio $v)"; else bad "$1 → sabotei e o assert continuou verde ($v): sem dente"; fi
  aplica_real
}

echo "── falsificação ──"
sabota "F1 sem advisory lock no gate → a corrida dá 2 🟢 (R\$14k)" \
  "t.replace(\"    PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_root::text, 0));\n\", \"\")" \
  "corrida" "amarelo|1|7000|0|verde|0|0" "verde|0|14000|1|verde|0|0"

limpa
P1=$(Pq -c "SELECT public.credito_propor_limite('$C',10000,28,'baixo',0.9,'{}'::jsonb,NULL,NULL,'m','v1',now(),public.credito_grupo_assinatura('$C'),NULL);")
sabota "F2 aprovação sem allowlist → master estranho aprova" \
  "t.replace(\"AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN\n    RAISE EXCEPTION 'credito_aprovar_proposta\", \") THEN\n    RAISE EXCEPTION 'credito_aprovar_proposta\")" \
  "como '$M2' \"SELECT public.credito_aprovar_proposta('$P1')\"" "42501"

limpa; limite "$C" 10000 28 baixo >/dev/null; titulos "oben:101:-5:NULL:A VENCER"
sabota "F3 saldo NULL tratado como zero → indeterminado vira 🟢" \
  "t.replace(\"         count(*) FILTER (WHERE f.saldo IS NULL),\n\", \"         0,\n\")" \
  "gate '$S1' oben 101 r1 1000 28 | J \"['motivo']\"" "exposicao_indeterminada"

limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
sabota "F4 exposição sem as reservas → 2º pedido de 7k passa" \
  "t.replace(\"       AND NOT (r.sales_order_id = p_sales_order_id AND r.company = p_company);\", \"       AND false;\")" \
  "gate '$S2' oben 101 r1 7000 28 | J \"['motivo']\"" "estoura_limite"

sabota "F5 trigger sem portão → papel com DML grava decisão direto" \
  "t.replace(\"IF v_portao IS NULL OR v_portao IS DISTINCT FROM (v_linha ->> TG_ARGV[0]) THEN\", \"IF false THEN\")" \
  "comorole escritor_teste \"INSERT INTO public.credito_decisao_pedido(id,sales_order_id,company,modo,revisao,valor_brl,faixa,motivo,piso) VALUES (gen_random_uuid(),'$S3','oben','efetivo','x',1,'verde','dentro_limite','{}')\"" "42501"

# F6: escrita de um grantee fora da allowlist esquecida → a POSTCONDIÇÃO aborta, e no envelope
# (transação única, como o db:aplicar) NADA fica: o índice derrubado antes continua ausente.
python3 - "$MIG" "$SAB/m.sql" <<'PY2'
import sys
t = open(sys.argv[1]).read()
a = "WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP"
assert t.count(a) == 1, "alvo F6 ausente"
open(sys.argv[2], "w").write(t.replace(a, a.replace(" LOOP", " AND a.grantee::regrole::text <> 'service_role' LOOP")))
PY2
Pq -c "GRANT INSERT ON public.credito_limite TO service_role; DROP INDEX public.credito_solicitacao_uma_aberta;" >/dev/null
if P -1 -q -f "$SAB/m.sql" > "$SAB/f6.log" 2>&1; then
  bad "F6 grant esquecido → a migration APLICOU (postcondição sem dente)"
elif grep -q "POS FALHOU: service_role escreve direto em credito_limite" "$SAB/f6.log"; then
  ok "F6 grant esquecido → postcondição abortou a aplicação"
else
  bad "F6 falhou por OUTRO motivo: $(head -c 300 "$SAB/f6.log")"
fi
eq "F6b … rollback do envelope: o índice derrubado segue ausente" "$(Pq -c "SELECT to_regclass('public.credito_solicitacao_uma_aberta') IS NULL;")" "t"
aplica_real

autorizado_cenario() { # S2 🟡 → Lucas autoriza; devolve nada
  limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
  local s; s=$(gate "$S2" oben 101 r1 7000 28 | J "['solicitacao_id']")
  como "$L" "SELECT public.credito_autorizar_solicitacao('$s', true, 'cliente bom')" >/dev/null
}
autorizado_cenario; titulos "colacor_sc:202:70:NULL"
# Desde 20261121200000 o PISO também segura saldo NULL; a contagem do PR 2 só é a barreira ÚNICA quando
# o piso libera por exceção do (pedido, par) → o cenário do F7 tem essa exceção (senão é redundante),
# aprovada DEPOIS de um bloqueio pós-virada (senão o piso a recusa por indeterminado — 20261121200000).
Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_bloqueio_credito_log (company, omie_codigo_cliente, sales_order_id, acao, created_at) VALUES ('oben', 101, '$S2', 'bloqueado', now() - interval '1 second')\$q\$);" >/dev/null
Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_excecao_credito (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por) VALUES ('$S2', 'oben', 101, 'teste', now() + interval '3 days', '$G')\$q\$);" >/dev/null
sabota "F7 piso indeterminado depois da autorização → autorização libera" \
  "t.replace(\"  ELSIF v_piso_indet > 0 THEN\", \"  ELSIF false THEN\").replace(\"  ELSIF v_piso_indet > 0\n\", \"  ELSIF false\n\")" \
  "gate '$S2' oben 101 r1 7000 28 | J \"['motivo']\"" "piso_indeterminado"

limpa; limite "$C" 10000 28 baixo >/dev/null; titulos "oben:101:75:300" "colacor_sc:202:75:300:PAGTO PARCIAL"
# bloqueio pós-virada ANTES da aprovação: o piso (20261121200000) aceita a exceção p/ o parcial; só o
# fora_piso do PR 2 segura — a divergência declarada (vendas libera, PR 2 vermelho)
Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_bloqueio_credito_log (company, omie_codigo_cliente, sales_order_id, acao, created_at) VALUES ('oben', 101, '$S1', 'bloqueado', now() - interval '1 second')\$q\$);" >/dev/null
Pq -c "SELECT public.t_forca(\$q\$INSERT INTO public.venda_excecao_credito (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por) VALUES ('$S1','oben',101,'gestor viu o ATRASADO', now() + interval '1 day', '$G')\$q\$);" >/dev/null
sabota "F8 sem o vencido fora do vocabulário do piso → PAGTO PARCIAL vencido passa sob exceção" \
  "t.replace(\"     OR v_venc60_fora_piso > 0 \", \"     OR false \")" \
  "gate '$S1' oben 101 r1 1000 28 | J \"['faixa']\"" "vermelho"

autorizado_cenario; titulos; gate "$S2" oben 101 r1 7000 28 >/dev/null
Pq -c "SELECT public.t_forca('UPDATE public.credito_autorizacao SET valido_ate = now() - interval ''1 minute''');" >/dev/null
sabota "F9 reuso ignora a validade da autorização → retry libera com autorização vencida" \
  "t.replace(\"WHERE a.id = v_dec_res.autorizacao_id AND a.valido_ate > now());\", \"WHERE a.id = v_dec_res.autorizacao_id);\")" \
  "gate '$S2' oben 101 r1 7000 28 | J \"['motivo']\"" "estoura_limite"

limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 sombra >/dev/null
sabota "F10 reservas sem filtro de modo → sombra ocupa o efetivo" \
  "t.replace(\"     WHERE r.status = 'ativa' AND r.modo = p_modo\n\", \"     WHERE r.status = 'ativa'\n\")" \
  "gate '$S2' oben 101 r1 7000 28 | J \"['faixa']\"" "verde"

limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
Pq -c "UPDATE public.omie_customer_account_map SET omie_codigo_cliente = 107 WHERE omie_codigo_cliente = 101;" >/dev/null
limite "$C" 10000 28 baixo >/dev/null
sabota "F11 reservas só pelo par atual → troca de código some com a reserva" \
  "t.replace(\"       AND (r.grupo_user_id = v_root\n            OR EXISTS\", \"       AND (false\n            OR EXISTS\")" \
  "gate '$S2' oben 107 r1 7000 28 | J \"['motivo']\"" "estoura_limite"
Pq -c "UPDATE public.omie_customer_account_map SET omie_codigo_cliente = 101 WHERE omie_codigo_cliente = 107;" >/dev/null

limpa; limite "$C" 10000 28 baixo >/dev/null; gate "$S1" oben 101 r1 7000 28 >/dev/null
SOL=$(gate "$S2" oben 101 r1 7000 14 | J "['solicitacao_id']")
como "$L" "SELECT public.credito_autorizar_solicitacao('$SOL', true, 'só r1')" >/dev/null
gate "$S2" oben 101 r1 7000 14 >/dev/null
sabota "F12 reserva AUTORIZADA vira base de outra revisão → r2 passa dentro_limite" \
  "t.replace(\"      v_base := CASE WHEN v_lastro_limite THEN\", \"      v_base := CASE WHEN v_lastro_limite OR v_lastro_aut OR v_dec_res.motivo = 'autorizado' THEN\")" \
  "gate '$S2' oben 101 r2 7000 28 | J \"['motivo']\"" "estoura_limite"

echo "── re-prova pós-restauração ──"
asserts

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "FIM-OK"
