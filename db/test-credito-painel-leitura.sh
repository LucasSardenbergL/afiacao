#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Crédito-IA PR 8: painel de crédito (RPC de leitura)             ║
# ║  Migration sob prova: 20261125120000_credito_painel_leitura.sql               ║
# ║  Base: arranque + zonas 1-2 de db/test-credito-gate-fronteira-60.sh           ║
# ║  (a prod = fase2 + exceção por par + piso grupo + PR 2 + MIGN + MIGF).        ║
# ║  Rode: bash db/test-credito-painel-leitura.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-credito-painel-leitura.sh      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5541}"
SLUG="credito-painel-leitura"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

SAB="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$SAB"; }
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
-- DEFAULT PRIVILEGE do Supabase: objeto novo em public NASCE ABERTO (database.md §4).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
-- … e o papel do builder do Lovable (sandbox_exec_<ref>, BYPASSRLS), medido em prod.
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
# ZONA 1 — PRÉ-REQUISITOS (helpers de role verbatim de prod; colunas que o painel lê)
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

CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_credito_escrever(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;
REVOKE ALL ON FUNCTION private.cap_credito_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_credito_escrever(uuid) TO authenticated, service_role;

-- colunas = as de prod que o painel lê (information_schema, psql-ro 2026-11-25)
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, created_by uuid, omie_numero_pedido text,
  total numeric, status text, deleted_at timestamptz, gemeo_importado_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, omie_codigo_cliente bigint, saldo numeric, status_titulo text, data_vencimento date,
  omie_codigo_lancamento bigint, numero_pedido text, nome_cliente text, updated_at timestamptz DEFAULT now(),
  valor_documento numeric, data_emissao date, categoria_codigo text, ausente_omie_desde timestamptz);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text, razao_social text);
CREATE TABLE public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','conflict')));
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account text NOT NULL, omie_codigo_cliente bigint);
-- v_titulo_baixas em prod é VIEW sobre fin_movimentacoes; aqui basta a FORMA (colunas e tipos de prod)
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date, valor_baixado numeric,
  n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
SQL

L=414a9727-ad1d-4998-914e-9c6ccf26cf50   # master (Lucas)
G=33333333-3333-3333-3333-333333333333   # employee gerencial (gestor)
V=44444444-4444-4444-4444-444444444444   # employee operacional (vendedor)
U=55555555-5555-5555-5555-555555555555   # customer
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$L'),('$G'),('$V'),('$U') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES ('$L','master'),('$G','employee'),('$V','employee'),('$U','customer');
INSERT INTO public.commercial_roles VALUES ('$G','gerencial'),('$V','operacional');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (o que a prod tem hoje)
# ══════════════════════════════════════════════════════════════════════════════
M="$REPO_ROOT/supabase/migrations"
for m in 20260702233000_trava_credito_fase2 20260703140000_trava_credito_gate_excecao_por_par \
         20261121120000_trava_credito_piso_grupo 20261121160000_credito_limite_reserva_decisao \
         20261121200000_credito_piso_pagto_parcial 20261124170000_credito_gate_fronteira_60_inclusiva; do
  P -q -1 -f "$M/$m.sql"
done
MIG_BASE="$M/20261125120000_credito_painel_leitura.sql"   # o que a prod tem (#1443)
MIG_IA="$M/20261126180000_credito_painel_concordancia_ia.sql"  # prod (#1488)
MIG="$M/20261127100000_credito_painel_nome_grupo.sql"         # sob prova (nome do grupo por profiles)
echo "antecedentes aplicados"

# helpers do harness
P -q <<'SQL'
CREATE FUNCTION public.t_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO PUBLIC;
SQL

# chama o painel como um titular (papel authenticated + sub) e devolve o jsonb, ou a SQLSTATE
painel() { # $1 = uid, $2 = p_dias
  Pq -c "BEGIN; SET LOCAL ROLE authenticated;
         SELECT set_config('request.jwt.claims', '{\"sub\":\"$1\"}', true);
         SELECT public.t_try('SELECT public.credito_painel_resumo($2)');
         ROLLBACK;" | sed -n 2p
}
J() { # $1 = expressão jsonb sobre r (o resultado do painel como o Lucas, 90 d)
  Pq -c "BEGIN; SET LOCAL ROLE authenticated;
         SELECT set_config('request.jwt.claims', '{\"sub\":\"$L\"}', true);
         WITH x AS (SELECT public.credito_painel_resumo(90) AS r) SELECT $1 FROM x;
         ROLLBACK;" | sed -n 2p
}

