# CRM da Carteira — View Canônica de Interações + Fila de SLA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED SUB-SKILLS (banco):** toda task de SQL usa `prove-sql-money-path` (provar no PG17 local ANTES) e `lovable-db-operator` (empacotar migration + bloco do SQL Editor + validação pós-apply). NÃO aplicar SQL em produção fora desse ritual. Não tocar em `supabase/migrations/` à mão.

**Goal:** Dar a fundação de CRM que falta no Afiação — uma view canônica de leitura `v_cliente_interacoes` (timeline 360° real) e uma view `v_carteira_sla` (fila de "SLA de contato vencido") — ambas read-only sobre dados que já existem, sem novo writer e sem 2ª fonte de verdade.

**Architecture:** Duas VIEWS `security_invoker = true` (PG 17.6) que **unificam a LEITURA** de fontes hoje fragmentadas (farmer_calls, route_visits, tarefas, order_messages) e derivam o SLA de `farmer_client_scores` + `farmer_algorithm_config`. Como as fontes têm RLS divergente (carteira / dono / staff-amplo), cada subquery embute um **gate de carteira uniforme** (`pode_ver_carteira_completa(auth.uid()) OR carteira_visivel_para(cliente, auth.uid())`) — defense-in-depth além do security_invoker — para não vazar interações entre carteiras. O front passa a consumir as views (1 query no lugar de N), sem mudar nenhum writer.

**Tech Stack:** PostgreSQL 17.6 (Supabase/Lovable), views `security_invoker`; React 18 + TS + @tanstack/react-query + supabase-js; vitest; deploy Lovable (migration via SQL Editor, frontend via Publish).

**Escopo (passo 1+2 do roadmap):** APENAS as 2 views + o consumo no front (Customer360 e fila no FarmerDashboard). O **board/Kanban de carteira (passo 3)** é plano separado — depende destas views mas não entra aqui (YAGNI).

**Decisões de design já travadas (com evidência do banco de produção):**
- Fontes da v1 de interações: `farmer_calls` (ligação/WhatsApp de negócio), `route_visits` (visita), `tarefas` (follow-up com `customer_user_id`), `order_messages` (via `orders.user_id`).
- **Fora da v1 (documentado):** `call_log` (técnico; escopa por `farmer_id`, não por carteira → inconsistente; `farmer_calls` já é a fonte de negócio) e `whatsapp_messages` cru (RLS libera todo staff; o contato WA de negócio já está em `farmer_calls.is_whatsapp`). Reavaliar em v2.
- "Contato efetivo" para o SLA = `farmer_calls.call_result = 'contato_sucesso'` **ou** `route_visits.check_in_at IS NOT NULL`. (Enum real confirmado: `contato_sucesso | sem_resposta | ocupado | caixa_postal | numero_invalido | reagendado`.) Decisão revisável — está num único ponto da view.
- `sla_contact_days` lido de `farmer_algorithm_config` (key/value; hoje = 14), com fallback 14.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| SQL `v_cliente_interacoes` (via lovable-db-operator) | View canônica de interações (4 fontes UNION ALL, gate de carteira) | Create |
| SQL `v_carteira_sla` (via lovable-db-operator) | Fila de SLA de contato derivada de scores + último contato | Create |
| `db/test-crm-carteira.sh` (template prove-sql-money-path) | Harness PG17: asserts positivos + gate + SLA + falsificação | Create |
| `src/lib/carteira/interacoes.ts` | Helpers PUROS: `canalToLabel`, `canalToTone`, `formatDiasSemContato` | Create |
| `src/lib/carteira/interacoes.test.ts` | Testes vitest dos helpers puros | Create |
| `src/components/customer360/hooks.ts:121-182` | `useCustomerInteractions` passa a ler `v_cliente_interacoes` (1 query) | Modify |
| `src/components/customer360/ActivityColumn.tsx:108-194` | Renderizar novos canais (visita/tarefa) além de call/message | Modify |
| `src/hooks/useCarteiraSla.ts` | Hook react-query que lê `v_carteira_sla` | Create |
| `src/components/farmer/SlaVencidoCard.tsx` | Card/fila "SLA de contato vencido" (badge + lista filtrável) | Create |
| `src/pages/FarmerDashboard.tsx` | Montar `<SlaVencidoCard>` no topo do dashboard | Modify |

