-- Grupo de Cliente 360 — Fase 1: view de contatos consolidados do grupo (aba Contatos).
-- Read-only (não money-path): nome/telefone/endereço/vendedor por documento do grupo.
-- security_invoker = true: respeita a RLS de profiles/addresses/omie_clientes (staff vê tudo).
-- ATENÇÃO: migration custom — aplicar manualmente no Lovable SQL Editor.

create or replace view public.v_grupo_contatos
with (security_invoker = true) as
select m.grupo_id,
       m.documento,
       p.user_id,
       coalesce(p.razao_social, p.name) as nome,
       p.phone,
       p.email,
       a.city  as cidade,
       a.state as uf,
       nullif(trim(coalesce(a.street,'') || ' ' || coalesce(a.number,'')), '') as endereco,
       oc.omie_codigo_vendedor,
       oc.empresa_omie
from public.cliente_grupo_membros m
join public.profiles p
  on regexp_replace(coalesce(p.cnpj, p.document, ''), '\D', '', 'g') = m.documento
left join public.addresses a on a.user_id = p.user_id and a.is_default = true   -- ⚙️ se addresses não tiver is_default, remover o predicado
left join public.omie_clientes oc on oc.user_id = p.user_id;
