-- 20260610130000_melhorias_canal.sql
-- Canal interno de Melhorias: staff reporta problema/sugestão/pergunta; IA tria
-- na hora (edge melhoria-triagem); founder consome fila master.
-- Spec: docs/superpowers/specs/2026-06-10-melhorias-canal-feedback-design.md
-- ⚠️ APLICAÇÃO MANUAL via SQL Editor do Lovable (§5 CLAUDE.md).

-- ============ TABELAS ============

create table if not exists public.melhoria_itens (
  id uuid primary key default gen_random_uuid(),
  autor_user_id uuid not null,
  empresa text not null check (empresa in ('colacor','oben','colacor_sc')),
  rota_origem text,
  tipo text check (tipo in ('problema','sugestao','pergunta')),
  urgencia text check (urgencia in ('baixa','media','alta')),
  modulo text,
  titulo text,
  status text not null default 'aberto' check (status in ('aberto','em_andamento','resolvido','descartado')),
  triagem_status text not null default 'pendente' check (triagem_status in ('pendente','ok','erro')),
  avaliacao_founder text,
  resposta_founder text,
  resolvido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_melhoria_itens_status on public.melhoria_itens (status, created_at desc);
create index if not exists idx_melhoria_itens_autor on public.melhoria_itens (autor_user_id, created_at desc);

create table if not exists public.melhoria_mensagens (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.melhoria_itens(id) on delete cascade,
  autor_user_id uuid,
  papel text not null check (papel in ('funcionario','ia','founder')),
  conteudo text not null check (length(trim(conteudo)) > 0),
  dados jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_melhoria_mensagens_item on public.melhoria_mensagens (item_id, created_at);

-- updated_at automático
create or replace function public.melhoria_itens_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_melhoria_itens_touch on public.melhoria_itens;
create trigger trg_melhoria_itens_touch
  before update on public.melhoria_itens
  for each row execute function public.melhoria_itens_touch_updated_at();

-- ============ RLS ============

alter table public.melhoria_itens enable row level security;
alter table public.melhoria_mensagens enable row level security;

-- Itens: autor vê os próprios; master vê tudo.
drop policy if exists melhoria_itens_select on public.melhoria_itens;
create policy melhoria_itens_select on public.melhoria_itens for select to authenticated
using (
  autor_user_id = (select auth.uid())
  or has_role((select auth.uid()), 'master'::app_role)
);

-- INSERT: qualquer staff (employee/master), sempre como autor de si mesmo.
-- Campos da IA/founder não são pré-populáveis pelo cliente: status/triagem_status
-- iniciam nos defaults do schema; avaliacao_founder/resposta_founder/resolvido_em
-- são exclusivos do master (UPDATE) ou da edge via service_role.
drop policy if exists melhoria_itens_insert on public.melhoria_itens;
create policy melhoria_itens_insert on public.melhoria_itens for insert to authenticated
with check (
  autor_user_id = (select auth.uid())
  and (has_role((select auth.uid()), 'employee'::app_role) or has_role((select auth.uid()), 'master'::app_role))
  and status = 'aberto'
  and triagem_status = 'pendente'
  and avaliacao_founder is null
  and resposta_founder is null
  and resolvido_em is null
);

-- UPDATE: só master (status/resposta). Campos da IA são gravados via service_role (bypassa RLS).
drop policy if exists melhoria_itens_update on public.melhoria_itens;
create policy melhoria_itens_update on public.melhoria_itens for update to authenticated
using (has_role((select auth.uid()), 'master'::app_role))
with check (has_role((select auth.uid()), 'master'::app_role));

-- Sem policy de DELETE (descartar é status; nada é apagado).

-- Mensagens: vê quem vê o item.
drop policy if exists melhoria_mensagens_select on public.melhoria_mensagens;
create policy melhoria_mensagens_select on public.melhoria_mensagens for select to authenticated
using (
  exists (
    select 1 from public.melhoria_itens i
    where i.id = melhoria_mensagens.item_id
      and (i.autor_user_id = (select auth.uid()) or has_role((select auth.uid()), 'master'::app_role))
  )
);

-- INSERT: autor do item manda réplica (papel funcionario) em item não-finalizado;
-- master responde (papel founder). Mensagens papel='ia' SÓ via service_role (sem policy — bypassa).
-- `dados` é exclusivo da edge via service_role: humano nunca grava a tabela de evidência.
drop policy if exists melhoria_mensagens_insert on public.melhoria_mensagens;
create policy melhoria_mensagens_insert on public.melhoria_mensagens for insert to authenticated
with check (
  autor_user_id = (select auth.uid())
  and dados is null
  and (
    (
      papel = 'funcionario'
      and exists (
        select 1 from public.melhoria_itens i
        where i.id = melhoria_mensagens.item_id
          and i.autor_user_id = (select auth.uid())
          and i.status in ('aberto','em_andamento')
      )
    )
    or (
      papel = 'founder'
      and has_role((select auth.uid()), 'master'::app_role)
    )
  )
);

-- ============ RPCs DE DADOS (ferramentas da IA) ============
-- SECURITY DEFINER com gate interno: staff obrigatório; visibilidade de clientes
-- respeita carteira (pode_ver_carteira_completa / carteira_visivel_para — #329).
-- Chamadas pela edge com o JWT do CALLER (auth.uid() = solicitante real).

create or replace function public.melhoria_clientes_por_produto(p_termo text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_full boolean;
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;
  v_full := pode_ver_carteira_completa(v_uid);

  with prods as (
    select id, descricao, codigo, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike '%' || trim(p_termo) || '%' or codigo ilike '%' || trim(p_termo) || '%')
    order by descricao
    limit 5
  ),
  compras as (
    select oi.customer_user_id,
           count(distinct oi.sales_order_id) as n_pedidos,
           max(coalesce(so.order_date_kpi, so.created_at::date)) as ultima_compra,
           sum(oi.quantity * oi.unit_price) as valor_12m
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    join prods p on p.id = oi.product_id
    where so.status not in ('cancelado','rascunho','pendente')   -- pedido válido (padrão #279)
      and so.deleted_at is null
      and coalesce(so.order_date_kpi, so.created_at::date) >= current_date - interval '12 months'
    group by oi.customer_user_id
  ),
  visiveis as (
    select c.* from compras c
    where v_full or carteira_visivel_para(c.customer_user_id, v_uid)
  ),
  top50 as (
    select * from visiveis order by valor_12m desc limit 50
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from prods),
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object(
        'cliente', coalesce(pr.razao_social, pr.name),
        'n_pedidos', t.n_pedidos,
        'ultima_compra', t.ultima_compra,
        'valor_12m', round(t.valor_12m::numeric, 2)
      ) order by t.valor_12m desc), '[]'::jsonb)
      from top50 t join profiles pr on pr.user_id = t.customer_user_id),
    'total_clientes_visiveis', (select count(*) from visiveis),
    'escopo', case when v_full then 'todos' else 'minha_carteira' end
  ) into v_result;

  return v_result;