---

## Pré-requisitos (uma vez)

- [ ] **Branch isolado** (não trabalhar na main). Se ainda não estiver num worktree dedicado, criar via `superpowers:using-git-worktrees`.
- [ ] **Harness PG17 pronto**: invocar `prove-sql-money-path` para montar o template descartável (PG17 local). Ele provê o scaffold de `db/test-*.sh`.
- [ ] **Leitura de produção disponível** para validação pós-apply: `~/.config/afiacao/psql-ro -c "select 1"`.

---

## Task 1: View `v_cliente_interacoes` (fundação read-only)

**Files:**
- Create (via `lovable-db-operator`): SQL da view `public.v_cliente_interacoes`
- Test: `db/test-crm-carteira.sh` (harness PG17 via `prove-sql-money-path`)

- [ ] **Step 1: Escrever o teste que FALHA (asserts no PG17 local)**

No harness do `prove-sql-money-path`, criar `db/test-crm-carteira.sh` que: (a) sobe PG17 descartável, (b) cria **stubs** das funções de gate e tabelas mínimas, (c) semeia 2 carteiras, (d) aplica a migration real, (e) roda os asserts. Stubs (a view referencia estas — no PG17 local elas não existem):

```sql
-- Stubs controláveis do gate (no PROD são SECURITY DEFINER reais)
create or replace function pode_ver_carteira_completa(_uid uuid) returns boolean
  language sql stable as $$ select coalesce(current_setting('test.gestor', true) = 'on', false) $$;
create or replace function carteira_visivel_para(_customer_user_id uuid, _uid uuid) returns boolean
  language sql stable as $$
    select exists (select 1 from test_carteira c where c.cliente = _customer_user_id and c.dono = _uid)
  $$;
create table if not exists test_carteira (dono uuid, cliente uuid);
-- auth.uid() lê do GUC (igual ao Supabase)
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
```

Seed mínimo (2 clientes, 2 donos):
```sql
-- cliente A pertence ao vendedor V1; cliente B ao vendedor V2
insert into test_carteira(dono, cliente) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002');
-- 1 ligação de sucesso p/ cliente A, 1 visita p/ cliente A, 1 tarefa p/ cliente B, 1 msg de pedido p/ A
insert into farmer_calls(id, farmer_id, customer_user_id, call_type, call_result, started_at, created_at, is_whatsapp, notes, revenue_generated)
  values (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','follow_up','contato_sucesso', now()-interval '2 days', now()-interval '2 days', false, 'falei com comprador', 1500);
insert into route_visits(id, customer_user_id, visited_by, visit_date, check_in_at, visit_type, notes, created_at)
  values (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', current_date, now()-interval '10 days','relacionamento','visita ok', now()-interval '10 days');
insert into tarefas(id, descricao, categoria, customer_user_id, assigned_to, status, created_at)
  values (gen_random_uuid(),'oferecer bundle','oferta','bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','ativa', now()-interval '1 day');
insert into orders(id, user_id) values ('dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001');
insert into order_messages(id, order_id, sender_id, message, is_staff, created_at)
  values (gen_random_uuid(),'dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','segue seu pedido', true, now()-interval '3 days');
```

