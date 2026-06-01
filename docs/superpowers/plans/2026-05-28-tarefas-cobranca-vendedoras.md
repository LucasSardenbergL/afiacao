# Tarefas — Cobrança de Atividades das Vendedoras (Fase 1) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Founder atribui tarefas a vendedoras tied a um cliente; o app lembra de forma saliente, dá baixa automática quando há prova determinística (propõe quando só detecta menção), e escala por e-mail ao founder após a tolerância.

**Architecture:** Backend 100% SQL + pg_cron (sem edge function nova): tabela `tarefas` (verdade) + `tarefa_satisfacao_candidatos` (evidências/sugestões) + `tarefa_eventos` (audit) + view `v_tarefas_estado` (estado derivado, fuso pinado) + 2 funções cron (`tarefas_matcher_tick` casa interação/cria candidato; `tarefas_escalonamento_tick` enfileira `fornecedor_alerta`). Frontend React lê a view e muta as tabelas; criação rápida do founder, card saliente na Meu Dia, lista "tarefas que criei", confirmação de sugestão em 1 toque, botão WhatsApp, adiar com motivo.

**Tech Stack:** React 18 + TS + Vite + Supabase (Postgres+RLS) + @tanstack/react-query + shadcn/ui + sonner + zod. pg_cron + pg_net já habilitados. Spec: `docs/superpowers/specs/2026-05-28-tarefas-cobranca-vendedoras-design.md`.

> **⚠️ Constraint do Lovable (CLAUDE.md §5):** migrations aplicadas **manualmente** pelo founder colando SQL no SQL Editor (sem CLI). Cada Task de backend entrega: (a) o arquivo de migration commitado, (b) o bloco SQL inline pra colar, (c) a query de validação. Edge functions via chat do Lovable só após merge — **mas esta Fase não tem edge function nova**. Os crons são **chamadas SQL locais** (`select fn()`), **não** `net.http_post` → **não** precisam de `timeout_milliseconds` (a armadilha de 5s não se aplica). O e-mail sai pelo cron já existente `dispatch-notifications`.

> **⚠️ Tipos do Supabase:** as tabelas/view novas **não entram em `src/integrations/supabase/types.ts`** até o Lovable regenerar. Até lá, o frontend usa tipos locais (`src/lib/tarefas/types.ts`) + cast `as never` no insert / `as TipoLocal[]` no select — padrão já usado no repo (ex.: `FarmerCalls.tsx:306` usa `as never`). Pedir ao Lovable pra regenerar os tipos depois de aplicar BLOCO A–C é opcional (o cast cobre).

---

## Milestone 1 — Backend (SQL via SQL Editor do Lovable)

**É um marco shippable e testável por si só:** com os BLOCOS A–E aplicados, dá pra criar tarefa via SQL, rodar `tarefas_matcher_tick()`/`tarefas_escalonamento_tick()` e ver o e-mail enfileirar — antes de qualquer React. As "tests" do backend são as **queries de validação** rodadas no SQL Editor (padrão do repo pra função pura-SQL; CLAUDE.md §5 "watchdog").

### Task 1: BLOCO A — tabela `tarefas`

**Files:**
- Create: `supabase/migrations/20260528130000_tarefas_bloco_a.sql`

- [ ] **Step 1: Criar o arquivo de migration com o DDL**

```sql
-- 20260528130000_tarefas_bloco_a.sql
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
```

> Nota: `customer_user_id`/`assigned_to`/`created_by` são `uuid` **sem FK** (mesmo estilo solto de `farmer_calls`, evita falha de apply por FK em `auth.users`). `auto_satisfy_mode` default `'off'` (seguro: linha criada fora do app nunca auto-fecha; o app sempre seta explícito — ver Task 10).

- [ ] **Step 2: Entregar o bloco inline pro founder + rodar no SQL Editor**

Mensagem pro founder (🟣 Lovable → SQL Editor → cola → Run), 1 bloco terminando em ``` ``` ``` sozinho. Conteúdo = o SQL do Step 1 **+** a validação do Step 3 no fim do mesmo bloco.

- [ ] **Step 3: Query de validação (no fim do bloco)**

```sql
select 'BLOCO A OK' as status,
  (select count(*) from information_schema.columns where table_name='tarefas') as colunas,
  (select count(*) from pg_indexes where tablename='tarefas') as indices;
```
Expected: `status='BLOCO A OK'`, `colunas=28`, `indices>=5` (4 criados + PK).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260528130000_tarefas_bloco_a.sql
git commit -m "feat(tarefas): BLOCO A — tabela tarefas (migration manual)"
```

---

### Task 2: BLOCO B — `tarefa_satisfacao_candidatos` + `tarefa_eventos`

**Files:**
- Create: `supabase/migrations/20260528131000_tarefas_bloco_b.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- 20260528131000_tarefas_bloco_b.sql
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
```

- [ ] **Step 2: Entregar inline + Run** (mesmo ritual da Task 1).

- [ ] **Step 3: Validação**

```sql
select 'BLOCO B OK' as status,
  to_regclass('public.tarefa_satisfacao_candidatos') is not null as cand_ok,
  to_regclass('public.tarefa_eventos') is not null as evt_ok,
  (select count(*) from pg_constraint where conname='tarefa_candidato_fonte_unq') as unq_ok;
```
Expected: `cand_ok=t`, `evt_ok=t`, `unq_ok=1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260528131000_tarefas_bloco_b.sql
git commit -m "feat(tarefas): BLOCO B — candidatos + eventos (migration manual)"
```

---

### Task 3: BLOCO C — view `v_tarefas_estado` + RLS

**Files:**
- Create: `supabase/migrations/20260528132000_tarefas_bloco_c.sql`

> Reusa o helper existente `public.pode_ver_carteira_completa(uid)` (= master OU gestor comercial; CLAUDE.md §10) como gate de "vê tudo". Confirme que ele existe: `select 'America/Sao_Paulo'::text; select pg_get_functiondef('public.pode_ver_carteira_completa(uuid)'::regprocedure);` — se faltar, ajuste o gate pra `public.is_master(uid)` ou equivalente antes de aplicar.

- [ ] **Step 1: Criar o arquivo de migration (view + RLS)**

```sql
-- 20260528132000_tarefas_bloco_c.sql

-- View de estado derivado. Fuso pinado em America/Sao_Paulo (CLAUDE.md / spec 4.4).
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

-- RLS
alter table public.tarefas enable row level security;
alter table public.tarefa_satisfacao_candidatos enable row level security;
alter table public.tarefa_eventos enable row level security;

-- helper inline: uid cobre assigned_to agora?
-- (sem criar função; EXISTS reusado nas policies)

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

-- candidatos: SELECT/UPDATE seguem a visibilidade da tarefa-pai (confirmar/rejeitar sugestão).
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

-- eventos: SELECT segue a tarefa-pai; INSERT por quem pode dar update na tarefa (log de conclusão/adiamento/cancelamento).
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
```

