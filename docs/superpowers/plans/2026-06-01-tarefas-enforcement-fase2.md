# Tarefas — Enforcement de Atividades (Fase 2) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

> 🔴 **GATE DE SEQUÊNCIA (decisão eu+codex):** **NÃO começar a implementação até a Fase 1 ser verificada visualmente em produção** (não empilhar código sobre base não-clicada). Este plano fica pronto pra executar no momento em que a Fase 1 for validada.

**Goal:** Forçar atividades a serem feitas em todas as áreas — **recorrência + trava de comprovação (foto/leitura+faixa) + escalação com janela**, com "anexou = feito + auditoria por exceção". Estende o motor da Fase 1; flagship = operador de tinta.

**Architecture:** Backend SQL puro + pg_cron + 2 RPCs (`concluir_com_comprovacao`/`auditar_tarefa`) + trigger anti-bypass + cron de materialização. Tabela nova `tarefa_templates` (definição recorrente) materializa instâncias na `tarefas` da Fase 1. Frontend: fluxo de prova (PhotoUpload→Storage + leitura validada) no `/tintometrico`, lista de auditoria do gestor, CRUD de templates.

**Tech Stack:** React+TS+Vite+Supabase, pg_cron, Storage. Spec: `docs/superpowers/specs/2026-05-31-tarefas-enforcement-fase2-design.md`.

> ⚠️ **Lovable:** migrations manuais (SQL Editor), edge functions via chat — **mas esta fase não tem edge function nova**. Crons = chamadas SQL locais. Cada Task de backend entrega o bloco inline + validação. Tipos do Supabase: tabela/RPCs novas usam cast `as never` no front até regenerar.

---

## Milestone 1 — Backend (SQL via SQL Editor). Shippable/testável por si.

### Task 1: BLOCO A — `tarefa_templates`

**Files:** Create `supabase/migrations/20260601100000_tarefas_fase2_bloco_a.sql`

- [ ] **Step 1: DDL**