Asserts (positivos + **gate/isolamento** + falsificação) — rodados sob GUC simulando cada vendedor:
```sql
-- ASSERT 1 (positivo): vendedor V1 vê 3 interações do cliente A (ligação+visita+msg), NÃO a tarefa do B
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set test.gestor='off';
do $$
declare n int;
begin
  select count(*) into n from v_cliente_interacoes where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 3 then raise exception 'ASSERT1 falhou: esperava 3 interacoes do cliente A, veio %', n; end if;
  perform 1 from v_cliente_interacoes where customer_user_id='bbbbbbbb-0000-0000-0000-000000000002';
  if found then raise exception 'ASSERT1 VAZAMENTO: V1 viu interacao do cliente B (carteira de outro)'; end if;
end $$;

-- ASSERT 2 (gate por carteira): vendedor V2 NÃO vê nada do cliente A
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set test.gestor='off';
do $$
declare n int;
begin
  select count(*) into n from v_cliente_interacoes where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'ASSERT2 VAZAMENTO: V2 viu % interacoes do cliente A', n; end if;
end $$;

-- ASSERT 3 (gestor): pode_ver_carteira_completa=on vê A e B
set test.gestor='on';
do $$
declare n int;
begin
  select count(*) into n from v_cliente_interacoes;
  if n < 4 then raise exception 'ASSERT3 falhou: gestor deveria ver >=4 interacoes, veio %', n; end if;
end $$;

-- ASSERT 4 (normalização): canais e revenue corretos
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; set test.gestor='off';
do $$
begin
  perform 1 from v_cliente_interacoes where ref_tabela='farmer_calls' and canal='ligacao' and revenue=1500;
  if not found then raise exception 'ASSERT4 falhou: ligacao normalizada incorreta'; end if;
  perform 1 from v_cliente_interacoes where ref_tabela='route_visits' and canal='visita';
  if not found then raise exception 'ASSERT4 falhou: visita ausente'; end if;
end $$;
```

- [ ] **Step 2: Rodar e ver FALHAR**

Run: `heavy bash db/test-crm-carteira.sh`
Expected: FAIL — `relation "v_cliente_interacoes" does not exist` (view ainda não criada).

- [ ] **Step 3: Escrever a view (migration real)**

```sql
create or replace view public.v_cliente_interacoes
with (security_invoker = true) as
-- Ligações e WhatsApp de negócio (farmer_calls já escopa por carteira)
select
  fc.customer_user_id,
  coalesce(fc.started_at, fc.created_at)                                   as at,
  case when fc.is_whatsapp then 'whatsapp' else 'ligacao' end              as canal,
  case fc.call_type
    when 'reativacao' then 'Reativação' when 'cross_sell' then 'Cross-sell'
    when 'up_sell' then 'Up-sell' when 'follow_up' then 'Follow-up' else 'Contato'
  end                                                                      as titulo,
  nullif(fc.notes, '')                                                     as resumo,
  'farmer_calls'::text                                                     as ref_tabela,
  fc.id                                                                    as ref_id,
  fc.farmer_id                                                             as autor_id,
  fc.revenue_generated                                                     as revenue
from public.farmer_calls fc
where fc.customer_user_id is not null
  and (pode_ver_carteira_completa(auth.uid()) or carteira_visivel_para(fc.customer_user_id, auth.uid()))
union all
-- Visitas
select
  rv.customer_user_id,
  coalesce(rv.check_in_at, rv.visit_date::timestamptz, rv.created_at),
  'visita',
  coalesce(nullif(rv.visit_type,''), 'Visita'),
  nullif(rv.notes,''),
  'route_visits', rv.id, rv.visited_by, rv.revenue_generated
from public.route_visits rv
where rv.customer_user_id is not null
  and (pode_ver_carteira_completa(auth.uid()) or carteira_visivel_para(rv.customer_user_id, auth.uid()))
union all
-- Tarefas de relacionamento vinculadas a cliente
select
  t.customer_user_id,
  coalesce(t.concluida_em, t.created_at),
  'tarefa',
  coalesce(nullif(t.categoria,''), 'Tarefa'),
  coalesce(nullif(t.nota_conclusao,''), nullif(t.descricao,'')),
  'tarefas', t.id, t.assigned_to, null::numeric
from public.tarefas t
where t.customer_user_id is not null
  and (pode_ver_carteira_completa(auth.uid()) or carteira_visivel_para(t.customer_user_id, auth.uid()))
union all
-- Mensagens de pedido (via orders.user_id)
select
  o.user_id,
  om.created_at,
  'mensagem_pedido',
  case when om.is_staff then 'Mensagem da equipe' else 'Mensagem do cliente' end,
  nullif(om.message,''),
  'order_messages', om.id, om.sender_id, null::numeric
from public.order_messages om
join public.orders o on o.id = om.order_id
where o.user_id is not null
  and (pode_ver_carteira_completa(auth.uid()) or carteira_visivel_para(o.user_id, auth.uid()));

grant select on public.v_cliente_interacoes to authenticated;
```