> `service_role` (cron) **bypassa** toda RLS → as funções `tarefas_matcher_tick`/`tarefas_escalonamento_tick` (Task 4, `security definer`) inserem candidatos/eventos sem policy de insert. Por isso candidatos não têm policy de INSERT pra `authenticated` (são cron-only; o app só dá UPDATE pra confirmar/rejeitar).

- [ ] **Step 2: Entregar inline + Run.**

- [ ] **Step 3: Validação**

```sql
select 'BLOCO C OK' as status,
  to_regclass('public.v_tarefas_estado') is not null as view_ok,
  (select count(*) from pg_policies where tablename in ('tarefas','tarefa_satisfacao_candidatos','tarefa_eventos')) as policies,
  (select count(*) from pg_views where viewname='v_tarefas_estado'
     and definition ilike '%America/Sao_Paulo%') as tz_pinada;
```
Expected: `view_ok=t`, `policies=7`, `tz_pinada=1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260528132000_tarefas_bloco_c.sql
git commit -m "feat(tarefas): BLOCO C — view v_tarefas_estado + RLS (migration manual)"
```

---

### Task 4: BLOCO D — funções cron + agendamento + CHECK de `fornecedor_alerta`

**Files:**
- Create: `supabase/migrations/20260528133000_tarefas_bloco_d.sql`

- [ ] **Step 1: Descobrir o nome do CHECK de `tipo` em `fornecedor_alerta`** (vai no topo do bloco como comentário pro founder confirmar)

```sql
-- rode primeiro e confirme o conname:
select conname from pg_constraint
where conrelid = 'public.fornecedor_alerta'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%tipo%';
-- esperado algo como 'fornecedor_alerta_tipo_check'. Ajuste o DROP abaixo se for outro nome.
```

- [ ] **Step 2: Criar o arquivo de migration (CHECK + 2 funções + 2 crons)**

```sql
-- 20260528133000_tarefas_bloco_d.sql

-- (1) Estende o CHECK de tipo p/ aceitar 'tarefa_atrasada' (preferido a sobrecarregar 'outro').
alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','outro'));

-- (2) Matcher: casa interação → fecha (interacao) ou cria candidato (conteudo). SQL puro, idempotente.
create or replace function public.tarefas_matcher_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A) Auto-close por LIGAÇÃO ATENDIDA (exclui sem-contato)
  with fechadas as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.farmer_calls fc
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo='ligacao'
      and fc.customer_user_id = t.customer_user_id
      and fc.created_at > now() - interval '1 day'
      and fc.call_result is not null
      and fc.call_result not in ('sem_resposta','ocupado','caixa_postal','numero_errado')
      and ( fc.farmer_id = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, fc.id as fonte, fc.farmer_id as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','ligacao','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas;

  -- B) Auto-close por VISITA/ENTREGA (check-in é presença)
  with fechadas_v as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.route_visits rv
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo in ('visita','entrega')
      and rv.customer_user_id = t.customer_user_id
      and rv.check_in_at > now() - interval '1 day'
      and ( (t.interacao_tipo='visita' and rv.visit_type='comercial')
            or (t.interacao_tipo='entrega' and rv.visit_type='entrega') )
      and ( rv.visited_by = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=rv.visited_by
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, rv.id as fonte, rv.visited_by as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','visita_entrega','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas_v;

  -- C) Candidatos de CONTEÚDO (oferecer/preco) — cria sugestão, NUNCA fecha.
  --    Enriquece com a entidade product/price da transcrição se houver match (lateral); senão sinal fraco.
  with novos as (
    insert into public.tarefa_satisfacao_candidatos
      (tarefa_id, source_type, source_id, mode, confidence, motivo, matched_payload, status)
    select t.id, 'farmer_call', fc.id, 'conteudo',
           coalesce(m.confidence, 0.0),
           case when m.value is not null then 'Mencionou na ligação: '||m.value
                else 'Ligação aconteceu — confirmar se ofereceu' end,
           case when m.value is not null
                then jsonb_build_object('entity_type', m.etype, 'value', m.value, 'context', m.context)
                else null end,
           'pending'
    from public.tarefas t
    join public.farmer_calls fc
      on fc.customer_user_id = t.customer_user_id
     and fc.created_at > now() - interval '1 day'
     and ( fc.farmer_id = t.assigned_to
           or exists (select 1 from public.carteira_coverage cc
                      where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                        and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    left join lateral (
      select e->>'value' as value, e->>'type' as etype, e->>'context' as context,
             (e->>'confidence')::numeric as confidence
      from jsonb_array_elements(coalesce(fc.entities_extracted, '[]'::jsonb)) e
      where e->>'type' in ('product','price')
        and t.target_texto is not null
        and e->>'value' ilike '%'||t.target_texto||'%'
      order by (e->>'confidence')::numeric desc nulls last
      limit 1
    ) m on true
    where t.status='aberta' and t.auto_satisfy_mode='conteudo' and t.interacao_tipo='ligacao'
    on conflict (tarefa_id, source_type, source_id) do nothing
    returning tarefa_id, id
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select tarefa_id, 'sugestao_criada', null, jsonb_build_object('candidato_id', id) from novos;

  -- D) Expira candidatos pendentes velhos (> 14 dias) — tunável.
  update public.tarefa_satisfacao_candidatos
  set status='expired', resolved_at=now()
  where status='pending' and created_at < now() - interval '14 days';
end $$;

-- (3) Escalonamento: agrupa vencidas+tolerância por responsável efetivo × empresa → fornecedor_alerta.
create or replace function public.tarefas_escalonamento_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    select v.responsavel_efetivo, v.empresa,
           array_agg(v.id) as ids,
           count(*) as n,
           jsonb_agg(jsonb_build_object(
             'tarefa_id', v.id, 'descricao', v.descricao, 'categoria', v.categoria,
             'customer_user_id', v.customer_user_id, 'effective_due', v.effective_due,
             'tem_sugestao', v.tem_sugestao_pendente, 'motivo_adiamento', v.motivo_adiamento
           ) order by v.effective_due) as tarefas
    from public.v_tarefas_estado v
    where v.escalavel
    group by v.responsavel_efetivo, v.empresa
  loop
    insert into public.fornecedor_alerta (tipo, empresa, severidade, status, metadata)
    values ('tarefa_atrasada', r.empresa, 'atencao', 'pendente_notificacao',
            jsonb_build_object('responsavel', r.responsavel_efetivo, 'total', r.n, 'tarefas', r.tarefas));

    insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
    select unnest(r.ids), 'escalada', null, jsonb_build_object('responsavel', r.responsavel_efetivo);

    update public.tarefas set escalado_em = now(), updated_at = now()
    where id = any(r.ids) and escalado_em is null;
  end loop;
end $$;

-- (4) Crons — chamadas SQL LOCAIS (sem net.http_post → sem timeout_milliseconds). Upsert por nome.
select cron.schedule('tarefas-matcher-15min', '*/15 * * * *', $$ select public.tarefas_matcher_tick(); $$);
select cron.schedule('tarefas-escalonamento-diario', '0 21 * * *', $$ select public.tarefas_escalonamento_tick(); $$);
-- 21:00 UTC = 18:00 BRT (America/Sao_Paulo, UTC-3 fixo desde 2019).
```

