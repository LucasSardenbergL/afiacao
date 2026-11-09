-- Gera db/fixtures/rls-has-role-classe-prod-2026-11-02.sql a partir da PROD (read-only).
-- ~/.config/afiacao/psql-ro -X -A -t -v ON_ERROR_STOP=1 -f db/consultas/rls-has-role-classe-fixture.sql
with alvo as (
  select p.* from pg_policies p
  where p.schemaname='public' and (coalesce(qual,'')||coalesce(with_check,'')) ~ 'has_role\(auth\.uid\(\)'
), pol as (   -- alvo + as policies NÃO-alvo das tabelas que as subqueries leem
  select * from alvo
  union
  select p.* from pg_policies p where p.schemaname='public' and p.tablename in ('commercial_roles','orders')
), tabs as (select distinct tablename t from pol),
cols as (
  select distinct c.table_name t, c.column_name col, format_type(a.atttypid,a.atttypmod) typ, c.ordinal_position
  from pol join information_schema.columns c on c.table_schema='public'
       and (c.table_name=pol.tablename or (coalesce(pol.qual,'')||' '||coalesce(pol.with_check,'')) ~ ('FROM '||c.table_name||'\M'))
       and (coalesce(pol.qual,'')||' '||coalesce(pol.with_check,'')) ~ ('\m'||c.column_name||'\M')
  join pg_attribute a on a.attrelid=('public.'||quote_ident(c.table_name))::regclass and a.attname=c.column_name
)
select linha from (
  select 1 o, '' k, format('CREATE TYPE public.commercial_role AS ENUM (%s);',
         (select string_agg(quote_literal(e::text), ', ' order by e) from unnest(enum_range(null::commercial_role)) e)) linha
  union all
  select 2, t, format('CREATE TABLE public.%I (_k serial PRIMARY KEY%s);', t,
         coalesce((select string_agg(format(', %I %s', col, typ), '' order by ordinal_position) from cols where cols.t=tabs.t), ''))
  from tabs
  union all
  select 3, tablename||policyname, format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
         policyname, tablename, permissive, cmd,
         (select string_agg(case when r='public' then 'public' else quote_ident(r) end, ', ') from unnest(roles) r),
         case when qual is null then '' else ' USING ('||qual||')' end,
         case when with_check is null then '' else ' WITH CHECK ('||with_check||')' end)
  from pol
) x order by o, k;