- [ ] **Step 4: Rodar e ver PASSAR**

Run: `heavy bash db/test-crm-carteira.sh`
Expected: PASS — todos os 4 asserts ok (sem exceção).

- [ ] **Step 5: FALSIFICAR (exigir vermelho)**

Remover temporariamente o predicado de gate da subquery de `order_messages` (a linha `and (pode_ver_carteira_completa...)`). Rodar `heavy bash db/test-crm-carteira.sh`.
Expected: **ASSERT1 VAZAMENTO** dispara (V1 passaria a ver msg fora do escopo se a fonte não fosse escopada) — confirma que o teste tem dente. Reverter a sabotagem; rodar de novo → PASS.

- [ ] **Step 6: Empacotar e aplicar (lovable-db-operator)**

Invocar `lovable-db-operator` para gerar o handoff (arquivo de migration + bloco pronto pro SQL Editor + nota de PR + audit). O founder cola o bloco no SQL Editor do Lovable e roda.

- [ ] **Step 7: Validar pós-apply (produção, read-only)**

Run:
```bash
~/.config/afiacao/psql-ro -P pager=off \
 -c "select table_name from information_schema.views where table_name='v_cliente_interacoes';" \
 -c "select c.relname, (select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker') as sec_invoker from pg_class c where c.relname='v_cliente_interacoes';" \
 -c "select has_table_privilege('authenticated','public.v_cliente_interacoes','SELECT') as authenticated_pode_ler;"
```
Expected: view existe; `sec_invoker = true`; `authenticated_pode_ler = t`.

- [ ] **Step 8: Commit**

```bash
git add db/test-crm-carteira.sh docs/superpowers/plans/2026-06-23-crm-carteira-interacoes-e-sla.md
git commit -m "feat(crm): view canônica v_cliente_interacoes (timeline 360 com gate de carteira) + prova PG17"
```

---

## Task 2: View `v_carteira_sla` (fila de SLA de contato)

**Files:**
- Create (via `lovable-db-operator`): View `public.v_carteira_sla`
- Test: estender `db/test-crm-carteira.sh` com asserts de SLA

- [ ] **Step 1: Escrever os asserts de SLA (que falham)**

Adicionar ao harness (reusa o seed da Task 1; cliente A teve contato há 2 dias; cliente B nunca teve contato efetivo):
```sql
-- SLA: cliente B (sem contato) deve estar VENCIDO; cliente A (2 dias < 14) NÃO vencido
set test.gestor='on';  -- gestor enxerga a carteira toda
do $$
declare v_b boolean; v_a boolean;
begin
  select vencido into v_b from v_carteira_sla where customer_user_id='bbbbbbbb-0000-0000-0000-000000000002';
  if v_b is distinct from true then raise exception 'SLA ASSERT falhou: cliente B sem contato deveria estar vencido (%).', v_b; end if;
  select vencido into v_a from v_carteira_sla where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';
  if v_a is distinct from false then raise exception 'SLA ASSERT falhou: cliente A (2 dias) NAO deveria estar vencido (%).', v_a; end if;
end $$;
```
> Pré-seed necessário para este assert: inserir 1 linha em `farmer_client_scores` para A (`health_class='saudavel'`) e B (`health_class='critico'`) com os respectivos `farmer_id`. Adicionar ao seed da Task 1.

