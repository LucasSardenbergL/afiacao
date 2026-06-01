-- 20260528132000_tarefas_bloco_c.sql
-- Tarefas — Fase 1, BLOCO C: view de estado derivado (fuso America/Sao_Paulo) + RLS.
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).
-- Pré-requisitos (já em produção): public.pode_ver_carteira_completa(uuid), public.carteira_coverage.

create or replace view public.v_tarefas_estado
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
)
select b.*,
  (b.status = 'aberta' and (now() at time zone 'America/Sao_Paulo')::date > b.effective_due) as atrasada,
  (b.status = 'aberta'
     and (now() at time zone 'America/Sao_Paulo')::date > (b.effective_due + b.tolerancia_dias)
     and b.escalado_em is null) as escalavel,
  exists (select 1 from public.tarefa_satisfacao_candidatos c
          where c.tarefa_id = b.id and c.status = 'pending') as tem_sugestao_pendente
from base b;

alter table public.tarefas enable row level security;
alter table public.tarefa_satisfacao_candidatos enable row level security;
alter table public.tarefa_eventos enable row level security;

create policy tarefas_select on public.tarefas for select to authenticated
using (
  public.pode_ver_carteira_completa((select auth.uid()))
  or assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc
             where cc.covered_user_id = tarefas.assigned_to and cc.covering_user_id = (select auth.uid())
               and cc.active and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until))
);

create policy tarefas_insert on public.tarefas for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.pode_ver_carteira_completa((select auth.uid()))
);

create policy tarefas_update on public.tarefas for update to authenticated
using (
  public.pode_ver_carteira_completa((select auth.uid()))
  or assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc
             where cc.covered_user_id = tarefas.assigned_to and cc.covering_user_id = (select auth.uid())
               and cc.active and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until))
);

create policy tcand_select on public.tarefa_satisfacao_candidatos for select to authenticated
using (exists (select 1 from public.tarefas t where t.id = tarefa_id and (
  public.pode_ver_carteira_completa((select auth.uid())) or t.assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id = t.assigned_to
             and cc.covering_user_id = (select auth.uid()) and cc.active and now() >= cc.valid_from
             and (cc.valid_until is null or now() <= cc.valid_until)))));

create policy tcand_update on public.tarefa_satisfacao_candidatos for update to authenticated
using (exists (select 1 from public.tarefas t where t.id = tarefa_id and (
  public.pode_ver_carteira_completa((select auth.uid())) or t.assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id = t.assigned_to
             and cc.covering_user_id = (select auth.uid()) and cc.active and now() >= cc.valid_from
             and (cc.valid_until is null or now() <= cc.valid_until)))));

create policy tevt_select on public.tarefa_eventos for select to authenticated
using (exists (select 1 from public.tarefas t where t.id = tarefa_id and (
  public.pode_ver_carteira_completa((select auth.uid())) or t.assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id = t.assigned_to
             and cc.covering_user_id = (select auth.uid()) and cc.active and now() >= cc.valid_from
             and (cc.valid_until is null or now() <= cc.valid_until)))));

create policy tevt_insert on public.tarefa_eventos for insert to authenticated
with check (exists (select 1 from public.tarefas t where t.id = tarefa_id and (
  public.pode_ver_carteira_completa((select auth.uid())) or t.assigned_to = (select auth.uid())
  or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id = t.assigned_to
             and cc.covering_user_id = (select auth.uid()) and cc.active and now() >= cc.valid_from
             and (cc.valid_until is null or now() <= cc.valid_until)))));
