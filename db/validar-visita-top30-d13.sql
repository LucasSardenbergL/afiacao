-- Visita (plano v8, D13) — top 30 do card de sugestões por dono, só leitura. Mesma lógica de useMyVisitSuggestions:
-- cidades com visit_score > 30 da carteira (farmer_id = dono, sem as carteiras cobertas), cidade padrão = maior
-- top_score, top 30 da cidade por visit_score desc. "nunca_comprou" = sem pedido e histórico fora de ativo/stale.
-- Uso: ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -X -v simular=0 -f db/validar-visita-top30-d13.sql
--      simular=0 → a tabela como está; simular=1 → aplica a regra nova (nunca comprou e não lead → 10) sobre a linha.
with base as (
  select cvs.customer_user_id, cvs.farmer_id, cvs.city,
    ((cvs.score_breakdown->'inputs'->>'sales_orders_count')::int = 0
      and coalesce(fcs.sales_history_status,'') not in ('ativo','stale')) as nunca_comprou,
    coalesce(p.is_prospect,false) as lead,
    cvs.visit_score as v_atual
  from customer_visit_scores cvs
  left join farmer_client_scores fcs using (customer_user_id)
  left join profiles p on p.user_id = cvs.customer_user_id
  where cvs.city is not null
), s as (
  select *, case when :simular = 1 and nunca_comprou and not lead then 10 else v_atual end as v from base
), donos as (
  select s.farmer_id, coalesce(pr.name, s.farmer_id::text) dono from (select distinct farmer_id from s) s left join profiles pr on pr.user_id = s.farmer_id
), cidades as (
  select farmer_id, city, max(v) top, count(*) n from s where v > 30 group by 1,2
), padrao as (
  select distinct on (farmer_id) farmer_id, city, n from cidades order by farmer_id, top desc, n desc, city
), rk as (
  select s.*, row_number() over (partition by s.farmer_id, s.city order by s.v desc, s.customer_user_id) r from s
  join cidades c on c.farmer_id = s.farmer_id and c.city = s.city
)
select d.dono,
  (select count(*) from cidades c where c.farmer_id=d.farmer_id) cidades_na_lista,
  count(*) filter (where r<=30) vagas_top30,
  count(*) filter (where r<=30 and nunca_comprou) top30_nunca_comprou,
  count(*) filter (where r<=30 and not nunca_comprou) top30_compradores,
  pa.city cidade_padrao,
  count(*) filter (where r<=30 and rk.city=pa.city and not nunca_comprou) padrao_compradores_no_top30,
  count(*) filter (where r<=30 and rk.city=pa.city) padrao_vagas
from rk join donos d using (farmer_id) left join padrao pa on pa.farmer_id = rk.farmer_id
group by d.dono, d.farmer_id, pa.city having count(*) filter (where r<=30) > 20 order by 3 desc;
