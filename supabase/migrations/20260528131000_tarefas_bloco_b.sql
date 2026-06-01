-- 20260528131000_tarefas_bloco_b.sql
-- Tarefas — Fase 1, BLOCO B: candidatos (evidências/sugestões) + eventos (auditoria).
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).

create table if not exists public.tarefa_satisfacao_candidatos (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  source_type text not null check (source_type in ('farmer_call','route_visit','whatsapp','quote')),
  source_id uuid,
  mode text not null check (mode in ('interacao','conteudo')),
  confidence numeric,
  motivo text,
  matched_payload jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  constraint tarefa_candidato_fonte_unq unique (tarefa_id, source_type, source_id)
);
create index if not exists idx_candidato_tarefa_pending on public.tarefa_satisfacao_candidatos (tarefa_id) where status = 'pending';

create table if not exists public.tarefa_eventos (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.tarefas(id) on delete cascade,
  tipo_evento text not null,
  ator uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_evento_tarefa on public.tarefa_eventos (tarefa_id, created_at desc);