end $$;

revoke execute on function public.melhoria_clientes_por_produto(text) from anon, public;
grant execute on function public.melhoria_clientes_por_produto(text) to authenticated, service_role;

create or replace function public.melhoria_produtos_relacionados(p_termo text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;

  with alvo as (
    select id, descricao, codigo, familia, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike '%' || trim(p_termo) || '%' or codigo ilike '%' || trim(p_termo) || '%')
    order by descricao
    limit 5
  ),
  mesma_familia as (
    select distinct op.descricao, op.codigo, op.familia
    from omie_products op
    join alvo a on a.familia is not null and op.familia = a.familia and op.account = a.account
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
    limit 10
  ),
  regras as (
    -- arrays gravados pelo engine de associação guardam omie_products.id como texto
    select cons_id, max(r.confidence) as confidence, max(r.lift) as lift
    from farmer_association_rules r
    cross join lateral unnest(r.consequent_product_ids::text[]) as cons_id
    where exists (select 1 from alvo a where a.id::text = any(r.antecedent_product_ids::text[]))
    group by cons_id
    order by max(r.lift) desc
    limit 10
  ),
  comprados_juntos as (
    select op.descricao, op.codigo, round(r.confidence::numeric, 3) as confidence, round(r.lift::numeric, 2) as lift
    from regras r
    join omie_products op on op.id::text = r.cons_id
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from alvo),
    'mesma_familia', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'familia', familia)), '[]'::jsonb) from mesma_familia),
    'comprados_juntos', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'confidence', confidence, 'lift', lift)), '[]'::jsonb) from comprados_juntos)
  ) into v_result;

  return v_result;
end $$;

revoke execute on function public.melhoria_produtos_relacionados(text) from anon, public;
grant execute on function public.melhoria_produtos_relacionados(text) to authenticated, service_role;
