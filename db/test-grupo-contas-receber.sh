#!/usr/bin/env bash
# Prova money-path da view v_grupo_contas_receber (Grupo 360 Fase 1, Task 3).
# Migrations REAIS: 20260615120000_cliente_grupos.sql + 20260616120000_v_grupo_contas_receber.sql
# Rode: bash db/test-grupo-contas-receber.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="grupo-contas-receber"
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisitos: user_roles, fin_permissoes, fin_contas_receber (+RLS) e fin_user_can_access ──
P -q <<'SQL'
create table public.user_roles (user_id uuid, role text);
create table public.fin_permissoes (user_id uuid primary key, pode_ver_todas_empresas boolean default false, empresas text[] default '{}');

create table public.fin_contas_receber (
  id uuid primary key default gen_random_uuid(),
  company text,
  cnpj_cpf text,
  nome_cliente text,
  saldo numeric,
  data_vencimento date,
  status_titulo text
);

-- gate real do financeiro (SECURITY DEFINER lê user_roles/fin_permissoes como definer)
create or replace function public.fin_user_can_access(check_company text default null)
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare v_perm record;
begin
  if exists (select 1 from user_roles where user_id = auth.uid() and role in ('admin','manager','employee','master')) then
    return true;
  end if;
  select * into v_perm from fin_permissoes where user_id = auth.uid();
  if v_perm is null then return false; end if;
  if check_company is null then return true; end if;
  return v_perm.pode_ver_todas_empresas or check_company = any(v_perm.empresas);
end; $$;

-- RLS de fin_contas_receber (mesmo gate); a view security_invoker tem que respeitar isto
alter table public.fin_contas_receber enable row level security;
create policy fcr_service on public.fin_contas_receber for all using (auth.role() = 'service_role');
create policy fcr_fin on public.fin_contas_receber for select using (public.fin_user_can_access(company));
SQL

# ── ZONA 2 — aplicar as migrations REAIS (Lei #1) ──
P -q -f "$REPO_ROOT/supabase/migrations/20260615120000_cliente_grupos.sql"
MIG_VIEW="$REPO_ROOT/supabase/migrations/20260616120000_v_grupo_contas_receber.sql"
P -q -f "$MIG_VIEW"
echo "migrations aplicadas (tabelas + view)"

# ── ZONA 3 — seeds + grants ──
P -q <<'SQL'
insert into auth.users(id) values
  ('11111111-1111-1111-1111-111111111111'),  -- fin user (employee)
  ('22222222-2222-2222-2222-222222222222')   -- não-fin
  on conflict do nothing;
insert into public.user_roles(user_id, role) values
  ('11111111-1111-1111-1111-111111111111','employee');  -- só o fin user tem role

-- grupos
insert into public.cliente_grupos(id, nome) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Dono G1'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Dono G2');
-- membros: G1 = {CNPJ, CPF}; G2 = {outro CNPJ}
insert into public.cliente_grupo_membros(grupo_id, documento, relation_type) values
  ('aaaaaaaa-0000-0000-0000-000000000001','12345678000199','multi_ativo'),
  ('aaaaaaaa-0000-0000-0000-000000000001','11122233344','sucessao'),
  ('aaaaaaaa-0000-0000-0000-000000000002','98765432000111','incerto');

-- títulos: cross-empresa, aging, status excluídos, CPF, formatado, e um SEM grupo (vazamento)
insert into public.fin_contas_receber(company, cnpj_cpf, nome_cliente, saldo, data_vencimento, status_titulo) values
  ('colacor','12.345.678/0001-99','CNPJ formatado', 100, current_date + 10, 'A VENCER'),   -- a_vencer + normalização
  ('oben',   '12345678000199',    'CNPJ oben',       50, current_date - 45, 'ATRASADO'),    -- venc_31_60 + cross-empresa
  ('colacor','111.222.333-44',    'CPF formatado',   30, current_date,      'VENCE HOJE'),  -- a_vencer + CPF + normalização
  ('colacor','12345678000199',    'CNPJ recebido',  999, current_date - 5,  'RECEBIDO'),    -- EXCLUÍDO
  ('colacor','12345678000199',    'CNPJ cancelado', 888, current_date - 5,  'CANCELADO'),   -- EXCLUÍDO
  ('oben',   '98765432000111',    'G2',              70, current_date + 5,  'A VENCER'),    -- G2
  ('colacor','99999999000199',    'Sem grupo',      777, current_date + 5,  'A VENCER');    -- VAZAMENTO (não pode aparecer)

grant select on public.cliente_grupos, public.cliente_grupo_membros, public.fin_contas_receber,
  public.v_grupo_contas_receber, public.v_grupo_contas_receber_por_doc to authenticated;
SQL