- [ ] **Step 3: Entregar inline + Run** (1 bloco; pode ser longo, founder rola até o fim).

- [ ] **Step 4: Validação estrutural**

```sql
select 'BLOCO D OK' as status,
  (select count(*) from pg_proc where proname in ('tarefas_matcher_tick','tarefas_escalonamento_tick')) as funcs,
  (select count(*) from cron.job where jobname in ('tarefas-matcher-15min','tarefas-escalonamento-diario')) as crons,
  (select pg_get_constraintdef(oid) ilike '%tarefa_atrasada%'
     from pg_constraint where conrelid='public.fornecedor_alerta'::regclass and conname='fornecedor_alerta_tipo_check') as check_ok;
```
Expected: `funcs=2`, `crons=2`, `check_ok=t`.

- [ ] **Step 5: Validação FUNCIONAL (smoke da lógica — o "test" da função pura-SQL)**

Roda no SQL Editor com uma tarefa + interação fabricadas (usa um `customer_user_id`/`assigned_to`/`farmer_id` reais de teste, ex.: o próprio uid de um vendedor). **Cenário 1 — auto-close por ligação atendida:**

```sql
-- arrange: tarefa de ligar (interacao) + ligação atendida HOJE
with v as (select '<UID_VENDEDOR>'::uuid u, '<UID_CLIENTE>'::uuid c)
insert into public.tarefas (descricao,categoria,customer_user_id,assigned_to,created_by,empresa,modo,interacao_tipo,auto_satisfy_mode)
select 'TESTE ligar', 'ligar', c, u, u, 'oben', 'interacao','ligacao','interacao' from v;
-- (garanta que existe um farmer_calls de hoje p/ (c,u) com call_result <> sem-contato; ou insira um de teste)
select public.tarefas_matcher_tick();
select status, conclusao_origem from public.tarefas where descricao='TESTE ligar';
-- Expected: status='concluida', conclusao_origem='auto_interacao'
delete from public.tarefas where descricao='TESTE ligar';  -- cleanup
```

**Cenário 2 — "ligar" NÃO fecha em ligação sem-resposta:** repita com um `farmer_calls.call_result='sem_resposta'` e confirme `status='aberta'`.

**Cenário 3 — escalonamento:** crie uma tarefa `modo='data'` com `due_date = current_date - 5` e `tolerancia_dias=1`, rode `select public.tarefas_escalonamento_tick();`, confirme 1 linha nova em `fornecedor_alerta` com `tipo='tarefa_atrasada'` e a tarefa com `escalado_em` setado. Cleanup.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260528133000_tarefas_bloco_d.sql
git commit -m "feat(tarefas): BLOCO D — matcher + escalonamento + crons (migration manual)"
```

---

### Task 5: BLOCO E — seed dos defaults globais em `company_config`

**Files:**
- Create: `supabase/migrations/20260528134000_tarefas_bloco_e.sql`

> `company_config` é key/value (text). O app lê esses defaults na criação pra pré-preencher `backstop_days`/`tolerancia_dias` (que são gravados POR tarefa — mudar o default depois não reescreve o passado).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- 20260528134000_tarefas_bloco_e.sql
insert into public.company_config (key, value)
values ('tarefas_backstop_dias_default', '7'),
       ('tarefas_tolerancia_dias_default', '1')
on conflict (key) do update set value = excluded.value, updated_at = now();
```
> Se `company_config` não tiver UNIQUE em `key`, troque o `on conflict (key)` por um `update ... where key=...` + `insert ... where not exists`. Confirme: `select count(*) from pg_constraint where conrelid='public.company_config'::regclass and contype in ('p','u');`

- [ ] **Step 2: Entregar inline + Run.**

- [ ] **Step 3: Validação**

```sql
select 'BLOCO E OK' as status,
  (select value from public.company_config where key='tarefas_backstop_dias_default') as backstop,
  (select value from public.company_config where key='tarefas_tolerancia_dias_default') as tolerancia;
```
Expected: `backstop='7'`, `tolerancia='1'`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260528134000_tarefas_bloco_e.sql
git commit -m "feat(tarefas): BLOCO E — seed defaults em company_config (migration manual)"
```

> **🟣 Handoff ao founder (Milestone 1):** entregar os 5 blocos A→B→C→D→E em mensagens separadas (1 bloco SQL por mensagem, label "BLOCO X", validação no fim), e abrir o PR com a nota **"ATENÇÃO: migration manual necessária"** + os 5 SQLs no corpo. Só seguir pro Milestone 2 depois de A–E confirmados `OK` no SQL Editor.

---

## Milestone 2 — Frontend (React, neste repo)

> Verificação de UI é **manual no Chrome real do founder** — o `/browse` headless não renderiza esta SPA (CLAUDE.md §5). Os únicos `bun run test` são o helper puro da Task 6.

### Task 6: Tipos locais + helper puro `buildWhatsappTaskMessage` (TDD)

**Files:**
- Create: `src/lib/tarefas/types.ts`
- Create: `src/lib/tarefas/whatsapp.ts`
- Test: `src/lib/tarefas/__tests__/whatsapp.test.ts`

- [ ] **Step 1: Escrever os tipos locais** (cobrem a view enquanto `types.ts` do Supabase não regenera)

```ts
// src/lib/tarefas/types.ts
export type TarefaCategoria = 'ligar' | 'oferecer' | 'preco' | 'whatsapp' | 'outro';
export type TarefaModo = 'data' | 'interacao';
export type TarefaInteracaoTipo = 'ligacao' | 'visita' | 'entrega';
export type TarefaAutoSatisfy = 'off' | 'interacao' | 'conteudo';
export type TarefaStatus = 'aberta' | 'concluida' | 'cancelada';
export type TarefaConclusaoOrigem = 'manual' | 'auto_interacao' | 'sugestao_confirmada' | 'whatsapp';

export interface TarefaEstado {
  id: string;
  descricao: string;
  categoria: TarefaCategoria;
  customer_user_id: string;
  assigned_to: string;
  created_by: string;
  empresa: string;
  modo: TarefaModo;
  due_date: string | null;
  interacao_tipo: TarefaInteracaoTipo | null;
  backstop_days: number;
  tolerancia_dias: number;
  adiada_para: string | null;
  motivo_adiamento: string | null;
  auto_satisfy_mode: TarefaAutoSatisfy;
  target_produto_id: string | null;
  target_texto: string | null;
  target_preco_centavos: number | null;
  status: TarefaStatus;
  concluida_em: string | null;
  concluida_por: string | null;
  conclusao_origem: TarefaConclusaoOrigem | null;
  nota_conclusao: string | null;
  escalado_em: string | null;
  // derivados (da view):
  effective_due: string;
  responsavel_efetivo: string;
  atrasada: boolean;
  escalavel: boolean;
  tem_sugestao_pendente: boolean;
}

