-- order_feed: read model único da listagem de pedidos (/sales).
-- Unifica sales_orders + orders (afiação) com o nome do cliente embutido, numa
-- projeção ENXUTA (sem itens completos / payloads pesados) — a listagem carrega
-- tudo numa só query; o detalhe busca o pedido cheio por (origin, id).
--
-- ⚠️ MIGRATION MANUAL: colar no SQL Editor do Lovable (o repo não aplica sozinho).
--
-- Decisões (validadas no schema real + 2 rodadas de 2ª opinião):
--  • LEFT JOIN normal por user_id — profiles.user_id é UNIQUE (profiles_user_id_key)
--    → 1 profile por usuário, sem duplicação (dispensa lateral/LIMIT 1).
--  • profiles não tem coluna account → não é multi-tenant (join só por user_id).
--  • cast numérico com guarda regex — um item com 'quantidade' malformada NÃO
--    derruba a view inteira (COALESCE não captura erro de cast).
--  • array_agg WITH ORDINALITY — ordem estável dos nomes; '{}' p/ vazio.
--  • casts explícitos no UNION ALL — contrato de tipos estável.
--  • SEM customer_document (PII) — só o detalhe-por-id usa.
--  • orders (afiação) não tem deleted_at → não há soft delete a filtrar.
--  • security_invoker → herda a RLS das tabelas base (staff já lê as 3).

create or replace view public.order_feed
with (security_invoker = true)
as
with feed as (
  select
    'sales'::text               as origin,
    so.id::uuid                 as id,
    so.created_at::timestamptz  as created_at,
    so.account::text            as account,
    so.omie_numero_pedido::text as order_number,
    so.omie_pedido_id::bigint   as omie_pedido_id,
    so.customer_user_id::uuid   as customer_user_id,
    case when jsonb_typeof(so.items) = 'array' then coalesce((
      select array_agg(nullif(elem->>'descricao','') order by ord)
             filter (where nullif(elem->>'descricao','') is not null)
      from jsonb_array_elements(so.items) with ordinality as t(elem, ord)
    ), '{}'::text[]) else '{}'::text[] end                      as item_names,
    case when jsonb_typeof(so.items) = 'array' then coalesce((
      select sum(case when (elem->>'quantidade') ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (elem->>'quantidade')::numeric else 0 end)
      from jsonb_array_elements(so.items) as elem
    ), 0) else 0 end::numeric                                   as item_quantity,
    so.status::text             as status,
    so.subtotal::numeric        as subtotal,
    so.total::numeric           as total
  from public.sales_orders so
  where so.deleted_at is null

  union all

  select
    'afiacao'::text             as origin,
    o.id::uuid                  as id,
    o.created_at::timestamptz   as created_at,
    'colacor_sc'::text          as account,
    null::text                  as order_number,
    null::bigint                as omie_pedido_id,
    o.user_id::uuid             as customer_user_id,
    case when jsonb_typeof(o.items) = 'array' then coalesce((
      select array_agg(coalesce(nullif(elem->>'category',''), nullif(elem->>'name',''), 'Afiação') order by ord)
      from jsonb_array_elements(o.items) with ordinality as t(elem, ord)
    ), '{}'::text[]) else '{}'::text[] end                      as item_names,
    case when jsonb_typeof(o.items) = 'array' then coalesce((
      select sum(case when (elem->>'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (elem->>'quantity')::numeric else 1 end)
      from jsonb_array_elements(o.items) as elem
    ), 0) else 0 end::numeric                                   as item_quantity,
    o.status::text              as status,
    o.subtotal::numeric         as subtotal,
    o.total::numeric            as total
  from public.orders o
)
select
  f.origin,
  f.id,
  f.created_at,
  f.account,
  f.order_number,
  f.omie_pedido_id,
  f.customer_user_id,
  p.name::text as customer_name,
  f.item_names,
  f.item_quantity,
  f.status,
  f.subtotal,
  f.total
from feed f
left join public.profiles p on p.user_id = f.customer_user_id;

comment on view public.order_feed is
  'Read model da listagem de pedidos (/sales): UNION de sales_orders + orders (afiação) com nome do cliente. Enxuto — detalhe busca por (origin,id). security_invoker.';
