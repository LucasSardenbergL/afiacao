-- Grupo de Cliente 360 — Fase 1: tabelas de agrupamento de documentos (CNPJ/CPF) do mesmo dono.
-- Spec: docs/superpowers/specs/2026-06-15-grupo-cliente-360-design.md
-- ATENÇÃO: migration custom — aplicar manualmente no Lovable SQL Editor (não aplica sozinha).

-- ============================================================
-- 1. Tabelas
-- ============================================================

-- cliente_grupos: um dono/grupo (identidade única que atravessa as 3 empresas)
create table if not exists public.cliente_grupos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  notas text,
  ativo boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- cliente_grupo_membros: os documentos (CNPJ/CPF) do grupo
create table if not exists public.cliente_grupo_membros (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.cliente_grupos(id) on delete cascade,
  documento text not null,                          -- SÓ DÍGITOS (CPF=11 / CNPJ=14)
  relation_type text not null default 'incerto'
    check (relation_type in ('sucessao','multi_ativo','incerto')),
  valid_from date,
  valid_to date,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz default now(),
  note text,
  created_at timestamptz not null default now(),
  -- 1 documento pertence a no máximo UM grupo (mata transitividade A=B,B=C)
  constraint cliente_grupo_membros_documento_key unique (documento),
  -- guard: documento só dígitos, tamanho de CPF ou CNPJ
  constraint cliente_grupo_membros_documento_digits
    check (documento ~ '^[0-9]+$' and char_length(documento) in (11, 14))
);

create index if not exists idx_cgm_grupo on public.cliente_grupo_membros(grupo_id);
create index if not exists idx_cgm_documento on public.cliente_grupo_membros(documento);

-- ============================================================
-- 2. updated_at trigger (self-contained — não há função compartilhada no repo)
-- ============================================================
create or replace function public.cliente_grupos_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cliente_grupos_updated_at on public.cliente_grupos;
create trigger trg_cliente_grupos_updated_at
  before update on public.cliente_grupos
  for each row execute function public.cliente_grupos_set_updated_at();

-- ============================================================
-- 3. RLS — mesmo gate do financeiro (fin_user_can_access) + service_role bypass.
--    fin_user_can_access() com company NULL = acesso geral ao financeiro:
--    staff (admin/manager/employee/master) passa; demais via fin_permissoes.
--    A restrição fina (só gestor gere/vê) é reforçada no app (rota), como nas telas fin_*.
-- ============================================================
alter table public.cliente_grupos enable row level security;
alter table public.cliente_grupo_membros enable row level security;

create policy "cliente_grupos_service" on public.cliente_grupos
  for all using (auth.role() = 'service_role');
create policy "cliente_grupos_fin_access" on public.cliente_grupos
  for all using (public.fin_user_can_access())
  with check (public.fin_user_can_access());

create policy "cgm_service" on public.cliente_grupo_membros
  for all using (auth.role() = 'service_role');
create policy "cgm_fin_access" on public.cliente_grupo_membros
  for all using (public.fin_user_can_access())
  with check (public.fin_user_can_access());
