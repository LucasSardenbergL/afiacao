-- 20260601100000_tarefas_fase2_bloco_a.sql
create table if not exists public.tarefa_templates (
  id uuid primary key default gen_random_uuid(),
  descricao text not null,
  categoria text not null check (categoria in ('ligar','oferecer','preco','whatsapp','outro')),
  area text not null,
  empresa text not null,
  assigned_to uuid not null,
  customer_user_id uuid,                       -- nullable: ops recorrente não tem cliente
  cadencia text not null check (cadencia in ('diaria','dias_uteis','semanal','dias_especificos')),
  dias_semana int[],                           -- 0=dom..6=sáb (semanal/dias_especificos)
  janela_inicio time,
  janela_fim time,
  tolerancia_dias int not null default 0,
  requer_comprovacao boolean not null default false,
  tipo_comprovacao text not null default 'nenhuma' check (tipo_comprovacao in ('nenhuma','foto','leitura','foto_e_leitura')),
  leitura_min numeric,
  leitura_max numeric,
  leitura_unidade text,
  alto_risco boolean not null default false,
  amostra_auditoria_pct int not null default 10 check (amostra_auditoria_pct between 0 and 100),
  reincidente_limite int not null default 3,
  supervisor_user_id uuid,
  ativo boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tt_janela_chk check (janela_inicio is null or janela_fim is null or janela_inicio < janela_fim),
  constraint tt_dias_chk check (cadencia not in ('semanal','dias_especificos') or (dias_semana is not null and array_length(dias_semana,1) > 0)),
  constraint tt_altorisco_foto_chk check (not alto_risco or tipo_comprovacao = 'foto_e_leitura' or not requer_comprovacao)
);
create index if not exists idx_tt_ativo_assigned on public.tarefa_templates (assigned_to) where ativo;

select 'F2 BLOCO A OK' as status,
  to_regclass('public.tarefa_templates') is not null as tbl_ok,
  (select count(*) from information_schema.columns where table_name='tarefa_templates') as colunas;
-- Expected: tbl_ok=true, colunas=26