export interface TarefaCandidato {
  id: string;
  tarefa_id: string;
  source_type: 'farmer_call' | 'route_visit' | 'whatsapp' | 'quote';
  source_id: string | null;
  mode: 'interacao' | 'conteudo';
  confidence: number | null;
  motivo: string | null;
  matched_payload: { entity_type?: string; value?: string; context?: string } | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}
```

- [ ] **Step 2: Escrever o teste que FALHA primeiro**

```ts
// src/lib/tarefas/__tests__/whatsapp.test.ts
import { describe, it, expect } from 'vitest';
import { buildWhatsappTaskMessage, buildWaMeUrl } from '../whatsapp';

describe('buildWhatsappTaskMessage', () => {
  it('usa a descrição da tarefa como corpo', () => {
    expect(buildWhatsappTaskMessage({ descricao: 'Manda o catálogo 2026' }))
      .toBe('Manda o catálogo 2026');
  });
  it('inclui o texto-alvo quando presente', () => {
    expect(buildWhatsappTaskMessage({ descricao: 'Enviar dados', target_texto: 'Tabela verniz X' }))
      .toBe('Enviar dados\n\nTabela verniz X');
  });
  it('trim e ignora alvo vazio', () => {
    expect(buildWhatsappTaskMessage({ descricao: '  Oi  ', target_texto: '   ' })).toBe('Oi');
  });
});

describe('buildWaMeUrl', () => {
  it('monta wa.me com telefone limpo e texto encodado', () => {
    expect(buildWaMeUrl('(37) 99999-1234', 'Olá, tudo bem?'))
      .toBe('https://wa.me/5537999991234?text=Ol%C3%A1%2C%20tudo%20bem%3F');
  });
  it('sem telefone → wa.me sem número (escolhe contato no app)', () => {
    expect(buildWaMeUrl(null, 'Oi')).toBe('https://wa.me/?text=Oi');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `heavy bun run test src/lib/tarefas/__tests__/whatsapp.test.ts`
Expected: FAIL ("buildWhatsappTaskMessage is not a function").

- [ ] **Step 4: Implementar o helper**

```ts
// src/lib/tarefas/whatsapp.ts
export function buildWhatsappTaskMessage(t: { descricao: string; target_texto?: string | null }): string {
  const corpo = (t.descricao ?? '').trim();
  const alvo = (t.target_texto ?? '').trim();
  return alvo ? `${corpo}\n\n${alvo}` : corpo;
}

/** Monta o deeplink wa.me. phone em formato BR livre; assume +55 quando há dígitos. */
export function buildWaMeUrl(phone: string | null | undefined, message: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  const num = digits ? (digits.startsWith('55') ? digits : `55${digits}`) : '';
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `heavy bun run test src/lib/tarefas/__tests__/whatsapp.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tarefas/
git commit -m "feat(tarefas): tipos locais + helper buildWhatsappTaskMessage (TDD)"
```

---

### Task 7: Camada de dados — `useTarefas` (queries + mutations)

**Files:**
- Create: `src/hooks/useTarefas.ts`

> Lê a **view** `v_tarefas_estado` (cast local: `supabase.from('v_tarefas_estado' as never).select('*') ... as unknown as TarefaEstado[]`). Mutations seguem o padrão optimistic+rollback de `src/components/salesOrders/useSalesOrders.ts:153` e os toasts `sonner`. `track()` de `@/lib/analytics` (convenção `tarefas.<action>`).

- [ ] **Step 1: Escrever as QUERIES**

```ts
// src/hooks/useTarefas.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { TarefaEstado } from '@/lib/tarefas/types';

const sel = () => (supabase.from('v_tarefas_estado' as never) as any);

/** Tarefas da vendedora logada (do responsável efetivo: assigned_to OU cobertura). A RLS já filtra. */
export function useMinhasTarefas() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['minhas-tarefas', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<TarefaEstado[]> => {
      const { data, error } = await sel()
        .select('*')
        .eq('status', 'aberta')
        .order('atrasada', { ascending: false })
        .order('effective_due', { ascending: true });
      if (error) throw error;
      // só as do responsável efetivo (RLS já garante visibilidade; aqui foco nas "minhas")
      return ((data ?? []) as TarefaEstado[]).filter(t => t.responsavel_efetivo === user!.id);
    },
  });
}

/** Lista do founder: tarefas que ELE criou + status. */
export function useTarefasQueCriei(filtroStatus: 'todas' | 'aberta' | 'concluida' | 'cancelada' = 'todas') {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tarefas-que-criei', user?.id, filtroStatus],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<TarefaEstado[]> => {
      let q = sel().select('*').eq('created_by', user!.id)
        .order('effective_due', { ascending: true });
      if (filtroStatus !== 'todas') q = q.eq('status', filtroStatus);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TarefaEstado[];
    },
  });
}

/** Sugestões pendentes (candidatos) das tarefas visíveis à vendedora. */
export function useTarefaSugestoes(tarefaIds: string[]) {
  return useQuery({
    queryKey: ['tarefa-sugestoes', tarefaIds.slice().sort()],
    enabled: tarefaIds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase.from('tarefa_satisfacao_candidatos' as never) as any)
        .select('*').in('tarefa_id', tarefaIds).eq('status', 'pending');
      if (error) throw error;
      return data ?? [];
    },
  });
}
```

- [ ] **Step 2: Escrever as MUTATIONS** (mesmo arquivo)

```ts
const TZ = 'America/Sao_Paulo';

