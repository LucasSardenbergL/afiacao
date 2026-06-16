-- 20260601102000_tarefas_fase2_bloco_c.sql
-- FIX 1: DROP + CREATE dentro de transação (evita falha de REPLACE quando BLOCO B adicionou
-- colunas em `tarefas` — o `select t.*` da view desloca colunas derivadas e o REPLACE falha).

begin;
drop view if exists public.v_tarefas_estado;
create view public.v_tarefas_estado
with (security_invoker = on) as
with base as (
  select t.*,
    coalesce(
      (t.adiada_para at time zone 'America/Sao_Paulo')::date,
      t.due_date,
      (t.created_at at time zone 'America/Sao_Paulo')::date + t.backstop_days
    ) as effective_due,
    coalesce(
      (select cc.covering_user_id from public.carteira_coverage cc
        where cc.covered_user_id = t.assigned_to and cc.active
          and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
        order by cc.valid_from desc limit 1),
      t.assigned_to
    ) as responsavel_efetivo
  from public.tarefas t
), nowsp as (
  select (now() at time zone 'America/Sao_Paulo')::date as dia,
         (now() at time zone 'America/Sao_Paulo')::time as hora
)
select b.*,
  (b.status = 'aberta' and (
     n.dia > b.effective_due
     or (n.dia = b.effective_due and b.janela_fim is not null and n.hora > b.janela_fim)
  )) as atrasada,
  (b.status = 'aberta' and b.escalado_em is null and (
     n.dia > (b.effective_due + b.tolerancia_dias)
     or (b.tolerancia_dias = 0 and n.dia = b.effective_due and b.janela_fim is not null and n.hora > b.janela_fim)
  )) as escalavel,
  exists (select 1 from public.tarefa_satisfacao_candidatos c
          where c.tarefa_id = b.id and c.status = 'pending') as tem_sugestao_pendente,
  (b.auditoria_status = 'pendente') as requer_auditoria
from base b cross join nowsp n;
commit;

-- RLS de tarefa_templates: operador vê os dele; gestor/master gerencia.
-- (Policies ficam fora da transação — ddl sobre tabela nova, sem dependência da view)
alter table public.tarefa_templates enable row level security;
create policy tt_select on public.tarefa_templates for select to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())) or assigned_to = (select auth.uid()));
create policy tt_insert on public.tarefa_templates for insert to authenticated
with check (public.pode_ver_carteira_completa((select auth.uid())) and created_by = (select auth.uid()));
create policy tt_update on public.tarefa_templates for update to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())));
create policy tt_delete on public.tarefa_templates for delete to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())));

select 'F2 BLOCO C OK' as status,
  (select count(*) from pg_views where viewname='v_tarefas_estado' and definition ilike '%janela_fim%') as view_janela_ok,
  (select count(*) from pg_views where viewname='v_tarefas_estado' and definition ilike '%requer_auditoria%') as view_audit_ok,
  (select count(*) from pg_policies where tablename='tarefa_templates') as policies;
-- Expected: view_janela_ok=1, view_audit_ok=1, policies=4
