#!/usr/bin/env bash
# Prova money-path da view v_grupo_comercial (Grupo 360 Fase 2).
# Migrations REAIS: 20260615120000_cliente_grupos.sql + 20260616140000_v_grupo_comercial.sql
# Rode: bash db/test-grupo-comercial.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"; SLUG="grupo-comercial"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"; cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✅ $1"; }; bad(){ FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq(){ if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisitos ──
P -q <<'SQL'
create table public.user_roles (user_id uuid, role text);
create table public.fin_permissoes (user_id uuid primary key, pode_ver_todas_empresas boolean default false, empresas text[] default '{}');
create or replace function public.fin_user_can_access(check_company text default null)
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare v_perm record;
begin
  if exists (select 1 from user_roles where user_id = auth.uid() and role in ('admin','manager','employee','master')) then return true; end if;
  select * into v_perm from fin_permissoes where user_id = auth.uid();
  if v_perm is null then return false; end if;
  if check_company is null then return true; end if;
  return v_perm.pode_ver_todas_empresas or check_company = any(v_perm.empresas);
end; $$;

create table public.profiles (user_id uuid primary key, cnpj text, document text, name text, razao_social text);
create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  customer_user_id uuid, account text, created_at timestamptz, status text,
  deleted_at timestamptz, items jsonb, total numeric
);
alter table public.sales_orders enable row level security;
create policy so_service on public.sales_orders for all using (auth.role()='service_role');
create policy so_fin on public.sales_orders for select using (public.fin_user_can_access());
SQL

# ── ZONA 2 — migrations REAIS ──
P -q -f "$REPO_ROOT/supabase/migrations/20260615120000_cliente_grupos.sql"
MIG_VIEW="$REPO_ROOT/supabase/migrations/20260616140000_v_grupo_comercial.sql"
P -q -f "$MIG_VIEW"
echo "migrations aplicadas"

# ── ZONA 3 — seeds ──
P -q <<'SQL'
insert into auth.users(id) values
  ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),
  ('aaaa1111-0000-0000-0000-000000000001'),('aaaa1111-0000-0000-0000-000000000002'),
  ('aaaa1111-0000-0000-0000-000000000003'),('aaaa1111-0000-0000-0000-000000000004') on conflict do nothing;
insert into public.user_roles(user_id,role) values ('11111111-1111-1111-1111-111111111111','employee');

-- perfis dos compradores (cnpj formatado p/ testar normalização; CPF no document)
insert into public.profiles(user_id, cnpj, document, name) values
  ('aaaa1111-0000-0000-0000-000000000001','12.345.678/0001-99', null, 'Comprador CNPJ'),
  ('aaaa1111-0000-0000-0000-000000000002', null, '111.222.333-44',    'Comprador CPF'),
  ('aaaa1111-0000-0000-0000-000000000003','98765432000111', null,     'Comprador G2'),
  ('aaaa1111-0000-0000-0000-000000000004','99999999000199', null,     'Sem grupo');

-- grupos
insert into public.cliente_grupos(id, nome) values
  ('bbbbbbbb-0000-0000-0000-000000000001','Dono G1'),('bbbbbbbb-0000-0000-0000-000000000002','Dono G2');
insert into public.cliente_grupo_membros(grupo_id, documento, relation_type) values
  ('bbbbbbbb-0000-0000-0000-000000000001','12345678000199','multi_ativo'),
  ('bbbbbbbb-0000-0000-0000-000000000001','11122233344','sucessao'),
  ('bbbbbbbb-0000-0000-0000-000000000002','98765432000111','incerto');

-- pedidos: cross-empresa, janela 90d vs anterior, status excluídos, vazamento
insert into public.sales_orders(customer_user_id, account, created_at, status, deleted_at, total) values
  ('aaaa1111-0000-0000-0000-000000000001','colacor',(current_date-10)::timestamptz,'faturado',  null,100),  -- 90d
  ('aaaa1111-0000-0000-0000-000000000001','oben',   (current_date-120)::timestamptz,'importado', null,200), -- 90-180, cross-empresa
  ('aaaa1111-0000-0000-0000-000000000002','colacor',(current_date-5)::timestamptz, 'faturado',  null, 50),  -- 90d, CPF
  ('aaaa1111-0000-0000-0000-000000000001','colacor',(current_date-5)::timestamptz, 'cancelado', null,999),  -- EXCLUÍDO
  ('aaaa1111-0000-0000-0000-000000000001','colacor',(current_date-5)::timestamptz, 'rascunho',  null,888),  -- EXCLUÍDO
  ('aaaa1111-0000-0000-0000-000000000003','oben',   (current_date-10)::timestamptz,'faturado',  null, 70),  -- G2
  ('aaaa1111-0000-0000-0000-000000000004','colacor',(current_date-5)::timestamptz, 'faturado',  null,777);  -- VAZAMENTO
grant select on public.cliente_grupos, public.cliente_grupo_membros, public.sales_orders,
  public.profiles, public.v_grupo_comercial to authenticated;
SQL