```sql
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
```
> `tt_altorisco_foto_chk`: alto-risco com comprovação exige `foto_e_leitura` (codex P2 #8 — leitura sozinha é auto-atestado).

- [ ] **Step 2: inline + Run** (🟣 Lovable → SQL Editor). **Step 3: validação**

```sql
select 'F2 BLOCO A OK' as status,
  to_regclass('public.tarefa_templates') is not null as tbl_ok,
  (select count(*) from information_schema.columns where table_name='tarefa_templates') as colunas;
```
Expected: `tbl_ok=true`, `colunas=26`.

- [ ] **Step 4: commit** `git commit -m "feat(tarefas-f2): BLOCO A — tarefa_templates (migration manual)"`

---

### Task 2: BLOCO B — colunas de prova/auditoria em `tarefas` + nullable customer + CHECK + UNIQUE

**Files:** Create `supabase/migrations/20260601101000_tarefas_fase2_bloco_b.sql`

- [ ] **Step 1: ALTERs**

```sql
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
```

- [ ] **Step 2: inline + Run. Step 3: validação**

```sql
select 'F2 BLOCO B OK' as status,
  (select is_nullable from information_schema.columns where table_name='tarefas' and column_name='customer_user_id') as customer_nullable,
  (select count(*) from information_schema.columns where table_name='tarefas' and column_name in
    ('tipo_comprovacao','comprovacao_leitura','comprovacao_em','janela_fim','auditoria_status','auditoria_motivo','auditada_por','auditada_em','supervisor_user_id')) as cols_novas,
  (pg_get_constraintdef(oid) ilike '%comprovacao%' from pg_constraint where conrelid='public.tarefas'::regclass and conname='tarefas_conclusao_origem_check') as origem_ok,
  to_regclass('public.uq_tarefa_template_assignee_dia') is not null as uq_ok;
```
Expected: `customer_nullable=YES`, `cols_novas=9`, `origem_ok=true`, `uq_ok=true`.

- [ ] **Step 4: commit** `git commit -m "feat(tarefas-f2): BLOCO B — colunas de prova + customer nullable + CHECK + UNIQUE"`

---

### Task 3: BLOCO C — view `v_tarefas_estado` window-aware + RLS de `tarefa_templates`

**Files:** Create `supabase/migrations/20260601102000_tarefas_fase2_bloco_c.sql`

- [ ] **Step 1: CREATE OR REPLACE da view (janela intradiária) + RLS**

```sql
-- 20260601102000_tarefas_fase2_bloco_c.sql
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

-- RLS de tarefa_templates: operador vê os dele; gestor/master gerencia.
alter table public.tarefa_templates enable row level security;
create policy tt_select on public.tarefa_templates for select to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())) or assigned_to = (select auth.uid()));
create policy tt_insert on public.tarefa_templates for insert to authenticated
with check (public.pode_ver_carteira_completa((select auth.uid())) and created_by = (select auth.uid()));
create policy tt_update on public.tarefa_templates for update to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())));
create policy tt_delete on public.tarefa_templates for delete to authenticated
using (public.pode_ver_carteira_completa((select auth.uid())));
```
> ⚠️ A view é window-aware: `escalavel` agora dispara **no mesmo dia** pra tarefa com `janela_fim` e `tolerancia_dias=0` (o cron das 18h pega) — é o que faz "antes das 9h" virar cobrança no dia.

- [ ] **Step 2: inline + Run. Step 3: validação**

```sql
select 'F2 BLOCO C OK' as status,
  (select count(*) from pg_views where viewname='v_tarefas_estado' and definition ilike '%janela_fim%') as view_janela_ok,
  (select count(*) from pg_views where viewname='v_tarefas_estado' and definition ilike '%requer_auditoria%') as view_audit_ok,
  (select count(*) from pg_policies where tablename='tarefa_templates') as policies;
```
Expected: `view_janela_ok=1`, `view_audit_ok=1`, `policies=4`.

- [ ] **Step 4: commit** `git commit -m "feat(tarefas-f2): BLOCO C — view window-aware + RLS de tarefa_templates"`

---

### Task 4: BLOCO D — trigger anti-bypass + RPCs (concluir/auditar) + materialização + cron

**Files:** Create `supabase/migrations/20260601103000_tarefas_fase2_bloco_d.sql`

> ⚠️ O gate anti-bypass depende do **owner das funções SECURITY DEFINER**. No Supabase (SQL Editor), funções nascem owned por `postgres` → dentro do DEFINER `current_user='postgres'`. **Confirme o owner** com `select proowner::regrole from pg_proc where proname='concluir_com_comprovacao';` após criar — se não for `postgres`, ajuste o allowlist do trigger.

- [ ] **Step 1: SQL (trigger + 2 RPCs + materializador + cron)**

```sql
-- 20260601103000_tarefas_fase2_bloco_d.sql

-- (1) Trigger anti-bypass: conclusão/colunas de prova só via RPC (owner) ou service_role.
create or replace function public.tarefas_guard_comprovacao()
returns trigger language plpgsql security invoker as $$
begin
  if coalesce(new.requer_comprovacao, false) then
    if new.status = 'concluida' and old.status is distinct from 'concluida'
       and current_user not in ('postgres','service_role','supabase_admin') then
      raise exception 'Tarefa com comprovação só conclui via concluir_com_comprovacao()';
    end if;
    if current_user not in ('postgres','service_role','supabase_admin') and (
         new.comprovacao_url       is distinct from old.comprovacao_url
      or new.comprovacao_leitura   is distinct from old.comprovacao_leitura
      or new.comprovacao_em        is distinct from old.comprovacao_em
      or new.auditoria_status      is distinct from old.auditoria_status
      or new.auditada_por          is distinct from old.auditada_por
      or new.requer_comprovacao    is distinct from old.requer_comprovacao
    ) then
      raise exception 'Campos de comprovação/auditoria só mudam via RPC';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tarefas_guard_comprovacao on public.tarefas;
create trigger trg_tarefas_guard_comprovacao
  before update on public.tarefas
  for each row execute function public.tarefas_guard_comprovacao();

-- (2) Conclusão com prova (o enforcement). SECURITY DEFINER.
create or replace function public.concluir_com_comprovacao(p_tarefa_id uuid, p_url text default null, p_leitura numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare t record; tt record; v_uid uuid := auth.uid(); v_audit text := 'nao_requer'; v_reinc int;
begin
  select * into t from public.tarefas where id = p_tarefa_id for update;
  if not found then raise exception 'Tarefa não encontrada'; end if;
  if not ( t.assigned_to = v_uid
           or public.pode_ver_carteira_completa(v_uid)
           or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id=t.assigned_to
                      and cc.covering_user_id=v_uid and cc.active and now()>=cc.valid_from
                      and (cc.valid_until is null or now()<=cc.valid_until)) ) then
    raise exception 'Sem permissão para concluir esta tarefa';
  end if;
  if t.status <> 'aberta' then raise exception 'Tarefa não está aberta (status=%)', t.status; end if;

  if coalesce(t.requer_comprovacao,false) then
    select * into tt from public.tarefa_templates where id = t.template_id;
    if t.tipo_comprovacao in ('foto','foto_e_leitura') and (p_url is null or btrim(p_url)='') then
      raise exception 'Foto de comprovação obrigatória';
    end if;
    if t.tipo_comprovacao in ('leitura','foto_e_leitura') then
      if p_leitura is null then raise exception 'Leitura obrigatória'; end if;
      if (tt.leitura_min is not null and p_leitura < tt.leitura_min)
         or (tt.leitura_max is not null and p_leitura > tt.leitura_max) then
        raise exception 'Leitura % fora da faixa [%, %]', p_leitura, tt.leitura_min, tt.leitura_max;
      end if;
    end if;
    -- path-check: a url tem que conter {uid}/{tarefa_id}
    if p_url is not null and position((v_uid::text || '/' || p_tarefa_id::text) in p_url) = 0 then
      raise exception 'URL de comprovação não corresponde ao path da tarefa/usuário';
    end if;
    -- auditoria por exceção, decidida 1x
    select count(*) into v_reinc from public.tarefas x
      where x.template_id = t.template_id and x.assigned_to = t.assigned_to and x.id <> t.id
        and x.created_at > now() - interval '30 days'
        and (x.auditoria_status = 'reprovada' or x.status = 'aberta');
    if coalesce(tt.alto_risco,false)
       or v_reinc >= coalesce(tt.reincidente_limite, 3)
       or (random()*100) < coalesce(tt.amostra_auditoria_pct, 10)
    then v_audit := 'pendente'; else v_audit := 'dispensada'; end if;
  end if;

  update public.tarefas set
    status='concluida', conclusao_origem='comprovacao',
    comprovacao_url = coalesce(p_url, comprovacao_url),
    comprovacao_leitura = coalesce(p_leitura, comprovacao_leitura),
    comprovacao_em = now(), concluida_em = now(), concluida_por = v_uid,
    auditoria_status = v_audit, updated_at = now()
  where id = p_tarefa_id;
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  values (p_tarefa_id, 'concluida_comprovacao', v_uid, jsonb_build_object('auditoria', v_audit, 'leitura', p_leitura));
end $$;

-- (3) Auditoria (gestor/master). Reprovar reabre + zera escalado_em.
create or replace function public.auditar_tarefa(p_tarefa_id uuid, p_aprovar boolean, p_motivo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.pode_ver_carteira_completa(v_uid) then raise exception 'Só gestor/master audita'; end if;
  if p_aprovar then
    update public.tarefas set auditoria_status='aprovada', auditada_por=v_uid, auditada_em=now(), updated_at=now()
      where id=p_tarefa_id and auditoria_status='pendente';
    insert into public.tarefa_eventos (tarefa_id,tipo_evento,ator,payload)
    values (p_tarefa_id,'auditoria_aprovada',v_uid,'{}'::jsonb);
  else
    update public.tarefas set auditoria_status='reprovada', auditada_por=v_uid, auditada_em=now(),
      status='aberta', comprovacao_em=null, escalado_em=null, auditoria_motivo=p_motivo, updated_at=now()
      where id=p_tarefa_id and auditoria_status='pendente';
    insert into public.tarefa_eventos (tarefa_id,tipo_evento,ator,payload)
    values (p_tarefa_id,'auditoria_reprovada',v_uid,jsonb_build_object('motivo',p_motivo));
  end if;
end $$;

-- (4) Materialização (backfill 7d, idempotente, pula assignee sem perfil).
create or replace function public.tarefas_materializar_recorrentes()
returns void language plpgsql security definer set search_path = public as $$
declare tpl record; d date; hoje date := (now() at time zone 'America/Sao_Paulo')::date; dispara boolean;
begin
  for tpl in select * from public.tarefa_templates where ativo loop
    if not exists (select 1 from public.profiles p where p.user_id = tpl.assigned_to) then
      insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
      values (null, 'materializacao_pulada', null, jsonb_build_object('template_id', tpl.id, 'motivo', 'assignee_sem_perfil'));
      continue;
    end if;
    d := hoje - 6;  -- backfill janela 7 dias
    while d <= hoje loop
      dispara := case tpl.cadencia
        when 'diaria' then true
        when 'dias_uteis' then (extract(dow from d) between 1 and 5)
                               and not exists (select 1 from public.calendario_feriados f where f.data = d)
        when 'semanal' then extract(dow from d)::int = any(tpl.dias_semana)
        when 'dias_especificos' then extract(dow from d)::int = any(tpl.dias_semana)
        else false end;
      if dispara then
        insert into public.tarefas
          (descricao, categoria, customer_user_id, assigned_to, created_by, empresa, modo, due_date,
           backstop_days, tolerancia_dias, auto_satisfy_mode, status, template_id,
           requer_comprovacao, tipo_comprovacao, janela_fim, supervisor_user_id, auditoria_status)
        select tpl.descricao, tpl.categoria, tpl.customer_user_id, tpl.assigned_to, tpl.created_by, tpl.empresa,
           'data', d, 7, tpl.tolerancia_dias, 'off', 'aberta', tpl.id,
           tpl.requer_comprovacao, tpl.tipo_comprovacao, tpl.janela_fim, tpl.supervisor_user_id,
           case when tpl.requer_comprovacao then 'dispensada' else 'nao_requer' end
        where not exists (select 1 from public.tarefas t
                          where t.template_id = tpl.id and t.assigned_to = tpl.assigned_to and t.due_date = d);
      end if;
      d := d + 1;
    end loop;
  end loop;
end $$;

-- (5) Cron — chamada SQL local (sem net.http_post). ~06:00 BRT = 09:00 UTC.
select cron.schedule('tarefas-materializar-recorrentes', '0 9 * * *', $$ select public.tarefas_materializar_recorrentes(); $$);
```
> ⚠️ `tarefa_eventos.tarefa_id` é NOT NULL na Fase 1 — o evento `materializacao_pulada` usa `tarefa_id=null` e quebraria. **Resolver no build:** ou logar em outra tabela/`fin_alertas`, ou tornar `tarefa_eventos.tarefa_id` nullable (preferível: a tabela de eventos passa a aceitar eventos de sistema sem tarefa). Incluir o `alter ... drop not null` aqui se for esse o caminho.

- [ ] **Step 2: inline + Run. Step 3: validação estrutural**

```sql
select 'F2 BLOCO D OK' as status,
  (select count(*) from pg_proc where proname in ('tarefas_guard_comprovacao','concluir_com_comprovacao','auditar_tarefa','tarefas_materializar_recorrentes')) as funcs,
  (select count(*) from pg_trigger where tgname='trg_tarefas_guard_comprovacao') as trg,
  (select count(*) from cron.job where jobname='tarefas-materializar-recorrentes') as cron,
  (select proowner::regrole::text from pg_proc where proname='concluir_com_comprovacao') as owner_definer;
```
Expected: `funcs=4`, `trg=1`, `cron=1`, `owner_definer='postgres'` (confirma o allowlist do trigger).

- [ ] **Step 4: validação FUNCIONAL (smoke):** crie um template `requer_comprovacao` + leitura, rode `select tarefas_materializar_recorrentes();`, confirme a instância criada; tente concluir via `update tarefas set status='concluida'` direto (deve **RAISE** pelo trigger); conclua via `select concluir_com_comprovacao(<id>, '<uid>/<id>/x.jpg', <leitura na faixa>)` (deve concluir); tente leitura fora da faixa (deve RAISE). Cleanup.

- [ ] **Step 5: commit** `git commit -m "feat(tarefas-f2): BLOCO D — trigger anti-bypass + RPCs + materialização + cron"`

---

### Task 5: BLOCO E — bucket de Storage `tarefa-comprovacoes` + policies

**Files:** Create `supabase/migrations/20260601104000_tarefas_fase2_bloco_e.sql`

> Pode precisar ser feito pela UI/chat do Lovable (storage). O SQL abaixo funciona no SQL Editor na maioria dos projetos Supabase.

- [ ] **Step 1: SQL**

```sql
-- 20260601104000_tarefas_fase2_bloco_e.sql
insert into storage.buckets (id, name, public)
values ('tarefa-comprovacoes', 'tarefa-comprovacoes', false)
on conflict (id) do nothing;

-- path = {auth.uid}/{tarefa_id}/arquivo  → operador escreve só no próprio prefixo
create policy "tarefa_comprov_insert_own" on storage.objects for insert to authenticated
with check (bucket_id='tarefa-comprovacoes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "tarefa_comprov_select_own_ou_gestor" on storage.objects for select to authenticated
using (bucket_id='tarefa-comprovacoes' and (
  (storage.foldername(name))[1] = (select auth.uid())::text or public.pode_ver_carteira_completa((select auth.uid()))
));
```
> Bucket **privado** → o front lê a prova pra auditoria via `createSignedUrl`, não `getPublicUrl`.

- [ ] **Step 2: inline + Run. Step 3: validação** `select 'F2 BLOCO E OK' as status, exists(select 1 from storage.buckets where id='tarefa-comprovacoes') as bucket_ok, (select count(*) from pg_policies where tablename='objects' and policyname like 'tarefa_comprov%') as policies;` (Expected: `bucket_ok=true`, `policies=2`.)
- [ ] **Step 4: commit** `git commit -m "feat(tarefas-f2): BLOCO E — bucket de comprovações + policies"`

> **🟣 Handoff Milestone 1:** entregar A→B→C→D→E (1 bloco/mensagem, validação no fim), abrir PR com "ATENÇÃO: migration manual necessária". Só seguir pro Milestone 2 com A–E confirmados.

---

## Milestone 2 — Frontend (React). Verificação visual no Chrome do founder (o headless não renderiza a SPA).

> Reusa muito da Fase 1 (`src/lib/tarefas/`, `src/hooks/useTarefas.ts`, `src/components/tarefas/MinhasTarefasCard.tsx`). RPC: `supabase.rpc('fn' as never, {...})` (padrão do repo, ex. `useDetalhesModal.ts`). Foto: `PhotoUpload.tsx` + `supabase.storage.from('tarefa-comprovacoes').upload(path,file)` (path `{uid}/{tarefaId}/{ts}.jpg`) + `createSignedUrl` pra ler.

### Task 6: Tipos + hooks da Fase 2 (`useTarefasFase2`)
**Files:** Create `src/lib/tarefas/templates-types.ts`; Create `src/hooks/useTarefasFase2.ts`
- Tipos `TarefaTemplate` + `TarefaInstancia` (estende `TarefaEstado` c/ `tipo_comprovacao`/`comprovacao_leitura`/`auditoria_status`/`requer_auditoria`/`janela_fim`).
- Hooks/mutations (mesmo padrão de `useTarefas.ts`, casts `as never` + sonner + `track`):
  - `useTemplates()` (lista, gestor/master), `criarTemplate`/`editarTemplate`/`toggleTemplateAtivo`.
  - `useMinhasRecorrentesHoje()` (instâncias do operador: `v_tarefas_estado` where `template_id is not null` + `responsavel_efetivo=uid` + status aberta/hoje).
  - `concluirComComprovacao(tarefaId, url, leitura)` → `supabase.rpc('concluir_com_comprovacao' as never, { p_tarefa_id, p_url, p_leitura })`.
  - `useProvasParaAuditar()` (`requer_auditoria=true`, gestor) + `auditarTarefa(id, aprovar, motivo)` → `supabase.rpc('auditar_tarefa' as never, {...})`.
- [ ] TDD do que for puro (ex. validação client-side da faixa de leitura, montagem do path do Storage) em `src/lib/tarefas/__tests__/`. Verificação: `bun lint` + `heavy bunx tsc --noEmit -p tsconfig.app.json`. Commit.

### Task 7: Fluxo de prova — `ComprovacaoDialog`
**Files:** Create `src/components/tarefas/ComprovacaoDialog.tsx`
- Dialog acionado ao concluir uma tarefa com `requer_comprovacao`. Conforme `tipo_comprovacao`: **foto** (reusa `PhotoUpload`/upload pro bucket no path `{uid}/{tarefaId}/...`) e/ou **leitura** (input numérico mostrando a faixa `[min,max]`+unidade, valida client-side antes de habilitar Salvar). Ao confirmar: faz o upload (se foto) → pega o path → chama `concluirComComprovacao(tarefaId, path, leitura)`. Erros da RPC (faixa/foto faltando) → toast. Verificação: lint+typecheck; manual no device. Commit.

### Task 8: Card do operador em `/tintometrico`
**Files:** Modify `src/pages/TintDashboard.tsx` (+ um `RecorrentesHojeCard` em `src/components/tarefas/`)
- Card "Minhas tarefas de hoje" (espelha o `MinhasTarefasCard` da Fase 1): instâncias recorrentes do dia, atrasada (pós-janela) em vermelho, botão **Concluir** → abre `ComprovacaoDialog` (se requer prova) ou conclui direto (se não). Inserir no topo do `TintDashboard`. Verificação: manual no device. Commit.

### Task 9: Auditoria + CRUD de templates (founder/gestor)
**Files:** Create `src/pages/TarefasTemplates.tsx` + `src/components/tarefas/ProvasParaAuditar.tsx`; Modify `src/App.tsx` (rota `/tarefas/templates`) + `src/components/AppShell.tsx` (nav gated master/gestor)
- **Provas pra auditar:** lista `requer_auditoria=true` com a foto (via `createSignedUrl`) + leitura + Aprovar/Reprovar (→ `auditarTarefa`) + contagem/idade do backlog (codex P2 #9). Pode viver na página de Tarefas do founder (Fase 1) como uma aba, ou na nova página.
- **CRUD de templates:** criar atividade recorrente (área, cadência, dias, janela, tipo de prova, faixa+unidade, alto-risco, assignee, supervisor). Gate `isMaster||isGestorComercial`. Verificação: lint+typecheck+manual. Commit.

---

## Self-Review (rodada contra o spec)
**Cobertura:** §3.2–3.7 (trava/auditoria/recorrência/escalação/persona) → BLOCOS A–E + Tasks 6–9. §4 modelo → A/B. §5 motor → C/D. §6 surfacing → 7/8/9. §7 RLS → C/E. ✅
**2 furos achados ao planejar (não estavam no spec):** (1) `tarefas.customer_user_id` NOT NULL bloqueava ops sem cliente → BLOCO B torna nullable; (2) `tarefa_eventos.tarefa_id` NOT NULL quebra o evento de sistema "materializacao_pulada" → resolver no BLOCO D (nullable ou outra tabela). **Ambos flagueados nos blocos.**
**Riscos de build:** owner das funções definer (confirmar `postgres` p/ o trigger anti-bypass); bucket de storage pode exigir o chat do Lovable; a checagem "assignee ativo" usa `profiles` (confirmar a coluna de aprovação/atividade da persona de ops).
**Placeholder scan:** sem placeholders de lógica; os 2 furos têm resolução escrita. Milestone 2 referencia padrões reais (PhotoUpload, rpc, MinhasTarefasCard) — nível adequado dado o gate de build.

## Execution Handoff
🔴 **NÃO executar ainda** — o build espera a **verificação visual da Fase 1 em produção** (gate eu+codex). Quando a Fase 1 estiver validada:
1. **Milestone 1** (você cola A→E no SQL Editor; eu entrego bloco a bloco) — resolver os 2 furos nos blocos A/B/D ao colar.
2. **Milestone 2** via subagentes (subagent-driven), como na Fase 1.
3. Verificação visual da Fase 2 no device (operador conclui com foto; gestor audita; tenta burlar via UPDATE direto → trigger bloqueia).