export function useTarefaMutations() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['minhas-tarefas'] });
    qc.invalidateQueries({ queryKey: ['tarefas-que-criei'] });
    qc.invalidateQueries({ queryKey: ['tarefa-sugestoes'] });
    qc.invalidateQueries({ queryKey: ['tarefas-badge-count'] });
  };

  /** Cria N tarefas pro mesmo cliente (criação em lote, founder). */
  const criarTarefas = async (linhas: Array<Record<string, unknown>>) => {
    const rows = linhas.map(l => ({ ...l, created_by: user!.id }));
    const { error } = await (supabase.from('tarefas' as never) as any).insert(rows as never);
    if (error) { toast.error('Erro ao criar tarefa', { description: error.message }); throw error; }
    // log de criação (best-effort)
    track('tarefas.created', { qtd: rows.length });
    toast.success(rows.length > 1 ? `${rows.length} tarefas criadas` : 'Tarefa criada');
    invalidate();
  };

  /** Conclusão manual (inclui o botão WhatsApp, que passa origem='whatsapp'). */
  const concluir = async (id: string, origem: 'manual' | 'whatsapp', nota?: string) => {
    const { error } = await (supabase.from('tarefas' as never) as any)
      .update({ status: 'concluida', concluida_em: new Date().toISOString(),
                concluida_por: user!.id, conclusao_origem: origem, nota_conclusao: nota ?? null,
                updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) { toast.error('Erro ao concluir'); throw error; }
    await (supabase.from('tarefa_eventos' as never) as any).insert(
      { tarefa_id: id, tipo_evento: origem === 'whatsapp' ? 'concluida_whatsapp' : 'concluida_manual',
        ator: user!.id } as never);
    track('tarefas.completed', { origem });
    toast.success('Tarefa concluída');
    invalidate();
  };

  /** Confirma/rejeita uma sugestão (1 toque). accepted → conclui a tarefa. */
  const resolverSugestao = async (candidatoId: string, tarefaId: string, aceitar: boolean) => {
    const { error } = await (supabase.from('tarefa_satisfacao_candidatos' as never) as any)
      .update({ status: aceitar ? 'accepted' : 'rejected', resolved_at: new Date().toISOString(),
                resolved_by: user!.id } as never).eq('id', candidatoId);
    if (error) { toast.error('Erro ao responder sugestão'); throw error; }
    if (aceitar) {
      await (supabase.from('tarefas' as never) as any).update(
        { status: 'concluida', concluida_em: new Date().toISOString(), concluida_por: user!.id,
          conclusao_origem: 'sugestao_confirmada', updated_at: new Date().toISOString() } as never)
        .eq('id', tarefaId);
      await (supabase.from('tarefa_eventos' as never) as any).insert(
        { tarefa_id: tarefaId, tipo_evento: 'sugestao_confirmada', ator: user!.id } as never);
    } else {
      await (supabase.from('tarefa_eventos' as never) as any).insert(
        { tarefa_id: tarefaId, tipo_evento: 'sugestao_rejeitada', ator: user!.id } as never);
    }
    track('tarefas.suggestion_resolved', { aceitar });
    toast.success(aceitar ? 'Confirmada' : 'Ok, segue aberta');
    invalidate();
  };

  /** Adiar com motivo (snooze). */
  const adiar = async (id: string, novaData: string, motivo: string) => {
    const { error } = await (supabase.from('tarefas' as never) as any)
      .update({ adiada_para: novaData, motivo_adiamento: motivo, updated_at: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) { toast.error('Erro ao adiar'); throw error; }
    await (supabase.from('tarefa_eventos' as never) as any).insert(
      { tarefa_id: id, tipo_evento: 'adiada', ator: user!.id,
        payload: { adiada_para: novaData, motivo } } as never);
    track('tarefas.snoozed', {});
    toast.success('Tarefa adiada');
    invalidate();
  };

  /** Cancelar (founder/gestor) com motivo. */
  const cancelar = async (id: string, motivo: string) => {
    const { error } = await (supabase.from('tarefas' as never) as any)
      .update({ status: 'cancelada', updated_at: new Date().toISOString() } as never).eq('id', id);
    if (error) { toast.error('Erro ao cancelar'); throw error; }
    await (supabase.from('tarefa_eventos' as never) as any).insert(
      { tarefa_id: id, tipo_evento: 'cancelada', ator: user!.id, payload: { motivo } } as never);
    track('tarefas.cancelled', {});
    toast.success('Tarefa cancelada');
    invalidate();
  };

  return { criarTarefas, concluir, resolverSugestao, adiar, cancelar };
}
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck:strict` (não é obrigatório o arquivo entrar no `tsconfig.strict.json` agora — mas `bunx tsc --noEmit -p tsconfig.app.json` deve passar limpo).
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTarefas.ts
git commit -m "feat(tarefas): camada de dados (queries da view + mutations)"
```

---

### Task 8: Card saliente na Meu Dia — `MinhasTarefasCard`

**Files:**
- Create: `src/components/tarefas/MinhasTarefasCard.tsx`
- Modify: `src/components/dashboard/FarmerDashboardV2.tsx` (inserir o card no TOPO, antes de `<AgendaTodayList />`)
- Modify: `src/components/dashboard/HunterDashboard.tsx` e `CloserDashboard.tsx` (mesmo card no topo)

> Saliência = risco nº 1 do pré-mortem. Card é o **primeiro bloco**; atrasadas em vermelho (`text-status-error`/`border-status-error/40`); sugestões num estilo mais forte. Usa shadcn `Card`. Botão WhatsApp abre `buildWaMeUrl(...)` (Task 6) e conclui com origem `whatsapp`. Adiar abre um pequeno dialog com data + motivo.

- [ ] **Step 1: Implementar o card**

```tsx
// src/components/tarefas/MinhasTarefasCard.tsx
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Check, MessageSquare, Clock, AlertTriangle } from 'lucide-react';
import { useMinhasTarefas, useTarefaSugestoes, useTarefaMutations } from '@/hooks/useTarefas';
import { buildWhatsappTaskMessage, buildWaMeUrl } from '@/lib/tarefas/whatsapp';
import type { TarefaEstado } from '@/lib/tarefas/types';

export function MinhasTarefasCard() {
  const { data: tarefas = [], isLoading } = useMinhasTarefas();
  const ids = useMemo(() => tarefas.map(t => t.id), [tarefas]);
  const { data: sugestoes = [] } = useTarefaSugestoes(ids);
  const { concluir, resolverSugestao, adiar } = useTarefaMutations();
  const [adiarAlvo, setAdiarAlvo] = useState<TarefaEstado | null>(null);
  const [adiarData, setAdiarData] = useState('');
  const [adiarMotivo, setAdiarMotivo] = useState('');

  if (isLoading || tarefas.length === 0) return null; // empty → não polui o topo

  const sugByTarefa = new Map<string, typeof sugestoes[number]>();
  for (const s of sugestoes) if (!sugByTarefa.has(s.tarefa_id)) sugByTarefa.set(s.tarefa_id, s);

  const onWhats = (t: TarefaEstado) => {
    window.open(buildWaMeUrl(null, buildWhatsappTaskMessage(t)), '_blank');
    concluir(t.id, 'whatsapp');
  };

  return (
    <Card className="p-4 border-status-warning/40">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="w-4 h-4" />
        <h2 className="font-display text-lg">Minhas tarefas</h2>
        <span className="text-2xs text-muted-foreground">{tarefas.length}</span>
      </div>
      <ul className="space-y-2">
        {tarefas.map(t => {
          const sug = sugByTarefa.get(t.id);
          return (
            <li key={t.id} className={`rounded-md border p-3 ${t.atrasada ? 'border-status-error/40 bg-status-error-bg' : 'border-border'}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{t.descricao}</p>
                  <p className="text-2xs text-muted-foreground">
                    {t.atrasada && <AlertTriangle className="inline w-3 h-3 text-status-error mr-1" />}
                    {t.categoria} · vence {t.effective_due}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  {t.categoria === 'whatsapp'
                    ? <Button size="sm" variant="outline" onClick={() => onWhats(t)}><MessageSquare className="w-3 h-3 mr-1" />Mandar</Button>
                    : <Button size="sm" variant="outline" onClick={() => concluir(t.id, 'manual')}><Check className="w-3 h-3 mr-1" />Feito</Button>}
                  <Button size="sm" variant="ghost" onClick={() => { setAdiarAlvo(t); setAdiarData(''); setAdiarMotivo(''); }}>Adiar</Button>
                </div>
              </div>
              {sug && (
                <div className="mt-2 rounded-md bg-status-info-bg border border-status-info/40 p-2">
                  <p className="text-2xs">{sug.motivo ?? 'Possível cumprimento detectado'} — confirma?</p>
                  <div className="flex gap-1 mt-1">
                    <Button size="sm" onClick={() => resolverSugestao(sug.id, t.id, true)}>Sim, fiz</Button>
                    <Button size="sm" variant="ghost" onClick={() => resolverSugestao(sug.id, t.id, false)}>Não</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={!!adiarAlvo} onOpenChange={(o) => !o && setAdiarAlvo(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Adiar tarefa</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Input type="date" value={adiarData} onChange={(e) => setAdiarData(e.target.value)} />
            <Textarea placeholder="Motivo (ex: cliente pediu pra semana que vem)" value={adiarMotivo} onChange={(e) => setAdiarMotivo(e.target.value)} />
          </div>
          <DialogFooter>
            <Button disabled={!adiarData || !adiarMotivo} onClick={async () => {
              if (!adiarAlvo) return;
              await adiar(adiarAlvo.id, new Date(adiarData + 'T12:00:00').toISOString(), adiarMotivo);
              setAdiarAlvo(null);
            }}>Adiar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
```

- [ ] **Step 2: Inserir o card no topo dos dashboards** (ex.: `FarmerDashboardV2.tsx`, entre `<KpisToday />` e `<AgendaTodayList />` — ver CommercialDashboard:18). Importar e renderizar `<MinhasTarefasCard />`. Repetir em `HunterDashboard`/`CloserDashboard`.

- [ ] **Step 3: Verificação manual** (Chrome do founder): logar como vendedora com 1 tarefa aberta → card aparece no topo; atrasada fica vermelha; "Feito" conclui; sugestão (se houver candidato) mostra Sim/Não; "Adiar" grava data+motivo. Confirmar que sem tarefas o card some (não polui).

- [ ] **Step 4: Commit**

```bash
git add src/components/tarefas/MinhasTarefasCard.tsx src/components/dashboard/FarmerDashboardV2.tsx src/components/dashboard/HunterDashboard.tsx src/components/dashboard/CloserDashboard.tsx
git commit -m "feat(tarefas): card saliente de tarefas na Meu Dia"
```

---

### Task 9: Badge na sidebar (contagem hoje/atrasadas)

**Files:**
- Modify: `src/components/AppShell.tsx` (seguir o padrão de `pedidosPendentes` em `AppShell.tsx:370`)

- [ ] **Step 1: Adicionar a query de contagem** (perto das outras badges, ~`AppShell.tsx:370`)

```tsx
const { data: tarefasCount } = useQuery({
  queryKey: ['tarefas-badge-count'],
  queryFn: async () => {
    const { data, error } = await (supabase.from('v_tarefas_estado' as never) as any)
      .select('id, atrasada').eq('status', 'aberta');
    if (error) return 0;
    return (data ?? []).length; // RLS já limita às visíveis (dela + cobertura + gestor)
  },
  enabled: !!user,
  refetchInterval: 60000,
  refetchIntervalInBackground: false,
  staleTime: 30000,
});
```

- [ ] **Step 2: Anexar a badge ao item de nav** "Meu dia" (ou um item "Tarefas"): `{ ..., badge: tarefasCount, badgeVariant: 'default' }` — seguir o shape de `SidebarItem` em `AppShell.tsx:296`.

- [ ] **Step 3: Verificação manual**: vendedora com tarefas abertas vê o número na sidebar; some quando zera; refetch a cada 60s.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(tarefas): badge de tarefas abertas na sidebar"
```

---

### Task 10: Criação rápida do founder — `CriarTarefaDialog` (lote por cliente)

**Files:**
- Create: `src/lib/tarefas/categoria-map.ts`
- Create: `src/lib/tarefas/__tests__/categoria-map.test.ts`
- Create: `src/components/tarefas/CriarTarefaDialog.tsx`

> Reusa o **customer picker** do `src/components/farmer/calls/NewCallDialog.tsx` (busca Omie + resolve `customer_user_id` via `omie_clientes`→`user_id`, mesma regra de `FarmerCalls.tsx:283-295`). Permite adicionar **várias tarefas** pro mesmo cliente antes de salvar (lote). O mapeamento categoria→`auto_satisfy_mode`/`interacao_tipo` é puro e testado.

- [ ] **Step 1: Teste do mapeamento (TDD)**

```ts
// src/lib/tarefas/__tests__/categoria-map.test.ts
import { describe, it, expect } from 'vitest';
import { autoSatisfyDaCategoria } from '../categoria-map';

describe('autoSatisfyDaCategoria', () => {
  it('ligar → interacao', () => expect(autoSatisfyDaCategoria('ligar')).toBe('interacao'));
  it('oferecer/preco → conteudo', () => {
    expect(autoSatisfyDaCategoria('oferecer')).toBe('conteudo');
    expect(autoSatisfyDaCategoria('preco')).toBe('conteudo');
  });
  it('whatsapp/outro → off', () => {
    expect(autoSatisfyDaCategoria('whatsapp')).toBe('off');
    expect(autoSatisfyDaCategoria('outro')).toBe('off');
  });
});
```

- [ ] **Step 2: Rodar (falha), implementar, rodar (passa)**

Run: `heavy bun run test src/lib/tarefas/__tests__/categoria-map.test.ts` → FAIL, then PASS.

```ts
// src/lib/tarefas/categoria-map.ts
import type { TarefaCategoria, TarefaAutoSatisfy } from './types';
export function autoSatisfyDaCategoria(c: TarefaCategoria): TarefaAutoSatisfy {
  if (c === 'ligar') return 'interacao';
  if (c === 'oferecer' || c === 'preco') return 'conteudo';
  return 'off'; // whatsapp (botão), outro (manual)
}
```

- [ ] **Step 3: Implementar o dialog** (estrutura — mirror do `NewCallDialog.tsx` pro picker + `Dialog` wrapper)

```tsx
// src/components/tarefas/CriarTarefaDialog.tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { autoSatisfyDaCategoria } from '@/lib/tarefas/categoria-map';
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '@/lib/tarefas/types';

type Rascunho = {
  descricao: string; categoria: TarefaCategoria; modo: TarefaModo;
  due_date?: string; interacao_tipo?: TarefaInteracaoTipo; target_texto?: string;
};

// props: open, onOpenChange, cliente selecionado ({ customer_user_id, nome }), assigned_to (vendedora), empresa
export function CriarTarefaDialog({ open, onOpenChange, cliente, assignedTo, empresa }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  cliente: { customer_user_id: string; nome: string } | null;
  assignedTo: string; empresa: string;
}) {
  const { criarTarefas } = useTarefaMutations();
  const [rascunhos, setRascunhos] = useState<Rascunho[]>([]);
  const [atual, setAtual] = useState<Rascunho>({ descricao: '', categoria: 'ligar', modo: 'interacao', interacao_tipo: 'ligacao' });
  const [saving, setSaving] = useState(false);

  const addRascunho = () => { if (atual.descricao.trim()) { setRascunhos([...rascunhos, atual]); setAtual({ descricao: '', categoria: 'ligar', modo: 'interacao', interacao_tipo: 'ligacao' }); } };

  const salvar = async () => {
    if (!cliente) return;
    const todos = atual.descricao.trim() ? [...rascunhos, atual] : rascunhos;
    if (todos.length === 0) return;
    setSaving(true);
    try {
      await criarTarefas(todos.map(r => ({
        descricao: r.descricao, categoria: r.categoria, customer_user_id: cliente.customer_user_id,
        assigned_to: assignedTo, empresa, modo: r.modo,
        due_date: r.modo === 'data' ? (r.due_date ?? null) : null,
        interacao_tipo: r.modo === 'interacao' ? (r.interacao_tipo ?? 'ligacao') : null,
        auto_satisfy_mode: autoSatisfyDaCategoria(r.categoria),
        target_texto: (r.categoria === 'oferecer' || r.categoria === 'preco') ? (r.target_texto ?? null) : null,
        // backstop_days/tolerancia_dias usam os defaults do banco (BLOCO E); editáveis depois.
      })));
      setRascunhos([]); onOpenChange(false);
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nova tarefa{cliente ? ` — ${cliente.nome}` : ''}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Textarea placeholder="O que a vendedora precisa fazer?" value={atual.descricao}
            onChange={(e) => setAtual({ ...atual, descricao: e.target.value })} />
          <Select value={atual.categoria} onValueChange={(v) => setAtual({ ...atual, categoria: v as TarefaCategoria })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ligar">Ligar</SelectItem>
              <SelectItem value="oferecer">Oferecer item</SelectItem>
              <SelectItem value="preco">Passar preço</SelectItem>
              <SelectItem value="whatsapp">Mandar WhatsApp</SelectItem>
              <SelectItem value="outro">Outro</SelectItem>
            </SelectContent>
          </Select>
          {(atual.categoria === 'oferecer' || atual.categoria === 'preco') && (
            <Input placeholder="Qual item / preço (o app procura isso na transcrição)" value={atual.target_texto ?? ''}
              onChange={(e) => setAtual({ ...atual, target_texto: e.target.value })} />
          )}
          <Select value={atual.modo} onValueChange={(v) => setAtual({ ...atual, modo: v as TarefaModo })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="interacao">Na próxima interação</SelectItem>
              <SelectItem value="data">Data fixa</SelectItem>
            </SelectContent>
          </Select>
          {atual.modo === 'data'
            ? <Input type="date" value={atual.due_date ?? ''} onChange={(e) => setAtual({ ...atual, due_date: e.target.value })} />
            : <Select value={atual.interacao_tipo ?? 'ligacao'} onValueChange={(v) => setAtual({ ...atual, interacao_tipo: v as TarefaInteracaoTipo })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ligacao">Próxima ligação</SelectItem>
                  <SelectItem value="visita">Próxima visita</SelectItem>
                  <SelectItem value="entrega">Próxima entrega</SelectItem>
                </SelectContent>
              </Select>}
          <Button variant="outline" size="sm" onClick={addRascunho} disabled={!atual.descricao.trim()}>+ Adicionar outra pra este cliente</Button>
          {rascunhos.length > 0 && <p className="text-2xs text-muted-foreground">{rascunhos.length} tarefa(s) na fila + a atual</p>}
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={saving || !cliente || (!atual.descricao.trim() && rascunhos.length === 0)}>
            Salvar {rascunhos.length + (atual.descricao.trim() ? 1 : 0)} tarefa(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> O **customer picker** (busca + seleção do `cliente`) vive na página (Task 11), reusando a busca de `NewCallDialog`/`FarmerCalls.searchCustomers`. A `assignedTo` (vendedora) é escolhida no mesmo fluxo: dropdown de vendedoras (donas de carteira) ou, se o founder partiu de um cliente, a dona da carteira daquele cliente via `carteira_assignments.owner_user_id`.

- [ ] **Step 4: Verificação manual** (Chrome): founder cria 2 tarefas pro mesmo cliente numa tacada; categoria oferecer mostra o campo de alvo; modo interação mostra ligação/visita/entrega; salvar cria as N linhas (conferir em `select * from tarefas order by created_at desc`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tarefas/categoria-map.ts src/lib/tarefas/__tests__/categoria-map.test.ts src/components/tarefas/CriarTarefaDialog.tsx
git commit -m "feat(tarefas): dialog de criação em lote + mapa categoria→auto_satisfy (TDD)"
```

---

### Task 11: Página do founder "Tarefas que criei" + rota + nav

**Files:**
- Create: `src/pages/Tarefas.tsx`
- Modify: `src/App.tsx` (lazy import ~`:20` + `<Route>` ~`:241`)
- Modify: `src/components/AppShell.tsx` (item de nav "Tarefas" na seção Vendas/Gestão, gated master/gestor)

> Gate master/gestor via `useAuth().isMaster` + `useMyCommercialRole()` (gestor). Lista lê `useTarefasQueCriei`; mostra responsável efetivo, prazo, **atrasada**, **escalada** (badge — resolve o cego do fire-once), **sugestão pendente** e `conclusao_origem`. Botão "Nova tarefa" abre o picker de cliente + `CriarTarefaDialog` (Task 10). Cancelar via `useTarefaMutations().cancelar`.

- [ ] **Step 1: Implementar a página**

```tsx
// src/pages/Tarefas.tsx
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useTarefasQueCriei, useTarefaMutations } from '@/hooks/useTarefas';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CriarTarefaDialog } from '@/components/tarefas/CriarTarefaDialog';

export default function Tarefas() {
  const { isMaster } = useAuth();
  const { data: role } = useMyCommercialRole();
  const podeGerir = isMaster || role === 'gestor' || role === 'gerencial' || role === 'super_admin';
  const { data: tarefas = [], isLoading } = useTarefasQueCriei('todas');
  const { cancelar } = useTarefaMutations();
  const [abrirCriar, setAbrirCriar] = useState(false);
  // picker de cliente/vendedora: reusar a busca de NewCallDialog (estado local) — ver Task 10 nota.
  const [cliente, setCliente] = useState<{ customer_user_id: string; nome: string } | null>(null);
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [empresa] = useState<string>('oben');

  if (!podeGerir) return <Navigate to="/" replace />;

  return (
    <div className="container py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl">Tarefas que criei</h1>
        <Button onClick={() => setAbrirCriar(true)}>Nova tarefa</Button>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
        <ul className="space-y-2">
          {tarefas.map(t => (
            <li key={t.id}>
              <Card className="p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{t.descricao}</p>
                  <p className="text-2xs text-muted-foreground">
                    {t.categoria} · vence {t.effective_due} · resp. {t.responsavel_efetivo.slice(0, 8)}
                    {t.conclusao_origem && ` · concluída (${t.conclusao_origem})`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {t.status === 'aberta' && t.atrasada && <Badge variant="destructive">atrasada</Badge>}
                  {t.escalado_em && <Badge variant="outline">escalada</Badge>}
                  {t.tem_sugestao_pendente && <Badge>sugestão</Badge>}
                  {t.status === 'concluida' && <Badge variant="secondary">concluída</Badge>}
                  {t.status === 'cancelada' && <Badge variant="outline">cancelada</Badge>}
                  {t.status === 'aberta' && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      const motivo = window.prompt('Motivo do cancelamento?');
                      if (motivo) cancelar(t.id, motivo);
                    }}>Cancelar</Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <CriarTarefaDialog open={abrirCriar} onOpenChange={setAbrirCriar}
        cliente={cliente} assignedTo={assignedTo} empresa={empresa} />
      {/* TODO de wiring: o picker de cliente + seletor de vendedora setam `cliente`/`assignedTo`
          antes de abrir o dialog — reusar a busca de NewCallDialog (ver Task 10). */}
    </div>
  );
}
```

> O picker de cliente/vendedora é o único pedaço de UI que o engenheiro monta seguindo `NewCallDialog.tsx` (busca Omie → resolve `customer_user_id`) + um `Select` de vendedoras (donas de carteira via `carteira_assignments` distinct `owner_user_id`, ou a dona do cliente escolhido). Mantém o dialog (Task 10) burro/controlado.

- [ ] **Step 2: Registrar a rota em `App.tsx`**

```tsx
// ~linha 20 (lazy imports):
const Tarefas = lazy(() => import("./pages/Tarefas"));
// ~linha 241 (dentro de <ProtectedRoute><AppShellLayout/>):
<Route path="tarefas" element={<Tarefas />} />
```

- [ ] **Step 3: Item de nav** em `AppShell.tsx` (seção Vendas ou Gestão), gated pra master/gestor (seguir como outros itens condicionam por papel), apontando pra `/tarefas`. Pode receber a badge da Task 9 aqui (ou a badge fica no "Meu dia" da vendedora).

- [ ] **Step 4: Typecheck + lint + verificação manual**

Run: `heavy bun run typecheck:strict && heavy bun run test && bun lint`
Expected: sem erros; os 2 testes de helper passam.
Manual (Chrome): founder acessa `/tarefas`, vê a lista com status/escalada/sugestão/origem, cria nova tarefa, cancela uma aberta; vendedora comum (não-gestor) é redirecionada.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Tarefas.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(tarefas): página do founder 'tarefas que criei' + rota + nav"
```

---

## Sequenciamento & dependências

- **Milestone 1 (Tasks 1→5)** é estritamente sequencial (A→B→C→D→E) e bloqueia o Milestone 2 (o frontend lê a view e as tabelas). Founder aplica os 5 blocos no SQL Editor + valida antes de seguir.
- **Milestone 2**: Task 6 → 7 são base (helper + hooks); 8/9/10/11 dependem de 7. 8/9 (vendedora) e 10/11 (founder) são paralelizáveis entre si depois da 7.

## Self-Review (rodada contra o spec)

**Cobertura do spec:** §3.1–3.8 e §4–§11 mapeados a Tasks (3.1→T1+T3; 3.2→T1+T5; 3.3→T4; 3.4→T6+T8; 3.5→T4; 3.6→T1+T7+T8; 3.7→T3+T4; 3.8→T10; 4→T1-3; 5→T4; 6→T8/T9/T11; 7→T3; 8→T4; 11→T1-5). 

**2 lacunas conscientes (flagueadas, não placeholders):**
1. **Cópia do e-mail (§3.5 "possível cumprimento não confirmado, nunca 'não fez'")** — o BLOCO D **produz a metadata** (`tarefas[]` com `tem_sugestao` + `motivo_adiamento`), mas o **texto** do e-mail é renderizado pelo `dispatch-notifications` (edge function existente). Ação: depois de A–E + 1º alerta real, **conferir como o `dispatch-notifications` renderiza `tipo='tarefa_atrasada'`**; se for genérico, fazer um ajuste pequeno no template (a cópia cuidadosa) e **redeployar via chat do Lovable após o merge**. É a única peça que toca edge function — fica como fast-follow do Milestone 1, não bloqueia o resto.
2. **Editar tarefa (§3.9)** — **Cancelar** está implementado (T7+T11), que é o P1 de correção (tarefa moot some). **Editar** (prazo/tolerância/responsável/categoria/alvo) ficou como fast-follow: reusar o `CriarTarefaDialog` em "modo edição" (pré-preenche + `update` em vez de `insert`) — baixo esforço, sem tabela nova. Cancelar+recriar cobre o caso enquanto isso.

**Placeholder scan:** sem placeholders de lógica. Há 1 nota de wiring explícita (picker de cliente/vendedora na T11) que aponta pro padrão real `NewCallDialog.tsx` — é "follow the pattern", não TODO de lógica.

**Consistência de tipos:** `TarefaEstado`/`TarefaCandidato` (T6) usados em T7/T8/T11; assinaturas `concluir(id,origem,nota?)`, `resolverSugestao(candId,tarefaId,aceitar)`, `adiar(id,iso,motivo)`, `cancelar(id,motivo)`, `criarTarefas(linhas)`, `autoSatisfyDaCategoria(cat)`, `buildWhatsappTaskMessage`/`buildWaMeUrl` batem entre as Tasks. ✓

## Riscos de execução (anota antes de codar)

- **Tipos Supabase**: casts `as never`/`as any` nas tabelas/view novas até o Lovable regenerar `types.ts`. Não bloqueia.
- **`pode_ver_carteira_completa` / `carteira_coverage` / `farmer_calls.call_result` / `route_visits.visit_type`**: o BLOCO C/D assume esses nomes (verificados no schema-snapshot). Se o apply acusar coluna/função ausente, conferir no SQL Editor antes (queries de checagem inline nas Tasks 3/4).
- **Volume do matcher**: janela de 1 dia × baixo volume de ligações/visitas → barato a cada 15min; idempotente (UNIQUE no candidato + `status='aberta'` guard). Sem cursor.

---

## Execution Handoff

**Plano completo e salvo em `docs/superpowers/plans/2026-05-28-tarefas-cobranca-vendedoras.md`. Duas opções de execução:**

**1. Subagent-Driven (recomendado)** — eu disparo um subagente fresco por Task, revejo entre Tasks, iteração rápida. Bom aqui porque alterna entre SQL (founder aplica) e React (eu codo).

**2. Inline Execution** — executo as Tasks nesta sessão com checkpoints pra revisão.

**Qual abordagem?** (E lembrando: o Milestone 1 são 5 blocos SQL que **você** cola no SQL Editor do Lovable — eu te entrego um por mensagem com a validação; o Milestone 2 eu codo no repo.)