# ── ZONA 4 — asserts (como postgres = superuser, vê tudo: prova a matemática) ──
echo "── asserts ──"
V=$(Pq -c "select total_aberto from public.v_grupo_contas_receber where grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A1 total_aberto G1 soma across empresa (100+50+30)" "$V" "180"

AV=$(Pq -c "select a_vencer from public.v_grupo_contas_receber where grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A2a a_vencer G1 (100 colacor futuro + 30 cpf hoje)" "$AV" "130"
V3060=$(Pq -c "select venc_31_60 from public.v_grupo_contas_receber where grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A2b venc_31_60 G1 (50 oben 45d)" "$V3060" "50"

SUMALL=$(Pq -c "select coalesce(sum(total_aberto),0) from public.v_grupo_contas_receber;")
eq "A3 sum de todos grupos = 250 (G1 180 + G2 70; SEM o 777 órfão e SEM recebido/cancelado)" "$SUMALL" "250"

DOCSUM=$(Pq -c "select coalesce(sum(total_aberto),0) from public.v_grupo_contas_receber_por_doc where documento='12345678000199' and grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A4 por-doc: CNPJ soma 150 (100+50, 2 empresas)" "$DOCSUM" "150"

LEAK=$(Pq -c "select count(*) from public.v_grupo_contas_receber_por_doc where documento='99999999000199';")
eq "A5 vazamento: documento órfão (777) NÃO aparece" "$LEAK" "0"

# A7 RLS (security_invoker): fin vê, não-fin não vê
FINCNT=$(Pq -c "set test.uid='11111111-1111-1111-1111-111111111111'; set role authenticated; select count(*) from public.v_grupo_contas_receber;" | tail -1)
eq "A7a fin (employee) vê os 2 grupos" "$FINCNT" "2"
NFCNT=$(Pq -c "set test.uid='22222222-2222-2222-2222-222222222222'; set role authenticated; select count(*) from public.v_grupo_contas_receber;" | tail -1)
eq "A7b NÃO-fin vê 0 (RLS via security_invoker)" "$NFCNT" "0"

# ── ZONA 5 — FALSIFICAÇÃO (sabota → exige vermelho → restaura) ──
echo "── falsificação ──"

# F1: join furado (t.doc = m.id::text nunca casa) → A1 deveria virar 0
P -q <<'SQL'
create or replace view public.v_grupo_contas_receber with (security_invoker = true) as
with tit as (select regexp_replace(fcr.cnpj_cpf,'\D','','g') as doc, fcr.saldo, fcr.data_vencimento
             from public.fin_contas_receber fcr where fcr.status_titulo <> all (array['RECEBIDO','CANCELADO']))
select g.id as grupo_id, g.nome, 0::bigint as documentos_com_titulo,
  coalesce(sum(t.saldo),0) as total_aberto, 0::numeric a_vencer, 0::numeric venc_1_30,
  0::numeric venc_31_60, 0::numeric venc_61_90, 0::numeric venc_90_mais
from public.cliente_grupos g join public.cliente_grupo_membros m on m.grupo_id=g.id
left join tit t on t.doc = m.id::text   -- SABOTAGEM: id (uuid) nunca = doc (dígitos)
where g.ativo group by g.id, g.nome;
SQL
VF=$(Pq -c "select total_aberto from public.v_grupo_contas_receber where grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "F1 join furado → 0 (prova que A1 tem dente)" "$VF" "0"
P -q -f "$MIG_VIEW"  # restaura

# F2: sem o filtro de status → recebido(999)+cancelado(888) entram → 2067
P -q <<'SQL'
create or replace view public.v_grupo_contas_receber with (security_invoker = true) as
with tit as (select regexp_replace(fcr.cnpj_cpf,'\D','','g') as doc, fcr.saldo, fcr.data_vencimento
             from public.fin_contas_receber fcr)   -- SABOTAGEM: sem WHERE status
select g.id as grupo_id, g.nome, 0::bigint documentos_com_titulo,
  coalesce(sum(t.saldo),0) as total_aberto, 0::numeric a_vencer, 0::numeric venc_1_30,
  0::numeric venc_31_60, 0::numeric venc_61_90, 0::numeric venc_90_mais
from public.cliente_grupos g join public.cliente_grupo_membros m on m.grupo_id=g.id
left join tit t on t.doc = m.documento where g.ativo group by g.id, g.nome;
SQL
VF2=$(Pq -c "select total_aberto from public.v_grupo_contas_receber where grupo_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "F2 sem filtro status → 2067 (180+999+888; prova dente do filtro)" "$VF2" "2067"
P -q -f "$MIG_VIEW"  # restaura

# F3: sem security_invoker → não-fin passa a ver (RLS deixa de aplicar)
P -q <<'SQL'
create or replace view public.v_grupo_contas_receber with (security_invoker = false) as
with tit as (select regexp_replace(fcr.cnpj_cpf,'\D','','g') as doc, fcr.saldo, fcr.data_vencimento
             from public.fin_contas_receber fcr where fcr.status_titulo <> all (array['RECEBIDO','CANCELADO']))
select g.id as grupo_id, g.nome, 0::bigint documentos_com_titulo,
  coalesce(sum(t.saldo),0) as total_aberto, 0::numeric a_vencer, 0::numeric venc_1_30,
  0::numeric venc_31_60, 0::numeric venc_61_90, 0::numeric venc_90_mais
from public.cliente_grupos g join public.cliente_grupo_membros m on m.grupo_id=g.id
left join tit t on t.doc = m.documento where g.ativo group by g.id, g.nome;
SQL
NFF=$(Pq -c "set test.uid='22222222-2222-2222-2222-222222222222'; set role authenticated; select count(*) from public.v_grupo_contas_receber;" | tail -1)
eq "F3 sem security_invoker → não-fin vê 2 (prova dente do A7b)" "$NFF" "2"
P -q -f "$MIG_VIEW"  # restaura

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
