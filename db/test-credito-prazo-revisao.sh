#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Crédito-IA PR 3: prazo em dias + revisão imutável da operação  ║
# ║  Migration: 20261121180000_credito_prazo_revisao.sql                         ║
# ║  Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9/§10          ║
# ║  Rode: bash db/test-credito-prazo-revisao.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-prazo-revisao.sh      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5541}"
SLUG="credito-prazo-revisao"
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

CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text NOT NULL DEFAULT 'oben');
CREATE TABLE public.omie_condicao_pagamento_catalogo (empresa text NOT NULL, codigo text NOT NULL, descricao text,
  num_parcelas integer, dias_parcelas text, ativo boolean DEFAULT true, ultima_sincronizacao timestamptz, PRIMARY KEY (empresa, codigo));
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
# ZONA 2 — MIGRATIONS REAIS (PR 1 + PR 2 em prod; a nova é a sob prova)
# ══════════════════════════════════════════════════════════════════════════════
MIGS=("$REPO_ROOT/supabase/migrations/20260702233000_trava_credito_fase2.sql"
      "$REPO_ROOT/supabase/migrations/20260703140000_trava_credito_gate_excecao_por_par.sql"
      "$REPO_ROOT/supabase/migrations/20261121120000_trava_credito_piso_grupo.sql"
      "$REPO_ROOT/supabase/migrations/20261121160000_credito_limite_reserva_decisao.sql")
MIG="$REPO_ROOT/supabase/migrations/20261121180000_credito_prazo_revisao.sql"
for m in "${MIGS[@]}"; do P -q -f "$m"; done
P -q -f "$MIG"
P -q -f "$MIG"   # idempotente: re-colar não quebra
echo "migrations aplicadas: ${#MIGS[@]} antecedentes + $(basename "$MIG") (2×)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + helpers
# ══════════════════════════════════════════════════════════════════════════════
SO1=b0000000-0000-0000-0000-000000000001   # oben
SO2=b0000000-0000-0000-0000-000000000002   # colacor
SO3=b0000000-0000-0000-0000-000000000003   # oben (concorrência)
P -q <<SQL
INSERT INTO public.sales_orders(id, account) VALUES ('$SO1','oben'), ('$SO2','colacor'), ('$SO3','oben');
-- catálogo: grafias REAIS da OBEN (psql-ro 2026-11-21) + casos-limite; Colacor sem catálogo (como em prod)
INSERT INTO public.omie_condicao_pagamento_catalogo(empresa, codigo, descricao, num_parcelas, ativo) VALUES
  ('OBEN','A28','Para 28 dias',1,true), ('OBEN','S41','28/42/56',3,true), ('OBEN','000','A Vista',1,true),
  ('OBEN','999','Informar o número de parcelas',999,true), ('OBEN','V01','A Vista/30/60',3,true),
  ('OBEN','A30','Para 30 dias (C)',1,true), ('OBEN','003','3 Parcelas',3,true),
  ('OBEN','X01','Para 30 dias',NULL,true),   -- num_parcelas ausente: não prova
  ('OBEN','X02','30/60',3,true),             -- num_parcelas diverge
  ('OBEN','X03','Para 45 dias',1,false);     -- inativo

