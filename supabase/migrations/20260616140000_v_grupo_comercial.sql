-- Grupo de Cliente 360 — Fase 2, Task: view comercial consolidada por grupo (aba Comercial).
-- Faturamento + recência + TENDÊNCIA POR JANELA (90d vs 90d anterior), somando os documentos
-- do grupo nas 3 empresas. Segue a regra do Codex (unificacao-cnpj.md): faturamento/recência
-- somam (post-merge OK); a queda é por JANELA MÓVEL, não por intervalo médio pooled (que
-- esconderia cliente caindo quando CNPJs paralelos se alternam).
-- security_invoker = true (respeita a RLS de sales_orders/profiles). Money-path → provar PG17.
-- ATENÇÃO: migration custom — aplicar manualmente no Lovable SQL Editor.

create or replace view public.v_grupo_comercial
with (security_invoker = true) as
with ped as (
  select regexp_replace(coalesce(p.cnpj, p.document, ''), '\D', '', 'g') as doc,
         so.created_at::date as data,
         coalesce(so.total, (
           select sum((it->>'quantity')::numeric * (it->>'unit_price')::numeric)
           from jsonb_array_elements(so.items) it
         )) as valor
  from public.sales_orders so
  join public.profiles p on p.user_id = so.customer_user_id
  where so.status in ('faturado','importado','separacao','enviado')
    and so.deleted_at is null
)
select m.grupo_id,
       count(distinct ped.doc) filter (where ped.doc is not null)        as documentos_com_compra,
       count(ped.data)                                                    as qtd_pedidos,
       max(ped.data)                                                      as ultima_compra,
       (current_date - max(ped.data))                                     as dias_desde_ultima,
       coalesce(sum(ped.valor), 0::numeric)                               as faturamento_total,
       coalesce(sum(ped.valor) filter (where ped.data > current_date - 90), 0::numeric)                                  as fat_90d,
       coalesce(sum(ped.valor) filter (where ped.data <= current_date - 90 and ped.data > current_date - 180), 0::numeric) as fat_90d_anterior,
       round(coalesce(sum(ped.valor) filter (where ped.data > current_date - 180), 0::numeric) / 6.0, 2)                  as media_mensal_6m
from public.cliente_grupo_membros m
left join ped on ped.doc = m.documento
group by m.grupo_id;