- [ ] **Step 2: Rodar e ver FALHAR**

Run: `heavy bash db/test-crm-carteira.sh`
Expected: FAIL — `relation "v_carteira_sla" does not exist`.

- [ ] **Step 3: Escrever a view**

```sql
create or replace view public.v_carteira_sla
with (security_invoker = true) as
with sla as (
  select coalesce((select value from public.farmer_algorithm_config where key='sla_contact_days'), 14)::int as dias
),
ultimo_contato as (
  select customer_user_id, max(at) as last_contact_at from (
    select customer_user_id, coalesce(started_at, created_at) as at
      from public.farmer_calls where customer_user_id is not null and call_result = 'contato_sucesso'
    union all
    select customer_user_id, check_in_at as at
      from public.route_visits where customer_user_id is not null and check_in_at is not null
  ) x group by customer_user_id
)
select
  fcs.customer_user_id,
  fcs.farmer_id,
  fcs.health_class,
  fcs.churn_risk,
  fcs.priority_score,
  uc.last_contact_at,
  case when uc.last_contact_at is null then null
       else floor(extract(epoch from (now() - uc.last_contact_at)) / 86400)::int end as dias_sem_contato,
  sla.dias as sla_dias,
  (uc.last_contact_at is null or (now() - uc.last_contact_at) > make_interval(days => sla.dias)) as vencido
from public.farmer_client_scores fcs
cross join sla
left join ultimo_contato uc on uc.customer_user_id = fcs.customer_user_id
where fcs.health_class in ('atencao','critico')
   or uc.last_contact_at is null
   or (now() - uc.last_contact_at) > make_interval(days => sla.dias);

grant select on public.v_carteira_sla to authenticated;
```

- [ ] **Step 4: Rodar e ver PASSAR**

Run: `heavy bash db/test-crm-carteira.sh`
Expected: PASS.

- [ ] **Step 5: FALSIFICAR**

Trocar `> make_interval(days => sla.dias)` por `> make_interval(days => sla.dias * 100)` (SLA absurdo). Rodar → o assert do cliente B (sem contato) ainda passa (null→vencido), mas adicionar um assert de borda: cliente com contato há 20 dias deveria vencer (14) — com `*100` ele não vence → vermelho. Reverter → PASS.
```sql
-- seed extra p/ borda: cliente C contatado há 20 dias, health saudavel
-- assert: vencido = true (20 > 14). Com a sabotagem *100, fica false → teste vermelho.
```

- [ ] **Step 6: Empacotar e aplicar (lovable-db-operator)** — igual à Task 1.

- [ ] **Step 7: Validar pós-apply**

Run:
```bash
~/.config/afiacao/psql-ro -P pager=off \
 -c "select count(*) as linhas_sla from v_carteira_sla;" \
 -c "select count(*) filter (where vencido) as vencidos, count(*) filter (where health_class='critico') as criticos from v_carteira_sla;"
```
Expected: roda sem erro; números plausíveis (>0 se houver carteira com atraso).

- [ ] **Step 8: Commit**

```bash
git add db/test-crm-carteira.sh
git commit -m "feat(crm): view v_carteira_sla (fila de SLA de contato vencido) + prova PG17 com falsificação"
```

---

## Task 3: Front — Customer360 consome a timeline unificada

**Files:**
- Create: `src/lib/carteira/interacoes.ts`, `src/lib/carteira/interacoes.test.ts`
- Modify: `src/components/customer360/hooks.ts:121-182`, `src/components/customer360/ActivityColumn.tsx:108-194`

- [ ] **Step 1: Teste dos helpers puros (falha)**

