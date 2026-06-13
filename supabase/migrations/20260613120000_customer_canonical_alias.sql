-- Consolidação dos clientes duplicados (clones do import de março) — Fase 1: tabela de apelidos.
-- Spec: docs/superpowers/specs/2026-06-13-consolidacao-clientes-duplicados-design.md
-- Estratégia "B-lite" (validada pelo Codex): NÃO funde fisicamente. Mapeia o clone vazio (alias) → o
-- cliente real com nome (canonical). Só o carteira-rebuild (Fase 2) lê esta tabela p/ canonicalizar a
-- projeção da carteira. Esta migration SÓ CRIA a tabela — vazia e inerte; nada muda até a action popular
-- (status='inactive') e a Fase 2 começar a ler aliases ATIVOS.
--
-- ⚠️ Migration manual: colar no SQL Editor do Lovable → Run.

create table if not exists public.customer_canonical_alias (
  alias_user_id          uuid primary key,        -- clone (omie_clientes SEM profile)
  canonical_user_id      uuid not null,           -- gêmeo (com profile/nome/histórico) — sobrevivente
  documento              text,                    -- CNPJ/CPF normalizado (auditoria do casamento)
  alias_omie_codigo      bigint,                  -- código Omie do clone (X)
  alias_conta            text,                    -- conta Omie onde o clone casou (vendas/colacor_vendas/servicos)
  canonical_omie_codigo  bigint,                  -- código Omie do gêmeo (Y), se conhecido
  canonical_conta        text,                    -- conta Omie do gêmeo (p/ mesma-conta vs cross-account)
  status                 text not null default 'inactive'
                           check (status in ('active','inactive','conflict')),
  reason                 text,                    -- por que inativo/conflito (auditoria)
  batch_id               text,                    -- lote de geração (canário/levas)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint cca_no_self check (alias_user_id <> canonical_user_id)
);

-- Agrupar por canônico (o rebuild substitui alias→canonical e agrupa) e filtrar ativos rápido.
create index if not exists idx_cca_canonical on public.customer_canonical_alias (canonical_user_id);
create index if not exists idx_cca_status_active on public.customer_canonical_alias (status) where status = 'active';

alter table public.customer_canonical_alias enable row level security;

-- Leitura: gestor/master (mesma régua da carteira). Escrita: só service_role (a action de mapa e o
-- carteira-rebuild rodam como service_role e bypassam a RLS) — humano nunca grava o apelido à mão.
drop policy if exists "cca_select_gestor_master" on public.customer_canonical_alias;
create policy "cca_select_gestor_master" on public.customer_canonical_alias
  for select to authenticated
  using ((select public.pode_ver_carteira_completa((select auth.uid()))));

-- Validação (colar junto):
-- select 'cca_ok' as check, count(*) as linhas,
--        (select count(*) from pg_policies where tablename='customer_canonical_alias') as policies
-- from public.customer_canonical_alias;