CREATE FUNCTION public.t_try(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END \$f\$;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO PUBLIC;
-- a edge: registra como service_role
CREATE FUNCTION public.t_rev(p_so uuid, p_co text, p_ctx text, p_cli bigint, p_parc text, p_orig text, p_itens jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE AS \$f\$
  SELECT public.credito_registrar_revisao(p_so, p_co, p_ctx, p_cli, p_parc, p_orig, p_itens, NULL) \$f\$;
-- o Lucas (ou outro) define override pela RPC, com claims
CREATE FUNCTION public.t_ov(p_uid uuid, p_co text, p_cod text, p_dias int, p_motivo text) RETURNS text
LANGUAGE plpgsql AS \$f\$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM public.credito_definir_prazo_override(p_co, p_cod, p_dias, p_motivo);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END \$f\$;
CREATE FUNCTION public.t_i1() RETURNS jsonb LANGUAGE sql IMMUTABLE AS \$f\$
  SELECT '[{"codigo_produto":101,"quantidade":2,"valor_unitario":10.5}]'::jsonb \$f\$;
CREATE FUNCTION public.t_limpa() RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS \$f\$
BEGIN DELETE FROM public.credito_operacao_revisao; DELETE FROM public.credito_prazo_override; END \$f\$;
SQL
P -q <<'SQL'
CREATE ROLE escritor_teste BYPASSRLS;
GRANT USAGE ON SCHEMA public TO escritor_teste;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO escritor_teste, sandbox_exec_teste;
SQL
# o papel de teste perde o DML a cada aplicação da migration (a allowlist o revoga — certo!):
# re-conceder DEPOIS de cada aplicação, senão o 42501 vem do privilégio e não do trigger.
grant_escritor() { P -q -c "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.credito_operacao_revisao, public.credito_prazo_override TO escritor_teste;"; }
grant_escritor
limpa() { Pq -c "SELECT public.t_limpa();" >/dev/null; }
I1='[{"codigo_produto":101,"quantidade":2,"valor_unitario":10.5}]'
# fixture de paridade → tabela (o esperado veio do parser TS)
python3 - "$REPO_ROOT/db/fixtures/credito-prazo-paridade.json" > "$SAB/fix.sql" <<'PY'
import json, sys
casos = json.load(open(sys.argv[1], encoding="utf-8"))["casos"]
q = lambda s: "'" + s.replace("'", "''") + "'"
print("CREATE TABLE public.t_fix (descricao text, esperado integer[]);")
print("INSERT INTO public.t_fix VALUES " + ",\n".join(
  "(%s, %s)" % (q(c["descricao"]), "NULL" if c["calendario"] is None else "ARRAY[%s]::integer[]" % ",".join(map(str, c["calendario"])))
  for c in casos) + ";")
PY
P -q -f "$SAB/fix.sql"

prazo()  { Pq -c "SELECT COALESCE(public.credito_prazo_dias($1)::text, 'NULL');"; }
motivo() { Pq -c "SELECT COALESCE(public.credito_prazo_resolver($1)->>'motivo', '-') || '/' || COALESCE(public.credito_prazo_resolver($1)->>'fonte', '-');"; }
rev()    { Pq -c "SELECT public.t_rev($1)::text;"; }
revj()   { Pq -c "SELECT public.t_rev($1) ->> '$2';"; }
tryas()  { # $1 papel · $2 uid ou '' · $3 sql → SQLSTATE ou OK
  Pq -c "SET ROLE $1; SELECT set_config('request.jwt.claims', '{\"sub\":\"$2\",\"role\":\"$1\"}', false); SELECT public.t_try(\$q\$$3\$q\$);" | tail -1; }
nrev()   { Pq -c "SELECT count(*) FROM public.credito_operacao_revisao;"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
asserts() {
  limpa
  echo "P1 paridade TS ↔ SQL"
  eq "P1.0 fixture carregada (não-vácuo)" "$(Pq -c "SELECT count(*) >= 150 FROM public.t_fix")" "t"
  eq "P1.1 divergências parser SQL × TS" "$(Pq -c "SELECT count(*) FROM public.t_fix WHERE public.credito_parse_calendario(descricao) IS DISTINCT FROM esperado")" "0"
  eq "P1.2 ilegível nunca vira [0]" "$(Pq -c "SELECT count(*) FROM public.t_fix WHERE esperado IS NULL AND public.credito_parse_calendario(descricao) IS NOT NULL")" "0"

  echo "P2 prazo por empresa (ausente ≠ zero)"
  eq "P2.1 A28 oben" "$(prazo "'A28','oben'")" "28"
  eq "P2.2 S41 28/42/56 → máximo" "$(prazo "'S41','oben'")" "56"
  eq "P2.3 000 à vista = 0 de verdade" "$(prazo "'000','oben'")" "0"
  eq "P2.4 999 (informar parcelas) → NULL" "$(prazo "'999','oben'")" "NULL"
  eq "P2.5 A Vista/30/60 → 60" "$(prazo "'V01','oben'")" "60"
  eq "P2.6 normaliza código e conta" "$(prazo "' A28 ',' OBEN '")" "28"
  eq "P2.7 Colacor sem catálogo → NULL" "$(prazo "'A28','colacor'")" "NULL"
  eq "P2.8 num_parcelas ausente → NULL" "$(motivo "'X01','oben'")" "num_parcelas_diverge/-"
  eq "P2.9 num_parcelas diverge → NULL" "$(prazo "'X02','oben'")" "NULL"
  eq "P2.10 inativo → fora do catálogo" "$(motivo "'X03','oben'")" "fora_do_catalogo/-"
  eq "P2.11 (C) ilegível" "$(motivo "'A30','oben'")" "descricao_ilegivel/-"
  eq "P2.12 N Parcelas ilegível" "$(prazo "'003','oben'")" "NULL"
  eq "P2.13 vazio → sem_parcela" "$(motivo "'','oben'")" "sem_parcela/-"
  eq "P2.14 NULL → NULL" "$(prazo "NULL,'oben'")" "NULL"
  eq "P2.15 empresa desconhecida" "$(motivo "'A28','xpto'")" "empresa_desconhecida/-"

  echo "P3 override (só o aprovador; append-only; versionado)"
  eq "P3.1 Lucas define colacor/A28=28" "$(Pq -c "SELECT public.t_ov('$L','colacor','A28',28,'catálogo Colacor ausente')")" "OK"
  eq "P3.2 colacor/A28 via override" "$(motivo "'A28','colacor'")" "-/override"
  eq "P3.3 Lucas define oben/A28=35 (override vence catálogo)" "$(Pq -c "SELECT public.t_ov('$L','oben','A28',35,'teste de precedência')"; prazo "'A28','oben'")" "OK
35"
  eq "P3.4 revoga oben/A28 → volta ao catálogo" "$(Pq -c "SELECT public.t_ov('$L','oben','A28',NULL,'revogação de teste')"; prazo "'A28','oben'")" "OK
28"
  eq "P3.5 versões monotônicas 1,2" "$(Pq -c "SELECT string_agg(versao::text, ',' ORDER BY versao) FROM public.credito_prazo_override WHERE company='oben' AND codigo_parcela='A28'")" "1,2"
  eq "P3.6 override de 999 vetado" "$(Pq -c "SELECT public.t_ov('$L','oben','999',30,'tentativa de 999')")" "22023"
  eq "P3.7 prazo 400 recusado" "$(Pq -c "SELECT public.t_ov('$L','oben','A14',400,'fora da faixa')")" "22023"
  eq "P3.8 motivo vazio recusado" "$(Pq -c "SELECT public.t_ov('$L','oben','A14',14,' ')")" "22023"
  eq "P3.9 master fora da allowlist → 42501" "$(Pq -c "SELECT public.t_ov('$M2','oben','A14',14,'master estranho')")" "42501"
  eq "P3.10 gestor → 42501" "$(Pq -c "SELECT public.t_ov('$G','oben','A14',14,'gestor tentando')")" "42501"
  eq "P3.11 service_role sem uid → 42501" "$(tryas service_role '' "SELECT public.credito_definir_prazo_override('oben','A14',14,'service sem uid')")" "42501"
  eq "P3.12 escrita direta (DML concedido) → trigger 42501" "$(tryas escritor_teste '' "INSERT INTO public.credito_prazo_override(company,codigo_parcela,versao,prazo_dias,motivo,criado_por) VALUES ('oben','Z1',1,1,'direto!','$L')")" "42501"
  eq "P3.13 builder sandbox_exec → sem privilégio" "$(tryas sandbox_exec_teste '' "INSERT INTO public.credito_prazo_override(company,codigo_parcela,versao,prazo_dias,motivo,criado_por) VALUES ('oben','Z1',1,1,'direto!','$L')")" "42501"
  eq "P3.14 UPDATE com portão aberto → append-only 42501" "$(tryas escritor_teste '' "SELECT set_config('credito.portao', (SELECT id::text FROM public.credito_prazo_override LIMIT 1), false); UPDATE public.credito_prazo_override SET prazo_dias = 90")" "42501"
  eq "P3.15 authenticated não executa credito_prazo_dias" "$(tryas authenticated "$G" "SELECT public.credito_prazo_dias('A28','oben')")" "42501"
  eq "P3.16 anon não executa o override" "$(tryas anon '' "SELECT public.credito_definir_prazo_override('oben','A14',14,'anon tentando')")" "42501"

  echo "P4 revisão imutável"
  limpa
  local r1; r1=$(rev "'$SO1','oben','criacao',101,'A28','informada','$I1'")
  eq "P4.1 1ª revisão seq 1, prazo 28, valor 21.00" "$(Pq -c "SELECT (j->>'seq')||'/'||(j->>'reusada')||'/'||(j->>'prazo_dias')||'/'||(j->>'valor_brl') FROM (SELECT '$r1'::jsonb j) x")" "1/false/28/21.00"
  eq "P4.2 retry idêntico reusa" "$(revj "'$SO1','oben','criacao',101,'A28','informada','$I1'" seq)/$(nrev)" "1/1"
  eq "P4.3 outro devedor → revisão nova" "$(revj "'$SO1','oben','criacao',102,'A28','informada','$I1'" seq)" "2"
  eq "P4.4 sem parcela → 999 default, prazo NULL (nunca 0)" "$(Pq -c "SELECT (j->>'seq')||'/'||(j->>'codigo_parcela')||'/'||(j->>'parcela_origem')||'/'||COALESCE(j->>'prazo_dias','NULL') FROM (SELECT public.t_rev('$SO1','oben','criacao',102,'','informada','$I1') j) x")" "3/999/default_999/NULL"
  eq "P4.5 parcela NULL = mesma revisão implícita" "$(revj "'$SO1','oben','criacao',102,NULL,NULL,'$I1'" seq)" "3"
  eq "P4.6 herdada_omie aceita (seq 4)" "$(revj "'$SO1','oben','edicao',102,'S41','herdada_omie','$I1'" seq)" "4"
  eq "P4.7 centavos por linha (2×1,005 → 2,02)" "$(revj "'$SO2','colacor','criacao',601,'A28','informada','[{\"codigo_produto\":1,\"quantidade\":1,\"valor_unitario\":1.005},{\"codigo_produto\":2,\"quantidade\":1,\"valor_unitario\":1.005}]'" valor_brl)" "2.02"
  eq "P4.8 Colacor sem catálogo → prazo NULL na revisão" "$(Pq -c "SELECT COALESCE(prazo_dias::text,'NULL') FROM public.credito_operacao_revisao WHERE sales_order_id='$SO2'")" "NULL"
  local n0; n0=$(nrev)
  eq "P4.9 quantidade string" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[{\"codigo_produto\":1,\"quantidade\":\"2\",\"valor_unitario\":1}]')\$q\$)")" "22023"
  eq "P4.10 quantidade 0" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[{\"codigo_produto\":1,\"quantidade\":0,\"valor_unitario\":1}]')\$q\$)")" "22023"
  eq "P4.11 preço negativo" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[{\"codigo_produto\":1,\"quantidade\":1,\"valor_unitario\":-1}]')\$q\$)")" "22023"
  eq "P4.12 preço null" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[{\"codigo_produto\":1,\"quantidade\":1,\"valor_unitario\":null}]')\$q\$)")" "22023"
  eq "P4.13 código não inteiro" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[{\"codigo_produto\":1.5,\"quantidade\":1,\"valor_unitario\":1}]')\$q\$)")" "22023"
  eq "P4.14 itens vazios" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','[]')\$q\$)")" "22023"
  eq "P4.15 itens não-array" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','informada','{}')\$q\$)")" "22023"
  eq "P4.16 pedido inexistente" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev(gen_random_uuid(),'oben','criacao',1,'A28','informada','$I1')\$q\$)")" "P0002"
  eq "P4.17 conta divergente do pedido" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','colacor','criacao',1,'A28','informada','$I1')\$q\$)")" "22023"
  eq "P4.18 origem inválida" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','xpto','$I1')\$q\$)")" "22023"
  eq "P4.19 default_999 com outra parcela" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','criacao',1,'A28','default_999','$I1')\$q\$)")" "22023"
  eq "P4.20 contexto inválido" "$(Pq -c "SELECT public.t_try(\$q\$SELECT public.t_rev('$SO1','oben','x',1,'A28','informada','$I1')\$q\$)")" "22023"
  eq "P4.21 nenhuma recusa gravou linha" "$(nrev)" "$n0"
  Pq -c "SELECT public.t_ov('$L','oben','A28',35,'evidência nova')" >/dev/null
  eq "P4.22 override novo → revisão nova com a evidência" "$(Pq -c "SELECT (j->>'seq')||'/'||(j->>'prazo_dias')||'/'||(j->>'prazo_fonte') FROM (SELECT public.t_rev('$SO1','oben','criacao',101,'A28','informada','$I1') j) x")/$(Pq -c "SELECT count(*) FROM public.credito_operacao_revisao WHERE prazo_override_id IS NOT NULL")" "5/35/override/1"
  eq "P4.23 UPDATE com portão aberto → 42501" "$(tryas escritor_teste '' "SELECT set_config('credito.portao', (SELECT id::text FROM public.credito_operacao_revisao LIMIT 1), false); UPDATE public.credito_operacao_revisao SET valor_brl = 1")" "42501"
  eq "P4.24 DELETE → 42501" "$(tryas escritor_teste '' "SELECT set_config('credito.portao', (SELECT id::text FROM public.credito_operacao_revisao LIMIT 1), false); DELETE FROM public.credito_operacao_revisao")" "42501"
  eq "P4.25 TRUNCATE → 42501" "$(tryas escritor_teste '' "TRUNCATE public.credito_operacao_revisao")" "42501"
  eq "P4.26 authenticated não registra revisão" "$(tryas authenticated "$G" "SELECT public.credito_registrar_revisao('$SO1','oben','criacao',1,'A28','informada','$I1'::jsonb,NULL)")" "42501"
  eq "P4.27 RLS: gestor lê" "$(Pq -c "SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"sub\":\"$G\"}', false); SELECT count(*) > 0 FROM public.credito_operacao_revisao;" | tail -1)" "t"
  eq "P4.28 RLS: vendedor lê 0" "$(Pq -c "SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"sub\":\"$V\"}', false); SELECT count(*) FROM public.credito_operacao_revisao;" | tail -1)" "0"
  eq "P4.29 RLS: customer lê 0" "$(Pq -c "SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"sub\":\"$U\"}', false); SELECT count(*) FROM public.credito_prazo_override;" | tail -1)" "0"

  echo "C1 concorrência: 2 registros do MESMO conteúdo → 1 linha"
  corrida
  eq "C1 B reusou a revisão de A (1 linha)" "$(cat "$SAB/b.out" 2>/dev/null | tail -1)/$(Pq -c "SELECT count(*) FROM public.credito_operacao_revisao WHERE sales_order_id='$SO3'")" "true/1"
}

# A abre transação, registra e segura 3 s sem commitar; B registra o mesmo conteúdo no meio.
corrida() {
  Pq -c "SELECT public.t_forca_limpa_so3();" >/dev/null 2>&1 || true
  P -q -c "SET session_replication_role = replica; DELETE FROM public.credito_operacao_revisao WHERE sales_order_id='$SO3';" >/dev/null
  rm -f "$SAB/b.out"
  ( P -q -c "BEGIN; SELECT public.t_rev('$SO3','oben','criacao',101,'A28','informada','$I1'); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 ) &
  local pa=$!
  sleep 1
  Pq -c "SELECT public.t_rev('$SO3','oben','criacao',101,'A28','informada','$I1') ->> 'reusada';" > "$SAB/b.out" 2>&1 || echo "ERRO" >> "$SAB/b.out"
  wait $pa || true
}

echo "── asserts (controle) ──"
asserts
if [ "$FAIL" -ne 0 ]; then
  echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ HARNESS VERMELHO (controle) — falsificação não roda"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (uma camada por vez; controle verde acima na MESMA invocação)
# ══════════════════════════════════════════════════════════════════════════════
muta() { # $1 python que transforma o texto → $SAB/m.sql
  python3 - "$MIG" "$SAB/m.sql" "$1" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src, encoding="utf-8").read(); n = eval(expr)
assert n != t, "sabotagem não alterou o texto"
open(dst, "w", encoding="utf-8").write(n)
PY
}
sabota() { # $1 rótulo · $2 python · $3 comando do assert-alvo · $4 valor que o assert SÃO exige · $5 (opc.) saída EXATA do mutante
  muta "$2"; P -q -f "$SAB/m.sql"; grant_escritor; limpa
  local v; v=$(eval "$3")
  if [ -n "${5:-}" ] && [ "$v" != "$5" ]; then bad "$1 → mutante saiu [$v], esperado exatamente [$5] (vermelho pelo motivo errado?)"
  elif [ "$v" != "$4" ]; then ok "$1 → assert-alvo vermelho (veio $v)"; else bad "$1 → sabotei e o assert continuou verde ($v): sem dente"; fi
  P -q -f "$MIG"; grant_escritor; limpa
}
aborta() { # $1 rótulo · $2 python — a POSTCONDIÇÃO tem de abortar a migration mutante
  muta "$2"
  if P -1 -q -f "$SAB/m.sql" > "$SAB/pos.log" 2>&1; then bad "$1 → a migration APLICOU (postcondição sem dente)"
  elif grep -q 'POS FALHOU' "$SAB/pos.log"; then ok "$1 → postcondição abortou ($(grep -o 'POS FALHOU[^"]*' "$SAB/pos.log" | head -1 | cut -c1-90))"
  else bad "$1 → falhou por OUTRO motivo: $(head -c 200 "$SAB/pos.log")"; fi
  P -q -f "$MIG"; grant_escritor; limpa
}

echo "── falsificação ──"
sabota "F1 parser aceita qualquer qualificador de à vista → 'A Vista (30 dias)' vira [0]" \
  "t.replace(\"'*faturamento' || c_ws || '*\\\\))?'\", \"'*[^)]*\\\\))?'\")" \
  "Pq -c \"SELECT count(*) FROM public.t_fix WHERE public.credito_parse_calendario(descricao) IS DISTINCT FROM esperado\"" "0"
sabota "F2 override sem gate de aprovador → master estranho define" \
  "t.replace('IF NOT public.credito_sou_aprovador() THEN', 'IF false THEN')" \
  "Pq -c \"SELECT public.t_ov('$M2','oben','A14',14,'master estranho')\"" "42501"
sabota "F3 lock COMPARTILHADO no registro → B não espera, colide no seq (23505)" \
  "t.replace(\"PERFORM pg_advisory_xact_lock(hashtextextended('credito_revisao:'\", \"PERFORM pg_advisory_xact_lock_shared(hashtextextended('credito_revisao:'\")" \
  "corrida; echo \"\$(tail -1 \"\$SAB/b.out\")/\$(Pq -c \"SELECT count(*) FROM public.credito_operacao_revisao WHERE sales_order_id='$SO3'\")\"" "true/1" "ERRO/1"
sabota "F4 sem a contraprova de num_parcelas → prazo fabricado" \
  "t.replace('IF v_cat.num_parcelas IS NULL OR v_cat.num_parcelas <> cardinality(v_cal) THEN', 'IF false THEN')" \
  "prazo \"'X01','oben'\"" "NULL"
sabota "F5 parcela ausente vira 000 (à vista) → ausente vira zero" \
  "t.replace(\"v_codigo := '999';\n    v_origem := 'default_999';\", \"v_codigo := '000';\n    v_origem := 'informada';\")" \
  "Pq -c \"SELECT (j->>'codigo_parcela')||'/'||COALESCE(j->>'prazo_dias','NULL') FROM (SELECT public.t_rev('$SO1','oben','criacao',1,'','informada',public.t_i1()) j) x\"" "999/NULL"
sabota "F6 revogação ignorada → override revogado segue valendo" \
  "t.replace('WHERE o.company = v_acc AND o.codigo_parcela = v_cod\n   ORDER BY', 'WHERE o.company = v_acc AND o.codigo_parcela = v_cod AND o.prazo_dias IS NOT NULL\n   ORDER BY')" \
  "Pq -c \"SELECT public.t_ov('$L','oben','A28',35,'x vigente'); SELECT public.t_ov('$L','oben','A28',NULL,'x revogado');\" >/dev/null; prazo \"'A28','oben'\"" "28"
sabota "F7 deduplicação sem o devedor → outro cliente reusa a revisão" \
  "t.replace(\"'contexto', p_contexto, 'cliente', p_omie_codigo_cliente, \", \"'contexto', p_contexto, \")" \
  "rev \"'$SO1','oben','criacao',101,'A28','informada',public.t_i1()\" >/dev/null; revj \"'$SO1','oben','criacao',102,'A28','informada',public.t_i1()\" seq" "2"
sabota "F8 centavos pela soma (não por linha) → 2,01" \
  "t.replace('v_valor := v_valor + round(v_q * v_v, 2);', 'v_valor := v_valor + v_q * v_v;')" \
  "Pq -c \"SELECT round((public.t_rev('$SO2','colacor','criacao',601,'A28','informada','[{\\\"codigo_produto\\\":1,\\\"quantidade\\\":1,\\\"valor_unitario\\\":1.005},{\\\"codigo_produto\\\":2,\\\"quantidade\\\":1,\\\"valor_unitario\\\":1.005}]') ->> 'valor_brl')::numeric, 2)\"" "2.02"
aborta "F9 REVOKE de escrita esquecido (builder com INSERT)" \
  "t.replace(\"      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM %s', t, r.papel);\n\", '')"
aborta "F10 parser devolve [0] para ilegível (ausente vira à vista)" \
  "t.replace('    IF m IS NULL THEN RETURN NULL; END IF;', '    IF m IS NULL THEN RETURN ARRAY[0]; END IF;')"

echo "── re-controle (migration real reaplicada) ──"
asserts
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ "$FAIL" -ne 0 ]; then echo "❌ HARNESS VERMELHO"; exit 1; fi
echo "✅ HARNESS VERDE — prova PG17 do PR 3 (locale ${LC_ALL})"