`src/lib/carteira/interacoes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { canalToLabel, canalToTone, formatDiasSemContato } from './interacoes';

describe('carteira/interacoes helpers', () => {
  it('mapeia canal para label', () => {
    expect(canalToLabel('ligacao')).toBe('Ligação');
    expect(canalToLabel('whatsapp')).toBe('WhatsApp');
    expect(canalToLabel('visita')).toBe('Visita');
    expect(canalToLabel('tarefa')).toBe('Tarefa');
    expect(canalToLabel('mensagem_pedido')).toBe('Mensagem do pedido');
  });
  it('tom por canal usa tokens de status', () => {
    expect(canalToTone('visita')).toContain('text-status');
  });
  it('formata dias sem contato', () => {
    expect(formatDiasSemContato(null)).toBe('Nunca contatado');
    expect(formatDiasSemContato(0)).toBe('Hoje');
    expect(formatDiasSemContato(1)).toBe('1 dia');
    expect(formatDiasSemContato(20)).toBe('20 dias');
  });
});
```

- [ ] **Step 2: Rodar e ver FALHAR**

Run: `heavy bun run test src/lib/carteira/interacoes.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar os helpers**

`src/lib/carteira/interacoes.ts`:
```ts
export type CanalInteracao = 'ligacao' | 'whatsapp' | 'visita' | 'tarefa' | 'mensagem_pedido';

export function canalToLabel(canal: CanalInteracao): string {
  const map: Record<CanalInteracao, string> = {
    ligacao: 'Ligação', whatsapp: 'WhatsApp', visita: 'Visita',
    tarefa: 'Tarefa', mensagem_pedido: 'Mensagem do pedido',
  };
  return map[canal] ?? 'Interação';
}

export function canalToTone(canal: CanalInteracao): string {
  const map: Record<CanalInteracao, string> = {
    ligacao: 'text-status-info', whatsapp: 'text-status-success',
    visita: 'text-status-warning', tarefa: 'text-muted-foreground',
    mensagem_pedido: 'text-status-info',
  };
  return map[canal] ?? 'text-muted-foreground';
}

export function formatDiasSemContato(dias: number | null): string {
  if (dias === null) return 'Nunca contatado';
  if (dias <= 0) return 'Hoje';
  return dias === 1 ? '1 dia' : `${dias} dias`;
}
```

- [ ] **Step 4: Rodar e ver PASSAR**

Run: `heavy bun run test src/lib/carteira/interacoes.test.ts`
Expected: PASS.

- [ ] **Step 5: Trocar a fonte do `useCustomerInteractions` para a view**

> **Tipos do Supabase (TS strict):** as views novas só passam a existir em `src/integrations/supabase/types.ts` depois de **regenerar os tipos** a partir do banco já com as views aplicadas (Tasks 1–2 deployadas). Regenerar é o caminho correto — só então `supabase.from('v_cliente_interacoes')` tipa. Se a regeneração não estiver disponível no momento da execução, usar um cast local explícito e isolado (`supabase.from('v_cliente_interacoes' as never)` + tipar o retorno em `CarteiraSlaRow`/shape da timeline) **com TODO** para trocar pelo tipo gerado — nunca espalhar `any`.

Em `src/components/customer360/hooks.ts:121-182`, substituir as duas queries (`farmer_calls` + `order_messages`) por **uma** query à view, mantendo o shape de saída consumido por `ActivityColumn` (acrescentando `kind: 'visit' | 'task'`):
```ts
// dentro de useCustomerInteractions(customerUserId)
const { data } = await supabase
  .from('v_cliente_interacoes')
  .select('at, canal, titulo, resumo, ref_tabela, ref_id, revenue')
  .eq('customer_user_id', customerUserId)
  .order('at', { ascending: false })
  .limit(30);

const KIND_BY_CANAL = {
  ligacao: 'call', whatsapp: 'call', visita: 'visit',
  tarefa: 'task', mensagem_pedido: 'message',
} as const;

