-- 20260528130000_tarefas_bloco_a.sql
-- Tarefas — Fase 1, BLOCO A: tabela fonte-da-verdade `tarefas`.
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).

create table if not exists public.tarefas (
  id uuid primary key default gen_random_uuid(),
  descricao text not null,
  categoria text not null check (categoria in ('ligar','oferecer','preco','whatsapp','outro')),
  customer_user_id uuid not null,
  assigned_to uuid not null,
  created_by uuid not null,
  empresa text not null,
  modo text not null check (modo in ('data','interacao')),
  due_date date,
  interacao_tipo text check (interacao_tipo in ('ligacao','visita','entrega')),
  backstop_days int not null default 7,
  tolerancia_dias int not null default 1,
  adiada_para timestamptz,
  motivo_adiamento text,
  auto_satisfy_mode text not null default 'off' check (auto_satisfy_mode in ('off','interacao','conteudo')),
  target_produto_id uuid,
  target_texto text,
  target_preco_centavos bigint,
  target_tags jsonb,
  status text not null default 'aberta' check (status in ('aberta','concluida','cancelada')),
  concluida_em timestamptz,
  concluida_por uuid,
  conclusao_origem text check (conclusao_origem in ('manual','auto_interacao','sugestao_confirmada','whatsapp')),
  nota_conclusao text,
  escalado_em timestamptz,
  template_id uuid,
  requer_comprovacao boolean not null default false,
  comprovacao_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tarefas_modo_coerencia_chk check (
    (modo = 'data' and due_date is not null and interacao_tipo is null)
    or (modo = 'interacao' and interacao_tipo is not null and due_date is null)
  )
);

create index if not exists idx_tarefas_assigned_aberta on public.tarefas (assigned_to) where status = 'aberta';
create index if not exists idx_tarefas_created_by on public.tarefas (created_by);
create index if not exists idx_tarefas_customer_aberta on public.tarefas (customer_user_id) where status = 'aberta';
create index if not exists idx_tarefas_aberta_auto on public.tarefas (auto_satisfy_mode) where status = 'aberta';