Jv() { # $1 = DDL como postgres (desfeito no ROLLBACK), $2 = expressão jsonb sobre r
  Pq -c "BEGIN; $1; SET LOCAL ROLE authenticated;
         SELECT set_config('request.jwt.claims', '{\"sub\":\"$L\"}', true);
         WITH x AS (SELECT public.credito_painel_resumo(90) AS r) SELECT $2 FROM x;
         ROLLBACK;" | sed -n 2p
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# grupo C: canônico C oben 101 + alias A1 ACTIVE colacor_sc 202 (soma das empresas, parcial SC)
# grupo E: colacor 601 com alias E2 CONFLICT → não consolidado
# par colacor 999: sem dono no mapa → não consolidado (sem_grupo)
# ══════════════════════════════════════════════════════════════════════════════
C=c0000000-0000-0000-0000-000000000001
A1=a1000000-0000-0000-0000-000000000001
E=e0000000-0000-0000-0000-000000000001
E2=e2000000-0000-0000-0000-000000000001
P -q <<SQL
INSERT INTO public.customer_canonical_alias VALUES ('$A1','$C','active'), ('$E2','$E','conflict');
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('$C','oben',101), ('$A1','colacor_sc',202), ('$E','colacor',601), ('$E2','colacor',602);
-- hoje SP, para as datas relativas
CREATE TEMP TABLE h AS SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d;
INSERT INTO public.fin_contas_receber (company, omie_codigo_cliente, saldo, status_titulo, data_vencimento,
                                       omie_codigo_lancamento, numero_pedido, nome_cliente) VALUES
  -- grupo C: 1000 vencido 70 d (oben) + 500 a vencer (SC) + 1 sem saldo + 1 RECEBIDO (fora)
  ('oben', 101, 1000, 'ATRASADO', (SELECT d FROM h) - 70, 1, NULL, 'Cliente C'),
  ('colacor_sc', 202, 500, 'A VENCER', (SELECT d FROM h) + 10, 2, NULL, 'Cliente C SC'),
  ('oben', 101, NULL, 'A VENCER', (SELECT d FROM h) + 5, 3, NULL, 'Cliente C'),
  ('oben', 101, 9999, 'RECEBIDO', (SELECT d FROM h) - 90, 4, NULL, 'Cliente C'),
  -- não consolidados
  ('colacor', 999, 300, 'A VENCER', (SELECT d FROM h) + 3, 5, NULL, 'Sem dono'),
  ('colacor', 601, 50, 'A VENCER', (SELECT d FROM h) + 3, 6, NULL, 'Conflito'),
  -- títulos derivados de pedidos do app (grupo C, oben 101, a vencer >15 d atrás)
  ('oben', 101, 2000, 'ATRASADO', (SELECT d FROM h) - 20, 11, '5001', 'Cliente C'),   -- SO1: atrasou
  ('oben', 101, 700,  'ATRASADO', (SELECT d FROM h) - 20, 12, '5002', 'Cliente C'),   -- SO2: tem baixa inferida
  ('oben', 101, 400,  'A VENCER', (SELECT d FROM h) + 20, 14, '5004', 'Cliente C'),   -- SO4: não maturou
  ('oben', 101, 800,  'ATRASADO', (SELECT d FROM h) - 30, 13, '5003', 'Cliente C'),   -- SO3: importado (fora)
  ('oben', 101, 900,  'ATRASADO', (SELECT d FROM h) - 30, 16, '5006', 'Cliente C');   -- SO6: gêmeo cancelado
INSERT INTO public.v_titulo_baixas (company, omie_codigo_lancamento, tipo, data_baixa_final, origem_baixa) VALUES
  ('oben', 12, 'CR', (SELECT d FROM h) - 18, 'titulo'),
  -- isca: baixa de CP com o MESMO código do título do SO1 não pode contar como baixa de CR
  ('oben', 11, 'CP', (SELECT d FROM h) - 18, 'titulo');
-- o app grava o PV com zeros à esquerda (prod: '000000000010520'); o título, sem
INSERT INTO public.sales_orders (id, account, created_by, omie_numero_pedido, total, status, created_at) VALUES
  ('90000000-0000-0000-0000-000000000006', 'oben', NULL, '5006', 900, 'cancelado', now() - interval '25 days');
INSERT INTO public.sales_orders (account, created_by, omie_numero_pedido, total, status, created_at, gemeo_importado_id) VALUES
  ('oben', '$L', '000000005001', 2000, 'enviado', now() - interval '25 days', NULL),
  ('oben', '$L', '000000005002', 700,  'enviado', now() - interval '25 days', NULL),
  ('oben', NULL, '5003', 800,  'faturado', now() - interval '25 days', NULL),
  ('oben', '$L', '000000005004', 400,  'enviado', now() - interval '10 days', NULL),
  -- SO6: gêmeo cancelado no Omie → não foi liberado (título atrasado dele não conta)
  ('oben', '$L', '000000005006', 900,  'enviado', now() - interval '25 days', '90000000-0000-0000-0000-000000000006'),
  ('oben', '$L', NULL,   100,  'orcamento', now() - interval '1 day', NULL);
-- nome do grupo = profiles da RAIZ: C tem razão social em branco (cai no name); o alias A1 tem nome
-- próprio que NÃO pode aparecer (o grupo é o C)
INSERT INTO public.profiles (user_id, name, razao_social) VALUES ('$C', 'Cliente C', '   '), ('$A1', 'Alias SC', 'Alias Razao');
INSERT INTO public.venda_bloqueio_credito_log (company, omie_codigo_cliente, acao, vencido, titulos)
  VALUES ('oben', 101, 'bloqueado', 1000, 1);
SQL
echo "seed ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (rodam contra a variante instalada)
# ══════════════════════════════════════════════════════════════════════════════
# ── IA × regra (fatia 5b ao vivo): seed na MESMA transação do painel, desfeito no ROLLBACK ──
Z=f0000000-0000-0000-0000-00000000000a
W=f0000000-0000-0000-0000-00000000000b
H="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
PROP="INSERT INTO public.credito_limite_proposta (grupo_user_id, grupo_assinatura, limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_em, created_at) VALUES"
# o portão do PR 2 (escrita só pelas RPCs) é do ESCRITOR; aqui provamos o LEITOR → trigger fora na transação
SEED_IA="ALTER TABLE public.credito_limite_proposta DISABLE TRIGGER USER;
ALTER TABLE public.credito_limite_proposta DROP CONSTRAINT credito_limite_proposta_status_check;
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$Z','oben',301);
$PROP ('$C','x',5000,28,'baixo',jsonb_build_object('piso_estado','livre'),now(),'pendente',NULL,now()-interval '2 days'),
 ('$C','x',0,0,'alto',jsonb_build_object('piso_estado','comprovado'),now(),'pendente',NULL,now()-interval '1 day'),
 ('$C','x',9000,28,'baixo',jsonb_build_object('piso_estado','livre'),now(),'aplicada_auto_reducao',now(),now()),
 ('$Z','z',3000,28,'baixo',jsonb_build_object('piso_estado','livre'),now(),'pendente',NULL,now()-interval '1 day'),
 ('$W','w',2000,28,'medio',jsonb_build_object('outra','x'),now(),'pendente',NULL,now()-interval '1 day');
INSERT INTO public.fin_contas_receber (company, omie_codigo_cliente, saldo, status_titulo, data_vencimento, omie_codigo_lancamento, valor_documento, data_emissao, categoria_codigo) VALUES
 ('oben',101,0,'RECEBIDO',$H-30,9101,100,$H-60,'1.01.01'),
 ('oben',101,0,'RECEBIDO',$H-40,9102,200,$H-70,'1.01.01'),
 ('oben',101,300,'ATRASADO',$H-20,9103,300,$H-50,'1.01.01'),
 ('oben',101,0,'RECEBIDO',$H-30,9104,1000,$H-60,'1.01.01'),
 ('oben',101,0,'RECEBIDO',$H-30,9105,5000,$H-60,'2.01.01'),
 ('oben',101,0,'RECEBIDO',$H-10,9106,5000,$H-40,'1.01.01'),
 ('colacor_sc',202,0,'RECEBIDO',$H-30,9107,400,$H,'1.01.01'),
 ('oben',301,0,'RECEBIDO',$H-50,9201,1000,$H-80,'1.01.01');
INSERT INTO public.v_titulo_baixas (company, omie_codigo_lancamento, tipo, data_baixa_final, origem_baixa) VALUES
 ('oben',9101,'CR',$H-28,'titulo'), ('oben',9102,'CR',$H-30,'titulo'), ('oben',9104,'CP',$H-30,'titulo'),
 ('oben',9105,'CR',$H-30,'titulo'), ('oben',9106,'CR',$H-10,'titulo'),
 ('colacor_sc',9107,'CR',$H-30,'titulo'), ('oben',9201,'CR',$H-50,'titulo')"
# só o grupo W (ficha sem piso): nada comparável
SEED_W="ALTER TABLE public.credito_limite_proposta DISABLE TRIGGER USER; $PROP ('$W','w',2000,28,'medio',jsonb_build_object('outra','x'),now(),'pendente',NULL,now())"

asserts_ia() {
  echo "── concordância IA × regra (seed: C alto/comprovado · Z baixo/livre · W sem piso · redução 5b ignorada) ──"
  local c="r->'concordancia'"
  local rk="(SELECT f FROM jsonb_array_elements($c->'por_risco') f WHERE f->>'risco'"
  local xp="(SELECT f->>'grupos' FROM jsonb_array_elements($c->'ia_x_piso') f WHERE (f->>'ia_restringe')"
  eq "IA: disponível" "$(Jv "$SEED_IA" "$c->>'disponivel'")" "true"
  eq "IA: 3 grupos com proposta (redução 5b não é proposta)" "$(Jv "$SEED_IA" "$c->>'grupos_com_proposta'")" "3"
  eq "IA: 2 com desfecho (W sem safra)" "$(Jv "$SEED_IA" "$c->>'grupos_com_desfecho'")" "2"
  eq "IA: 1 título sem desfecho (RECEBIDO sem baixa CR) contado à parte" "$(Jv "$SEED_IA" "$c->>'titulos_sem_desfecho'")" "1"
  eq "IA: C = proposta MAIS RECENTE (alto), 4 títulos com desfecho" "$(Jv "$SEED_IA" "$rk='alto')->>'titulos'")" "4"
  eq "IA: alto — atraso por R\$ = 500/1000 = 50.0 (tolerância 5 d; SC somada)" "$(Jv "$SEED_IA" "$rk='alto')->>'atraso_pct'")" "50.0"
  eq "IA: alto — atraso grave = 300/1000 = 30.0" "$(Jv "$SEED_IA" "$rk='alto')->>'atraso_grave_pct'")" "30.0"
  eq "IA: baixo (Z) — zero medido = 0.0" "$(Jv "$SEED_IA" "$rk='baixo')->>'atraso_pct'")" "0.0"
  eq "IA: sem risco baixo para C (a 1ª proposta e a redução não contam)" "$(Jv "$SEED_IA" "$rk='baixo')->>'titulos'")" "1"
  eq "IA × piso: restringe · comprovado = 1" "$(Jv "$SEED_IA" "$xp='true' AND f->>'piso_hoje'='comprovado')")" "1"
  eq "IA × piso: libera · livre = 1" "$(Jv "$SEED_IA" "$xp='false' AND f->>'piso_hoje'='livre')")" "1"
  eq "concordância: 2 comparáveis, 1 fora (W sem piso)" "$(Jv "$SEED_IA" "($c->'concordancia_piso'->>'comparaveis') || '/' || ($c->'concordancia_piso'->>'fora_da_comparacao')")" "2/1"
  eq "concordância = 100.0" "$(Jv "$SEED_IA" "$c->'concordancia_piso'->>'concordancia_pct'")" "100.0"
  eq "prospectivo: só o título emitido depois da 1ª proposta" "$(Jv "$SEED_IA" "$c->'prospectivo'->>'titulos_maduros'")" "1"
  eq "prospectivo: coorte da 1ª proposta (libera)" "$(Jv "$SEED_IA" "$c->'prospectivo'->'por_ia'->0->>'ia_restringe'")" "false"
  eq "só W: nada comparável → % null (não 0)" "$(Jv "$SEED_W" "$c->'concordancia_piso'->>'concordancia_pct'")" ""
  eq "só W: sem desfecho → por_risco vazio" "$(Jv "$SEED_W" "jsonb_array_length($c->'por_risco')")" "0"
  echo "── guarda de drift (CREATE OR REPLACE sobre corpo divergente é recusado; reaplicar é idempotente) ──"
  P -q -c "DROP FUNCTION public.credito_painel_resumo(integer);
           CREATE FUNCTION public.credito_painel_resumo(p_dias integer DEFAULT 90) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'"
  if P -q -1 -f "$CUR" >/dev/null 2>&1; then bad "drift: aplicou sobre corpo divergente"; else ok "drift: corpo divergente → recusado"; fi
  instala "$CUR"
  if P -q -1 -f "$CUR" >/dev/null 2>&1; then ok "drift: reaplicar sobre si mesmo passa"; else bad "drift: reaplicação recusada"; fi
}