# ── ZONA 4 — asserts (postgres = vê tudo) ──
echo "── asserts ──"
G1="bbbbbbbb-0000-0000-0000-000000000001"
eq "A1 faturamento_total G1 cross-empresa (100+200+50, sem 999/888)" "$(Pq -c "select faturamento_total from public.v_grupo_comercial where grupo_id='$G1';")" "350"
eq "A2a fat_90d G1 (100+50)" "$(Pq -c "select fat_90d from public.v_grupo_comercial where grupo_id='$G1';")" "150"
eq "A2b fat_90d_anterior G1 (200, janela 90-180)" "$(Pq -c "select fat_90d_anterior from public.v_grupo_comercial where grupo_id='$G1';")" "200"
eq "A3a dias_desde_ultima G1 (=5)" "$(Pq -c "select dias_desde_ultima from public.v_grupo_comercial where grupo_id='$G1';")" "5"
eq "A3b qtd_pedidos G1 (3 válidos; cancelado/rascunho fora)" "$(Pq -c "select qtd_pedidos from public.v_grupo_comercial where grupo_id='$G1';")" "3"
eq "A4 sum faturamento todos grupos = 420 (350+70; SEM o 777 órfão)" "$(Pq -c "select coalesce(sum(faturamento_total),0) from public.v_grupo_comercial;")" "420"
FIN=$(Pq -c "set test.uid='11111111-1111-1111-1111-111111111111'; set role authenticated; select count(*) from public.v_grupo_comercial;" | tail -1)
eq "A6a fin vê 2 grupos" "$FIN" "2"
NF=$(Pq -c "set test.uid='22222222-2222-2222-2222-222222222222'; set role authenticated; select count(*) from public.v_grupo_comercial;" | tail -1)
eq "A6b NÃO-fin vê 0 (RLS via security_invoker)" "$NF" "0"

# ── ZONA 5 — falsificação ──
echo "── falsificação ──"
# F1: sem filtro de status → cancelado(999)+rascunho(888) entram → A1 vira 350+999+888=2237
P -q <<'SQL'
create or replace view public.v_grupo_comercial with (security_invoker=true) as
with ped as (select regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g') as doc, so.created_at::date data, so.total valor
  from public.sales_orders so join public.profiles p on p.user_id=so.customer_user_id where so.deleted_at is null)  -- SEM where status
select m.grupo_id, count(distinct ped.doc) filter (where ped.doc is not null) documentos_com_compra,
  count(ped.data) qtd_pedidos, max(ped.data) ultima_compra, (current_date-max(ped.data)) dias_desde_ultima,
  coalesce(sum(ped.valor),0) faturamento_total,
  coalesce(sum(ped.valor) filter (where ped.data > current_date-90),0) fat_90d,
  coalesce(sum(ped.valor) filter (where ped.data <= current_date-90 and ped.data > current_date-180),0) fat_90d_anterior,
  round(coalesce(sum(ped.valor) filter (where ped.data > current_date-180),0)/6.0,2) media_mensal_6m
from public.cliente_grupo_membros m left join ped on ped.doc=m.documento group by m.grupo_id;
SQL
eq "F1 sem filtro status → 2237 (prova dente do filtro)" "$(Pq -c "select faturamento_total from public.v_grupo_comercial where grupo_id='$G1';")" "2237"
P -q -f "$MIG_VIEW"
# F2: janela invertida (≤ vira >) → fat_90d pegaria o de 120d → vira 250 (100+200-... ) — prova que a janela tem dente
P -q <<'SQL'
create or replace view public.v_grupo_comercial with (security_invoker=true) as
with ped as (select regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g') as doc, so.created_at::date data, so.total valor
  from public.sales_orders so join public.profiles p on p.user_id=so.customer_user_id
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null)
select m.grupo_id, count(distinct ped.doc) filter (where ped.doc is not null) documentos_com_compra,
  count(ped.data) qtd_pedidos, max(ped.data) ultima_compra, (current_date-max(ped.data)) dias_desde_ultima,
  coalesce(sum(ped.valor),0) faturamento_total,
  coalesce(sum(ped.valor) filter (where ped.data <= current_date-90),0) fat_90d,  -- SABOTAGEM: <= em vez de >
  coalesce(sum(ped.valor) filter (where ped.data <= current_date-90 and ped.data > current_date-180),0) fat_90d_anterior,
  round(coalesce(sum(ped.valor) filter (where ped.data > current_date-180),0)/6.0,2) media_mensal_6m
from public.cliente_grupo_membros m left join ped on ped.doc=m.documento group by m.grupo_id;
SQL
eq "F2 janela invertida → fat_90d=200 (prova dente da janela)" "$(Pq -c "select fat_90d from public.v_grupo_comercial where grupo_id='$G1';")" "200"
P -q -f "$MIG_VIEW"
# F3: sem security_invoker → não-fin vê
P -q <<'SQL'
create or replace view public.v_grupo_comercial with (security_invoker=false) as
with ped as (select regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g') as doc, so.created_at::date data, so.total valor
  from public.sales_orders so join public.profiles p on p.user_id=so.customer_user_id
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null)
select m.grupo_id, count(distinct ped.doc) filter (where ped.doc is not null) documentos_com_compra,
  count(ped.data) qtd_pedidos, max(ped.data) ultima_compra, (current_date-max(ped.data)) dias_desde_ultima,
  coalesce(sum(ped.valor),0) faturamento_total,
  coalesce(sum(ped.valor) filter (where ped.data > current_date-90),0) fat_90d,
  coalesce(sum(ped.valor) filter (where ped.data <= current_date-90 and ped.data > current_date-180),0) fat_90d_anterior,
  round(coalesce(sum(ped.valor) filter (where ped.data > current_date-180),0)/6.0,2) media_mensal_6m
from public.cliente_grupo_membros m left join ped on ped.doc=m.documento group by m.grupo_id;
SQL
eq "F3 sem security_invoker → não-fin vê 2 (prova dente do A6b)" "$(Pq -c "set test.uid='22222222-2222-2222-2222-222222222222'; set role authenticated; select count(*) from public.v_grupo_comercial;" | tail -1)" "2"
P -q -f "$MIG_VIEW"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
