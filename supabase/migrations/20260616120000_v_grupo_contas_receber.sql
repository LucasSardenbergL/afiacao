-- Grupo de Cliente 360 — Fase 1, Task 3: view de recebível consolidado por grupo.
-- Spec: docs/superpowers/specs/2026-06-15-grupo-cliente-360-design.md
-- ATENÇÃO: migration custom — aplicar manualmente no Lovable SQL Editor.
--
-- Padrão copiado VERBATIM de fin_aging_receber (migration 20260616020000_fix_aging_views_status_vocab):
--   "em aberto" = status_titulo NOT IN ('RECEBIDO','CANCELADO'); aging por data_vencimento; sum(saldo).
--   (status vocab real do Omie: 'A VENCER','ATRASADO','VENCE HOJE','RECEBIDO','PAGO','CANCELADO'.)
-- Só adiciona a dimensão GRUPO (join por documento normalizado) e soma across `company` (as 3 empresas).
--
-- security_invoker = true: a view roda com a RLS do INVOCADOR, então respeita o gate de
-- fin_contas_receber (fin_user_can_access) e das tabelas de grupo. Só quem tem acesso ao
-- financeiro enxerga linhas — mais seguro que as views fin_* atuais (que dependem de grant).

-- ============================================================
-- 1. Recebível consolidado POR GRUPO (total + aging), somando os documentos nas 3 empresas
-- ============================================================
create or replace view public.v_grupo_contas_receber
with (security_invoker = true) as
with tit as (
  select regexp_replace(fcr.cnpj_cpf, '\D', '', 'g') as doc,
         fcr.saldo,
         fcr.data_vencimento
  from public.fin_contas_receber fcr
  where fcr.status_titulo <> all (array['RECEBIDO'::text, 'CANCELADO'::text])
)
select g.id as grupo_id,
       g.nome,
       count(distinct m.documento) filter (where t.doc is not null) as documentos_com_titulo,
       coalesce(sum(t.saldo), 0::numeric) as total_aberto,
       coalesce(sum(t.saldo) filter (where t.data_vencimento >= current_date), 0::numeric) as a_vencer,
       coalesce(sum(t.saldo) filter (where (current_date - t.data_vencimento) between 1 and 30), 0::numeric) as venc_1_30,
       coalesce(sum(t.saldo) filter (where (current_date - t.data_vencimento) between 31 and 60), 0::numeric) as venc_31_60,
       coalesce(sum(t.saldo) filter (where (current_date - t.data_vencimento) between 61 and 90), 0::numeric) as venc_61_90,
       coalesce(sum(t.saldo) filter (where (current_date - t.data_vencimento) > 90), 0::numeric) as venc_90_mais
from public.cliente_grupos g
join public.cliente_grupo_membros m on m.grupo_id = g.id
left join tit t on t.doc = m.documento          -- m.documento já é só-dígitos (CHECK na tabela)
where g.ativo = true
group by g.id, g.nome;

-- ============================================================
-- 2. Recebível POR DOCUMENTO dentro do grupo (expor a composição — exigência do design/Codex)
-- ============================================================
create or replace view public.v_grupo_contas_receber_por_doc
with (security_invoker = true) as
with tit as (
  select regexp_replace(fcr.cnpj_cpf, '\D', '', 'g') as doc,
         fcr.company,
         fcr.nome_cliente,
         fcr.saldo,
         fcr.data_vencimento
  from public.fin_contas_receber fcr
  where fcr.status_titulo <> all (array['RECEBIDO'::text, 'CANCELADO'::text])
)
select m.grupo_id,
       m.documento,
       t.company,
       max(t.nome_cliente) as nome_cliente,
       coalesce(sum(t.saldo), 0::numeric) as total_aberto,
       coalesce(sum(t.saldo) filter (where (current_date - t.data_vencimento) > 0), 0::numeric) as vencido
from public.cliente_grupo_membros m
left join tit t on t.doc = m.documento
group by m.grupo_id, m.documento, t.company;
