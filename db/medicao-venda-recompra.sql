-- Medição da Task 2 (Venda por cliente) — lê os snapshots venda_recompra / venda_situacao.
-- Rode depois do apply da 20261020150000_venda_cliente_recompra.sql:
--   ~/.config/afiacao/psql-ro -X -tA -F'|' -v ON_ERROR_STOP=1 -f db/medicao-venda-recompra.sql
-- A: compradores por situação · B: SKUs (total | atrasados | sem preço) · C: por farmer, compradores da
-- carteira elegível (alias → canônico) com ≥1 SKU atrasado, perdidos, com histórico e R$ atrasado.
WITH dono AS (
  SELECT DISTINCT COALESCE(a.canonical_user_id, ca.customer_user_id) AS comprador_id, ca.owner_user_id
    FROM public.carteira_assignments ca
    LEFT JOIN public.customer_canonical_alias a
           ON a.alias_user_id = ca.customer_user_id AND a.status = 'active'
   WHERE ca.eligible
)
SELECT 'A situacao' AS bloco, s.situacao AS k, count(*)::text AS v
  FROM public.venda_situacao s GROUP BY 2
UNION ALL
SELECT 'B skus', 'total|atrasados|preco_nulo',
       count(*) || '|' || count(*) FILTER (WHERE atrasado) || '|' || count(*) FILTER (WHERE ultimo_preco IS NULL)
  FROM public.venda_recompra
UNION ALL
SELECT 'C farmer', coalesce(split_part(p.name, ' ', 1), f.user_id::text),
       count(DISTINCT s.comprador_id) FILTER (WHERE s.situacao = 'atrasado') || ' compradores atrasados · ' ||
       count(DISTINCT s.comprador_id) FILTER (WHERE s.situacao = 'perdido') || ' perdidos · ' ||
       count(DISTINCT s.comprador_id) || ' com histórico · R$ ' ||
       round(coalesce(sum(s.valor_atrasado) FILTER (WHERE s.situacao = 'atrasado'), 0)) || ' atrasado'
  FROM public.commercial_roles f
  JOIN dono d ON d.owner_user_id = f.user_id
  JOIN public.venda_situacao s ON s.comprador_id = d.comprador_id
  LEFT JOIN public.profiles p ON p.user_id = f.user_id
 WHERE f.commercial_role = 'farmer'
 GROUP BY 2
UNION ALL
SELECT 'Z data_referencia', min(data_referencia)::text, max(calculado_em)::text FROM public.venda_situacao
ORDER BY 1, 2;
