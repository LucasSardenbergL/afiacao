-- Grupo de Cliente 360 — contatos consolidados do grupo (aba Contatos): migra o JOIN do espelho poluído
-- omie_clientes para a VIEW FRESCA account-correta omie_customer_account_map_fresco, filtrando a conta OBEN.
-- P0-B-bis PR-4 (#10). O espelho tem empresa_omie 100% 'colacor' (rótulo fabricado, nenhum writer o seta)
-- e omie_codigo_vendedor de conta arbitrária; a fresca é document-first, UNIQUE(user_id,account), TTL 7d
-- (só o vínculo visto no Omie nos últimos 7d). security_invoker preservado (respeita a RLS de
-- profiles/addresses/fresca). Precisão>recall: cliente sem vínculo oben fresco → vendedor NULL honesto,
-- nunca o vendedor de OUTRA conta do espelho poluído.
--
-- CREATE OR REPLACE: mesmas colunas, MESMA ordem/nome/tipo — só a FONTE do JOIN muda. empresa_omie agora
-- expõe oc.account ('oben' quando há linha fresca | NULL), no lugar do rótulo 'colacor' fabricado.
-- ATENÇÃO: migration custom — aplicar manualmente no Lovable SQL Editor (não auto-aplica).

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
       oc.account as empresa_omie
from public.cliente_grupo_membros m
join public.profiles p
  on regexp_replace(coalesce(p.cnpj, p.document, ''), '\D', '', 'g') = m.documento
left join public.addresses a on a.user_id = p.user_id and a.is_default = true   -- ⚙️ se addresses não tiver is_default, remover o predicado
left join public.omie_customer_account_map_fresco oc
  on oc.user_id = p.user_id and oc.account = 'oben';
