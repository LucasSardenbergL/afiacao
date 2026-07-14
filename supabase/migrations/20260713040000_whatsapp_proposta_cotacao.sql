-- PR-4 do Canal WhatsApp: recotação Omie no ENVIO da proposta 1-toque.
-- Money-path: preço = último PRATICADO válido do PRÓPRIO cliente (order_items) ▸ preço de
-- TABELA (omie_products.valor_unitario) ▸ NULL. Mesma precedência do helper provado
-- mergeCustomerPrices (praticado vence, tabela preenche gap, inválido ignorado).
-- "Válido" exclui ≤0, NaN e Infinity — em Postgres numeric 'NaN' > 0 é TRUE (NaN ordena
-- acima de tudo), então o predicado ingênuo `> 0` vazaria NaN como "preço".
-- Ausente ≠ zero: preco sai NULL, jamais COALESCE(…, 0) — a trava é do consumidor.
-- SECURITY INVOKER: a RLS das bases morde — não-staff não lê order_items de terceiro
-- (o "praticado" alheio NÃO vaza; o catálogo omie_products já é visível a authenticated).
-- Estoque NULL = desconhecido (≠ 0); SKU fora do catálogo da conta NÃO retorna linha
-- (o consumidor trava por 'nao_encontrado').

CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(
  p_customer_user_id uuid,
  p_account text,
  p_skus bigint[]
)
RETURNS TABLE (
  omie_codigo_produto bigint,
  product_id uuid,
  codigo text,
  descricao text,
  unidade text,
  ativo boolean,
  estoque numeric,
  preco numeric,
  fonte_preco text
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH praticado AS (
    -- último preço praticado VÁLIDO do próprio cliente, por SKU (mais recente vence;
    -- created_at NULL trata-se como mais antigo; tie-break estável por id)
    SELECT DISTINCT ON (oi.omie_codigo_produto)
           oi.omie_codigo_produto, oi.unit_price
      FROM public.order_items oi
     WHERE oi.customer_user_id = p_customer_user_id
       AND oi.omie_codigo_produto = ANY(p_skus)
       AND oi.unit_price > 0
       AND oi.unit_price <> 'NaN'::numeric
       AND oi.unit_price < 'Infinity'::numeric
     ORDER BY oi.omie_codigo_produto, oi.created_at DESC NULLS LAST, oi.id DESC
  )
  SELECT p.omie_codigo_produto,
         p.id AS product_id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.ativo,
         p.estoque,
         COALESCE(
           pr.unit_price,
           CASE WHEN p.valor_unitario > 0
                 AND p.valor_unitario <> 'NaN'::numeric
                 AND p.valor_unitario < 'Infinity'::numeric
                THEN p.valor_unitario END
         ) AS preco,
         CASE WHEN pr.unit_price IS NOT NULL THEN 'praticado'
              WHEN p.valor_unitario > 0
               AND p.valor_unitario <> 'NaN'::numeric
               AND p.valor_unitario < 'Infinity'::numeric THEN 'tabela'
         END AS fonte_preco
    FROM public.omie_products p
    LEFT JOIN praticado pr ON pr.omie_codigo_produto = p.omie_codigo_produto
   WHERE p.account = p_account
     AND p.omie_codigo_produto = ANY(p_skus);
$$;

-- Função nova nasce com EXECUTE pra PUBLIC — revogar por nome (CLAUDE.md)
REVOKE ALL ON FUNCTION public.get_whatsapp_proposta_cotacao(uuid, text, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_proposta_cotacao(uuid, text, bigint[]) TO authenticated, service_role;