asserts() {
  echo "── ACL e gate de papel ──"
  eq "anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.credito_painel_resumo(integer)','EXECUTE')")" "f"
  eq "service_role sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','public.credito_painel_resumo(integer)','EXECUTE')")" "f"
  eq "sandbox_exec sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_teste','public.credito_painel_resumo(integer)','EXECUTE')")" "f"
  eq "PUBLIC sem EXECUTE" "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid='public.credito_painel_resumo(integer)'::regprocedure AND a.grantee=0")" "0"
  eq "customer → 42501" "$(painel "$U" 90)" "42501"
  eq "vendedor (operacional) → 42501" "$(painel "$V" 90)" "42501"
  eq "sem sessão → 42501" "$(Pq -c "BEGIN; SET LOCAL ROLE authenticated; SELECT public.t_try('SELECT public.credito_painel_resumo(90)'); ROLLBACK;" | sed -n 1p)" "42501"
  eq "gestor gerencial lê" "$(painel "$G" 90)" "OK"
  eq "master lê" "$(painel "$L" 90)" "OK"
  eq "p_dias=0 → 22023" "$(painel "$L" 0)" "22023"

  echo "── ausente ≠ zero (blocos sem fonte) ──"
  eq "limites indisponível" "$(J "r->'limites'->>'disponivel'")" "false"
  eq "limites tem motivo" "$(J "(r->'limites'->>'motivo') IS NOT NULL")" "t"
  eq "reservas não medidas" "$(J "r->'exposicao'->'reservas'->>'disponivel'")" "false"
  eq "reservado do grupo = null (não 0)" "$(J "(SELECT g->'reservado' FROM jsonb_array_elements(r->'exposicao'->'grupos') g WHERE g->>'grupo_user_id'='$C')")" "null"
  eq "fila indisponível" "$(J "r->'fila'->>'disponivel'")" "false"
  eq "sem proposta da IA: concordância indisponível" "$(J "r->'concordancia'->>'disponivel'")" "false"
  eq "motivo = IA ainda não propôs" "$(J "(r->'concordancia'->>'motivo') LIKE '%IA ainda n%o prop%'")" "t"
  asserts_ia
  eq "sombra indisponível sem a view do PR 5" "$(J "r->'concordancia'->'sombra'->>'disponivel'")" "false"
  eq "motivo = PR 5 não aplicado" "$(J "(r->'concordancia'->'sombra'->>'motivo') LIKE '%(PR 5) ainda n%o aplicado%'")" "t"

  echo "── sombra do PR 5 (view credito_sombra_pv_atual criada e desfeita na transação) ──"
  # forma do PR 5 (#4192): faixa, motivo, piso jsonb (saída do venda_gate_credito_grupo), carga_inicial
  local VOK="CREATE VIEW public.credito_sombra_pv_atual AS SELECT faixa, motivo, piso::jsonb AS piso, carga_inicial FROM (VALUES ('amarelo','sem_limite','{\"bloqueado\":false}',false),('amarelo','sem_limite','{\"bloqueado\":false}',false),('verde','dentro_limite','{\"bloqueado\":false}',false),('vermelho','piso_vencido_60d','{\"bloqueado\":true}',false),('verde','dentro_limite','{\"bloqueado\":false}',true)) v(faixa, motivo, piso, carga_inicial)"
  eq "com a view: sombra disponível" "$(Jv "$VOK" "r->'concordancia'->'sombra'->>'disponivel'")" "true"
  eq "com a view: 4 PVs (carga inicial fora)" "$(Jv "$VOK" "r->'concordancia'->'sombra'->>'pvs'")" "4"
  eq "v2 × piso: vermelho com piso bloqueado = 1" "$(Jv "$VOK" "(SELECT f->>'decisoes' FROM jsonb_array_elements(r->'concordancia'->'sombra'->'v2_x_piso') f WHERE f->>'faixa'='vermelho' AND f->>'piso_bloqueado'='true')")" "1"
  eq "v2 × piso: verde com piso livre = 1 (carga inicial fora)" "$(Jv "$VOK" "(SELECT f->>'decisoes' FROM jsonb_array_elements(r->'concordancia'->'sombra'->'v2_x_piso') f WHERE f->>'faixa'='verde' AND f->>'piso_bloqueado'='false')")" "1"
  eq "com a view: amarelo/sem_limite = 2" "$(Jv "$VOK" "(SELECT f->>'decisoes' FROM jsonb_array_elements(r->'concordancia'->'sombra'->'por_faixa') f WHERE f->>'faixa'='amarelo' AND f->>'motivo'='sem_limite')")" "2"
  local VRUIM="CREATE VIEW public.credito_sombra_pv_atual AS SELECT 'verde'::text AS faixa"
  eq "view com outra forma: só o bloco degrada" "$(Jv "$VRUIM" "r->'concordancia'->'sombra'->>'disponivel'")" "false"
  eq "view com outra forma: o resto do painel segue" "$(Jv "$VRUIM" "r->'exposicao'->'totais'->>'grupos'")" "1"
  eq "gate v2 efetivo indisponível" "$(J "r->'bloqueios'->'gate_v2'->>'disponivel'")" "false"

  echo "── exposição do grupo (3 empresas somadas) ──"
  local g="(SELECT g FROM jsonb_array_elements(r->'exposicao'->'grupos') g WHERE g->>'grupo_user_id'='$C')"
  eq "aberto conhecido C (1000+500+2000+700+400+800+900)" "$(J "$g->>'aberto_conhecido'")" "6300"
  eq "títulos abertos C (RECEBIDO fora)" "$(J "$g->>'titulos'")" "8"
  eq "1 título indeterminado (saldo NULL)" "$(J "$g->>'titulos_indeterminados'")" "1"
  eq "vencido > 60 d C" "$(J "$g->>'vencido_60_conhecido'")" "1000"
  eq "maior atraso = 70 d" "$(J "$g->>'dias_maior_atraso'")" "70"
  eq "parcial Colacor SC marcado" "$(J "$g->>'parcial_colacor_sc'")" "true"
  eq "uso_pct null sem limite" "$(J "$g->'uso_pct'")" "null"
  eq "não consolidado sem_grupo = 300" "$(J "(SELECT n->>'aberto_conhecido' FROM jsonb_array_elements(r->'exposicao'->'nao_consolidados') n WHERE n->>'motivo'='sem_grupo')")" "300"
  eq "não consolidado grupo_conflito = 50" "$(J "(SELECT n->>'aberto_conhecido' FROM jsonb_array_elements(r->'exposicao'->'nao_consolidados') n WHERE n->>'motivo'='grupo_conflito')")" "50"
  eq "1 grupo consolidado" "$(J "r->'exposicao'->'totais'->>'grupos'")" "1"

  echo "── bloqueios ──"
  local gc="(SELECT g FROM jsonb_array_elements(r->'exposicao'->'grupos') g WHERE g->>'grupo_user_id'='$C')"
  eq "nome do grupo = profiles da raiz (razão em branco → name; alias não)" "$(J "$gc->>'nome'")" "Cliente C"
  eq "bloqueio recente: nome pelo dono do par" "$(J "r->'bloqueios'->'recentes'->0->>'nome'")" "Cliente C"
  eq "bloqueio recente: par com 2 donos → nome null (não adivinha)" "$(Jv "INSERT INTO public.profiles VALUES ('$E','Cliente E',NULL); INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES ('$E','oben',101)" "r->'bloqueios'->'recentes'->0->>'nome'")" ""
  eq "bloqueado = 1 evento" "$(J "(SELECT a->>'eventos' FROM jsonb_array_elements(r->'bloqueios'->'por_acao') a WHERE a->>'acao'='bloqueado')")" "1"
  eq "denominador: pedidos do app oben (orçamento fora)" "$(J "r->'bloqueios'->'pedidos_app_periodo'->>'oben'")" "4"

  echo "── liberados que atrasaram ──"
  local l="r->'liberados_atrasaram'"
  eq "liberados (importado, orçamento e gêmeo cancelado fora)" "$(J "$l->>'liberados'")" "3"
  eq "maturados (SO1, SO2)" "$(J "$l->>'maturados'")" "2"
  eq "atrasados (só SO1: SO2 tem baixa CR)" "$(J "$l->>'atrasados'")" "1"
  eq "taxa = 50.0" "$(J "$l->>'taxa_atraso_pct'")" "50.0"
  eq "saldo atrasado = 2000" "$(J "$l->>'saldo_atrasado_conhecido'")" "2000"
  eq "cobertura parcial declarada" "$(J "$l->'cobertura'->>'parcial'")" "true"
}

