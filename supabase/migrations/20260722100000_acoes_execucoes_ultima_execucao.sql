-- Registro genérico de execuções de ações globais (sincronizar/importar/recalcular).
-- Alimenta a caption <UltimaExecucao> em botões de ação (spec 2026-07-18-ultima-execucao-acoes-design.md).
-- Escritores: frontend staff (RLS, origem='manual') e edges via service_role (bypassa RLS;
-- origem conforme authorizeCronOrStaff). Regra: cada slug de acao tem UM escritor.
create table public.acoes_execucoes (
  id uuid primary key default gen_random_uuid(),
  acao text not null,
  origem text not null default 'manual' check (origem in ('manual', 'automatica')),
  executado_por uuid references auth.users (id) on delete set null,
  executado_por_nome text,
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  status text not null default 'executando' check (status in ('executando', 'sucesso', 'erro')),
  detalhes jsonb
);

create index acoes_execucoes_acao_idx on public.acoes_execucoes (acao, iniciado_em desc);

alter table public.acoes_execucoes enable row level security;

-- Staff lê tudo (mesmo idioma das tabelas operacionais, ex.: sync_state).
create policy "Staff le execucoes"
  on public.acoes_execucoes
  for select
  using (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role));

-- Staff registra a PRÓPRIA execução manual (edges gravam via service_role, que bypassa RLS).
create policy "Staff registra execucao propria"
  on public.acoes_execucoes
  for insert
  with check (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
    and origem = 'manual'
  );

-- Staff fecha a PRÓPRIA execução (status/finalizado_em/detalhes).
create policy "Staff fecha execucao propria"
  on public.acoes_execucoes
  for update
  using (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
  )
  with check (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
  );

-- DELETE: sem policy — ninguém apaga via PostgREST.

-- Grants: REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito do Supabase) —
-- revogar POR NOME (armadilha do CLAUDE.md; incidente #1375).
revoke all on public.acoes_execucoes from public, anon, authenticated;
grant select, insert, update on public.acoes_execucoes to authenticated;
grant all on public.acoes_execucoes to service_role;
