-- PR-4 v2 — correções do challenge adversarial do Codex (gpt-5.6-sol xhigh, 2026-07-13)
-- sobre a 20260713040000 (mesmo PR, nunca aplicada sozinha em prod):
--
-- P0-1: o CTE "praticado" filtrava cliente+SKU mas NÃO a CONTA do pedido pai —
--   cliente com histórico em 2 contas contaminaria a proposta oben com preço colacor
--   (códigos Omie podem coincidir numericamente entre contas e são produtos DISTINTOS).
--   Fix: JOIN sales_orders + so.account = p_account.
-- P1-10: "último praticado" com created_at NULL caía no tie-break por id (arbitrário,
--   não cronologia comercial). Fix: COALESCE(oi.created_at, so.created_at).
-- P0-3: idempotência do orçamento por conversa+status+janela-24h não segura
--   concorrência (2 abas → 2 orçamentos; convertido/fora-da-janela recriado).
--   Fix: identidade IMUTÁVEL da proposta em sales_orders + UNIQUE parcial — o
--   INSERT vira atômico (23505 → reusar o existente).

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
    -- último preço praticado VÁLIDO do próprio cliente NA CONTA consultada, por SKU
    -- (cronologia comercial: item → pedido pai; tie-break estável por id)
    SELECT DISTINCT ON (oi.omie_codigo_produto)
           oi.omie_codigo_produto, oi.unit_price
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE oi.customer_user_id = p_customer_user_id
       AND so.account = p_account
       AND oi.omie_codigo_produto = ANY(p_skus)
       AND oi.unit_price > 0
       AND oi.unit_price <> 'NaN'::numeric
       AND oi.unit_price < 'Infinity'::numeric
     ORDER BY oi.omie_codigo_produto,
              COALESCE(oi.created_at, so.created_at) DESC NULLS LAST,
              oi.id DESC
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

-- (grants idem 040000 — re-afirmados por segurança em apply parcial)
REVOKE ALL ON FUNCTION public.get_whatsapp_proposta_cotacao(uuid, text, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_proposta_cotacao(uuid, text, bigint[]) TO authenticated, service_role;

-- Identidade imutável da proposta (espelha a dedupe_key do envio: proposta:{customer}:{rota}).
-- NULL para pedidos/orçamentos normais; UNIQUE parcial fecha a corrida de dupla-gravação.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS whatsapp_proposta_dedupe text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_so_whatsapp_proposta_dedupe
  ON public.sales_orders(whatsapp_proposta_dedupe)
  WHERE whatsapp_proposta_dedupe IS NOT NULL;
