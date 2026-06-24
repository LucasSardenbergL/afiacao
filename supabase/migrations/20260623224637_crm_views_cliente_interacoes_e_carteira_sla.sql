-- ============================================================
-- CRM da Carteira — v_cliente_interacoes (Task 1) + v_carteira_sla (Task 2)
--   • v_cliente_interacoes — timeline 360° (farmer_calls + route_visits + tarefas + order_messages)
--   • v_carteira_sla       — fila de SLA de contato vencido (scores + último contato efetivo)
-- Plano: docs/superpowers/plans/2026-06-23-crm-carteira-interacoes-e-sla.md
--
-- Read-only: nenhum writer novo, nenhuma 2ª fonte de verdade. VIEW com
-- security_invoker=true (PG 17.6) — roda com a RLS do usuário que consulta.
-- A RLS das fontes é DIVERGENTE; cada subquery embute um gate que ESPELHA a RLS
-- da SUA fonte (defense-in-depth, sem restringir além dela):
--   • farmer_calls / route_visits: gestor OR dono (farmer_id/visited_by=uid) OR carteira
--   • tarefas / order_messages:    gestor OR carteira (sem ramo "dono" nessas)
-- order_messages tem RLS staff-ampla → ali o gate da view é a cerca real.
-- Provado em PG17 (db/test-crm-carteira.sh): isolamento + ramo-dono + normalização
-- verdes; falsificações gate_om (vazamento) e sla_x100 (borda) vermelhas.
--
-- Idempotente: create OR replace view. Re-rodar não dá erro.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Task 1 — v_cliente_interacoes: timeline 360° (4 fontes UNION ALL + gate)
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- espelha a RLS de farmer_calls (3 ramos: gestor / dono / carteira) p/ não regredir o ramo "dono"
  and (pode_ver_carteira_completa(auth.uid()) or fc.farmer_id = auth.uid() or carteira_visivel_para(fc.customer_user_id, auth.uid()))
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
  -- espelha a RLS de route_visits (3 ramos: gestor / dono / carteira)
  and (pode_ver_carteira_completa(auth.uid()) or rv.visited_by = auth.uid() or carteira_visivel_para(rv.customer_user_id, auth.uid()))
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Task 2 — v_carteira_sla: fila de "SLA de contato vencido"
--   Deriva o último CONTATO EFETIVO por cliente (ligação com
--   call_result='contato_sucesso' OU visita com check-in) e compara com
--   sla_contact_days (farmer_algorithm_config; hoje 14, fallback 14).
--   health_class/churn vêm de farmer_client_scores (já escopa por carteira).
--   security_invoker=true → respeita a RLS de farmer_client_scores do usuário.
-- ─────────────────────────────────────────────────────────────────────────────
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
