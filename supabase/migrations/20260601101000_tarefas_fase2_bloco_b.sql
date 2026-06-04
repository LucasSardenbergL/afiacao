-- 20260601101000_tarefas_fase2_bloco_b.sql
alter table public.tarefas
  add column if not exists tipo_comprovacao text,
  add column if not exists comprovacao_leitura numeric,
  add column if not exists comprovacao_em timestamptz,
  add column if not exists janela_fim time,
  add column if not exists auditoria_status text not null default 'nao_requer'
    check (auditoria_status in ('nao_requer','dispensada','pendente','aprovada','reprovada')),
  add column if not exists auditoria_motivo text,
  add column if not exists auditada_por uuid,
  add column if not exists auditada_em timestamptz,
  add column if not exists supervisor_user_id uuid;

-- ops recorrente não tem cliente → customer_user_id passa a ser nullable
alter table public.tarefas alter column customer_user_id drop not null;

-- estende o CHECK de conclusao_origem c/ 'comprovacao'
do $$ declare cn text; begin
  select conname into cn from pg_constraint where conrelid='public.tarefas'::regclass and contype='c'
    and pg_get_constraintdef(oid) ilike '%conclusao_origem%';
  if cn is not null then execute format('alter table public.tarefas drop constraint %I', cn); end if;
end $$;
alter table public.tarefas add constraint tarefas_conclusao_origem_check
  check (conclusao_origem is null or conclusao_origem in ('manual','auto_interacao','sugestao_confirmada','whatsapp','comprovacao'));

-- idempotência da materialização (codex P1 #2: inclui assigned_to)
create unique index if not exists uq_tarefa_template_assignee_dia
  on public.tarefas (template_id, assigned_to, due_date) where template_id is not null;

select 'F2 BLOCO B OK' as status,
  (select is_nullable from information_schema.columns where table_name='tarefas' and column_name='customer_user_id') as customer_nullable,
  (select count(*) from information_schema.columns where table_name='tarefas' and column_name in
    ('tipo_comprovacao','comprovacao_leitura','comprovacao_em','janela_fim','auditoria_status','auditoria_motivo','auditada_por','auditada_em','supervisor_user_id')) as cols_novas,
  (pg_get_constraintdef(oid) ilike '%comprovacao%' from pg_constraint where conrelid='public.tarefas'::regclass and conname='tarefas_conclusao_origem_check') as origem_ok,
  to_regclass('public.uq_tarefa_template_assignee_dia') is not null as uq_ok;
-- Expected: customer_nullable=YES, cols_novas=9, origem_ok=true, uq_ok=true