asserts_com_fonte() {
  echo "── com fonte: limite + decisão efetiva + sombra + solicitação ──"
  # 1 decisão sombra e 1 efetiva com reserva (portão = a linha), 1 limite vigente via a RPC de aprovação
  P -q <<SQL
BEGIN;
SELECT public.credito_portao('d1000000-0000-0000-0000-000000000001');
INSERT INTO public.credito_decisao_pedido (id, sales_order_id, company, modo, grupo_user_id, revisao, valor_brl, faixa, motivo, piso)
  VALUES ('d1000000-0000-0000-0000-000000000001', gen_random_uuid(), 'oben', 'sombra', '$C', 'r1', 100, 'amarelo', 'sem_limite', '{}');
SELECT public.credito_portao('d2000000-0000-0000-0000-000000000001');
INSERT INTO public.credito_decisao_pedido (id, sales_order_id, company, modo, grupo_user_id, revisao, valor_brl, faixa, motivo, piso)
  VALUES ('d2000000-0000-0000-0000-000000000001', gen_random_uuid(), 'oben', 'efetivo', '$C', 'r1', 600, 'verde', 'dentro_limite', '{}');
SELECT public.credito_portao('e1000000-0000-0000-0000-000000000001');
INSERT INTO public.credito_reserva (id, decisao_id, sales_order_id, company, omie_codigo_cliente, modo, grupo_user_id, revisao, valor_brl)
  VALUES ('e1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', gen_random_uuid(), 'oben', 101, 'efetivo', '$C', 'r1', 600);
SELECT public.credito_portao('f1000000-0000-0000-0000-000000000001');
INSERT INTO public.credito_limite_proposta (id, grupo_user_id, grupo_assinatura, limite_sugerido_brl, prazo_max_dias, risco, ficha, ficha_calculada_em, status, decidido_por, decidido_em)
  VALUES ('f1000000-0000-0000-0000-000000000001', '$C', 'x', 12000, 28, 'baixo', '{}', now(), 'aprovada', '$L', now());
SELECT public.credito_portao('$C');
INSERT INTO public.credito_limite (grupo_user_id, limite_brl, prazo_max_dias, risco, versao, grupo_assinatura, ficha_calculada_em, origem_proposta_id, aprovado_por)
  VALUES ('$C', 12000, 28, 'baixo', 1, 'x', now(), 'f1000000-0000-0000-0000-000000000001', '$L');
SELECT public.credito_portao(NULL);
COMMIT;
SQL
  local g="(SELECT g FROM jsonb_array_elements(r->'exposicao'->'grupos') g WHERE g->>'grupo_user_id'='$C')"
  eq "limites disponível" "$(J "r->'limites'->>'disponivel'")" "true"
  eq "reservas medidas" "$(J "r->'exposicao'->'reservas'->>'disponivel'")" "true"
  eq "reservado C = 600" "$(J "$g->>'reservado'")" "600"
  eq "uso_pct C = (6300+600)/12000 = 57.5" "$(J "$g->>'uso_pct'")" "57.5"
  eq "com 1 proposta (ficha sem piso): concordância disponível" "$(J "r->'concordancia'->>'disponivel'")" "true"
  eq "grupos com proposta = 1" "$(J "r->'concordancia'->>'grupos_com_proposta'")" "1"
  eq "sem piso conhecido: % de concordância é null (não 0)" "$(J "r->'concordancia'->'concordancia_piso'->>'concordancia_pct'")" ""
  eq "gate v2 disponível (só não-verde listado)" "$(J "jsonb_array_length(r->'bloqueios'->'gate_v2'->'por_motivo')")" "0"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — CONTROLE VERDE + FALSIFICAÇÃO NA MESMA INVOCAÇÃO
# Cada variante: reinstala a função a partir de uma CÓPIA sabotada e exige ≥1 vermelho;
# o original roda ANTES (controle verde) e DEPOIS (restauração verde).
# ══════════════════════════════════════════════════════════════════════════════
# DROP antes: `CREATE OR REPLACE` PRESERVA o ACL da instalação anterior, então a sabotagem do fecho de
# ACL ficaria verde (falsificação pegou, 2026-11-25). Cada variante nasce como na 1ª aplicação em prod.
# instala = a cadeia de prod: base (#1443) e, por cima, o arquivo sob prova (a guarda de drift exige a base)
instala() { CUR="$1"; P -q -c "DROP FUNCTION IF EXISTS public.credito_painel_resumo(integer)";
            P -q -1 -f "$MIG_BASE" >/dev/null; P -q -1 -f "$MIG_IA" >/dev/null; P -q -1 -f "$1" >/dev/null; }

echo "══ CONTROLE (migration original) ══"
instala "$MIG"
asserts
[ "$FAIL" = "0" ] || { echo "❌ controle vermelho: $FAIL fail — falsificação não roda"; exit 1; }
CONTROLE_OK=$PASS

sabota() { # $1 = nome, $2 = expressão sed
  local f="$SAB/$1.sql"
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "sabotagem $1 não alterou o arquivo (sed não casou)"; return; fi
  local antes=$FAIL
  if ! instala "$f" 2>"$SAB/$1.err"; then
    FAIL=$antes; ok "sabotagem $1 → migration recusada (postcondição)"; instala "$MIG"; return
  fi
  asserts >"$SAB/$1.log" 2>&1 || true
  local novos=$((FAIL - antes))
  FAIL=$antes
  if [ "$novos" -gt 0 ]; then ok "sabotagem $1 → $novos vermelho(s)"; else bad "sabotagem $1 ficou VERDE (assert inalcançado)"; fi
  instala "$MIG"
}
echo "══ FALSIFICAÇÃO ══"
sabota sem_gate     's/IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN/IF false THEN/'
sabota sem_baixa    "s/OR NOT EXISTS (SELECT 1 FROM public.v_titulo_baixas b/OR true OR NOT EXISTS (SELECT 1 FROM public.v_titulo_baixas b/"
sabota tipo_errado  "s/b.tipo = 'CR'/b.tipo IN ('CR','CP')/"
sabota tolerancia_0 's/v_hoje - 15, false) AS maturado/v_hoje + 30, false) AS maturado/'
sabota reserva_zero 's/CASE WHEN v_tem_efetivo THEN COALESCE(rs.reservado, 0) END AS reservado/COALESCE(rs.reservado, 0) AS reservado/'
sabota sem_grupo_sc "s/OR x.limite_brl IS NOT NULL), '\[\]'::jsonb)/AND 'colacor_sc' <> ALL (x.empresas)), '[]'::jsonb)/"
sabota pv_cru       "s/ltrim(f.numero_pedido, '0') = ltrim(l.pv, '0')/f.numero_pedido = l.pv/"
sabota gemeo_ignora "s/WHERE g.id = so.gemeo_importado_id AND g.status = 'cancelado')/WHERE false)/"
sabota sombra_sem_guarda "s/IF to_regclass('public.credito_sombra_pv_atual') IS NULL THEN/IF false THEN/"
sabota sombra_sem_excecao "s/EXCEPTION WHEN undefined_column OR undefined_table OR insufficient_privilege THEN/EXCEPTION WHEN division_by_zero THEN/"
sabota sombra_com_carga "s/FROM public.credito_sombra_pv_atual a WHERE NOT a.carga_inicial),/FROM public.credito_sombra_pv_atual a),/"
sabota ia_sem_desfecho_em_dia "s/WHEN s.status_titulo = 'RECEBIDO' AND bx.data_baixa IS NULL THEN 'sem_desfecho'/WHEN s.status_titulo = 'RECEBIDO' AND bx.data_baixa IS NULL THEN 'em_dia'/"
sabota ia_tolerancia_60 "s/bx.data_baixa <= s.data_vencimento + 5 THEN 'em_dia'/bx.data_baixa <= s.data_vencimento + 60 THEN 'em_dia'/"
sabota ia_conta_reducao "s/^       WHERE p.status <> 'aplicada_auto_reducao'\$/       WHERE true/"
sabota ia_mais_antiga "s/ORDER BY p.grupo_user_id, p.created_at DESC, p.id/ORDER BY p.grupo_user_id, p.created_at, p.id/"
sabota ia_prosp_vaza "s/WHERE s.data_emissao > ia1.primeira_em/WHERE true/"
sabota ia_sem_categoria "s/AND f.categoria_codigo LIKE '1.01.%'/AND true/"
sabota ia_pct_zero "s/'concordancia_pct', CASE WHEN c.comparaveis > 0 THEN round(100.0 \* c.concordam \/ c.comparaveis, 1) END)/'concordancia_pct', COALESCE(round(100.0 * c.concordam \/ NULLIF(c.comparaveis, 0), 1), 0))/"
sabota drift_sem_guarda "s/AND position('painel-nome-grupo-v3' IN v_src) = 0 THEN/AND false THEN/"
sabota nome_sem_nullif "s/COALESCE(NULLIF(btrim(pf.razao_social), ''), NULLIF(btrim(pf.name), ''))/COALESCE(btrim(pf.razao_social), btrim(pf.name))/g"
sabota nome_outro_perfil "s/FROM public.profiles pf WHERE pf.user_id = u.grupo) AS nome,/FROM public.profiles pf WHERE pf.user_id <> u.grupo ORDER BY pf.name LIMIT 1) AS nome,/"
sabota nome_adivinha_dono "s/SELECT CASE WHEN count(DISTINCT m.user_id) = 1 THEN max(/SELECT CASE WHEN true THEN max(/"
# o CREATE OR REPLACE desta migration PRESERVA o ACL da base (#1443): o REVOKE dela é redundante por desenho
# (sabotá-lo fica verde). O que é load-bearing aqui é a POSTCONDIÇÃO — um GRANT a mais tem de ser recusado.
sabota acl_grant_anon 's/GRANT EXECUTE ON FUNCTION public.credito_painel_resumo(integer) TO authenticated;/GRANT EXECUTE ON FUNCTION public.credito_painel_resumo(integer) TO authenticated, anon;/'

echo "══ RESTAURAÇÃO (original de novo) ══"
instala "$MIG"
asserts
asserts_com_fonte

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail (controle: $CONTROLE_OK)"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "PROVA-CREDITO-PAINEL-LEITURA-OK"