return (data ?? []).map((r) => ({
  kind: KIND_BY_CANAL[r.canal as keyof typeof KIND_BY_CANAL] ?? 'message',
  at: r.at,
  title: r.titulo,
  subtitle: (r.resumo ?? '').slice(0, 140),
  tone: canalToTone(r.canal),
  revenue: r.revenue ?? undefined,
}));
```

- [ ] **Step 6: Renderizar os novos canais no ActivityColumn**

Em `src/components/customer360/ActivityColumn.tsx`, no switch de ícone por `kind`, acrescentar `visit` (ícone `MapPin`) e `task` (ícone `CheckSquare`), reusando o padrão existente de cor por `tone`. (Mantém call/message como estão.)

- [ ] **Step 7: Verificar typecheck + testes + app**

Run: `heavy bun run typecheck && heavy bun run test src/lib/carteira/`
Expected: PASS. Depois, smoke manual: abrir `/admin/customers/<id>/360` e confirmar que visitas e tarefas agora aparecem na timeline (antes só ligação+mensagem).

- [ ] **Step 8: Commit**

```bash
git add src/lib/carteira/ src/components/customer360/hooks.ts src/components/customer360/ActivityColumn.tsx
git commit -m "feat(crm): Customer360 timeline 360 via v_cliente_interacoes (inclui visitas e tarefas)"
```

---

## Task 4: Front — Fila de "SLA de contato vencido" no FarmerDashboard

**Files:**
- Create: `src/hooks/useCarteiraSla.ts`, `src/components/farmer/SlaVencidoCard.tsx`
- Modify: `src/pages/FarmerDashboard.tsx`

- [ ] **Step 1: Hook `useCarteiraSla`**

`src/hooks/useCarteiraSla.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CarteiraSlaRow {
  customer_user_id: string;
  health_class: 'saudavel' | 'estavel' | 'atencao' | 'critico';
  churn_risk: number | null;
  last_contact_at: string | null;
  dias_sem_contato: number | null;
  sla_dias: number;
  vencido: boolean;
  priority_score: number | null;
}

