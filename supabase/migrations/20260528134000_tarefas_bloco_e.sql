-- 20260528134000_tarefas_bloco_e.sql
-- Tarefas — Fase 1, BLOCO E: seed dos defaults globais em company_config (fecha o Marco 1).
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).
-- Idempotente sem depender de UNIQUE(key): update-then-insert-if-absent.
-- Defaults aprovados pelo founder: backstop = 7 dias, tolerância = 1 dia.

update public.company_config set value='7', updated_at=now()
  where key='tarefas_backstop_dias_default';
insert into public.company_config (key, value)
  select 'tarefas_backstop_dias_default', '7'
  where not exists (select 1 from public.company_config where key='tarefas_backstop_dias_default');

update public.company_config set value='1', updated_at=now()
  where key='tarefas_tolerancia_dias_default';
insert into public.company_config (key, value)
  select 'tarefas_tolerancia_dias_default', '1'
  where not exists (select 1 from public.company_config where key='tarefas_tolerancia_dias_default');