export function useCarteiraSla() {
  return useQuery({
    queryKey: ['carteira-sla'],
    queryFn: async (): Promise<CarteiraSlaRow[]> => {
      const { data, error } = await supabase
        .from('v_carteira_sla')
        .select('customer_user_id, health_class, churn_risk, last_contact_at, dias_sem_contato, sla_dias, vencido, priority_score')
        .order('priority_score', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as CarteiraSlaRow[];
    },
  });
}
```

- [ ] **Step 2: Componente `SlaVencidoCard`**

`src/components/farmer/SlaVencidoCard.tsx` — usa `useCarteiraSla`, `formatDiasSemContato`, `<EmptyState>`, `<PageSkeleton>`/skeleton inline, classes `text-status-error`. Mostra contagem de vencidos + lista (top N) com nome do cliente (via join no front ou já disponível), `dias_sem_contato` em `text-status-error` quando `vencido`. Filtro local "só vencidos" via `useUrlState`. Esqueleto:
```tsx
import { useCarteiraSla } from '@/hooks/useCarteiraSla';
import { formatDiasSemContato } from '@/lib/carteira/interacoes';
import { EmptyState } from '@/components/EmptyState';
import { AlertTriangle } from 'lucide-react';

export function SlaVencidoCard() {
  const { data, isLoading } = useCarteiraSla();
  if (isLoading) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
  const vencidos = (data ?? []).filter((r) => r.vencido);
  if (vencidos.length === 0) {
    return <EmptyState icon={AlertTriangle} title="Nenhum SLA vencido" description="Toda a carteira está em dia com o contato." tone="operational" />;
  }
  return (
    <section aria-label="SLA de contato vencido">
      <header className="flex items-center justify-between mb-2">
        <h2 className="font-display text-lg">SLA de contato vencido</h2>
        <span className="text-status-error font-medium">{vencidos.length}</span>
      </header>
      <ul className="divide-y">
        {vencidos.slice(0, 20).map((r) => (
          <li key={r.customer_user_id} className="flex items-center justify-between py-2">
            <span className="truncate">{r.customer_user_id}{/* TODO: resolver nome via profiles/useCustomer */}</span>
            <span className="text-status-error text-sm">{formatDiasSemContato(r.dias_sem_contato)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
> Nota de implementação (não placeholder de lógica): o nome do cliente deve ser resolvido reusando o mesmo padrão já usado no FarmerDashboard para exibir `customer_name` (o `useFarmerScoring` já traz `customer_name` por `customer_user_id` — juntar pelo id no front, sem nova query). Trocar o `{r.customer_user_id}` pelo nome resolvido nesse mapa.

- [ ] **Step 3: Montar no FarmerDashboard**

Em `src/pages/FarmerDashboard.tsx`, importar e renderizar `<SlaVencidoCard />` no topo (acima do card "Saúde da Carteira").

- [ ] **Step 4: Verificar**

Run: `heavy bun run typecheck && heavy bun run lint`
Expected: PASS. Smoke manual: abrir `/farmer` (FarmerDashboard) e confirmar que a fila de SLA aparece, com contagem e clientes vencidos em vermelho.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCarteiraSla.ts src/components/farmer/SlaVencidoCard.tsx src/pages/FarmerDashboard.tsx
git commit -m "feat(crm): fila de SLA de contato vencido no FarmerDashboard (fecha o loop scoring->ação)"
```

---

## Deploy (Lovable — 3 camadas, ver `lovable-deploy-verify`)

- [ ] **Migrations** (Tasks 1 e 2): aplicadas via SQL Editor (handoff do `lovable-db-operator`) — confirmar com as queries do Step 7 de cada task.
- [ ] **Frontend** (Tasks 3 e 4): merge na main **não** publica — fazer **Publish** no editor do Lovable e verificar pelos bytes do bundle (`lovable-deploy-verify`).
- [ ] **Edge functions:** nenhuma alterada nesta entrega.

---

## Self-Review (checklist do autor)

**1. Cobertura do escopo (passo 1+2):**
- View canônica de interações → Task 1 ✓
- Fila de SLA → Task 2 ✓
- Consumo no Customer360 (timeline 360) → Task 3 ✓
- Alerta de SLA visível → Task 4 ✓
- Board/Kanban (passo 3) → **fora de escopo, plano separado** ✓ (declarado)

**2. Risco do Codex (RLS ao unir fontes):** neutralizado por `security_invoker=true` + gate de carteira uniforme em cada subquery + ASSERT2 (isolamento entre carteiras) + falsificação (Step 5 da Task 1). Validação pós-apply confere `security_invoker=true` e grant. ✓

**3. Sem 2ª fonte de verdade / sem novo writer:** ambas as entregas são VIEWS read-only; nenhum dado novo é escrito; Omie e tabelas-base intactos. ✓

**4. Consistência de tipos:** `canal` (5 valores) é o mesmo em `interacoes.ts`, no map `KIND_BY_CANAL` e na view; `CarteiraSlaRow` espelha as colunas reais de `v_carteira_sla`. ✓

**5. Pendência de produto (decide escopo, não bloqueia este plano):** a pergunta "perdem venda por falta de rastreio de negociação OU de recontato?" — se a resposta trouxer venda-projeto, abre um plano à parte (estágio leve sobre orçamento), sem afetar estas views. ✓

**Limitações conscientes (v1):** `call_log` e `whatsapp_messages` cru fora da timeline (documentado); "contato efetivo" = ligação com `contato_sucesso` ou visita com check-in (revisável num único ponto da view); nome do cliente na fila de SLA resolvido no front via mapa do `useFarmerScoring`.
