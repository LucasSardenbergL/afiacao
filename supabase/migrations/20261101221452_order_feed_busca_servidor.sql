-- order_feed: busca no servidor + itens calculados só para a página (plano v4, lote 8 — C3).
--
-- A tela de Pedidos baixava 5 × 1.000 linhas da view a cada abertura (1,19 MB) e buscava em JS;
-- com ~32 k pedidos, a busca não achava nada fora do recorte. Agora a tela pagina e busca no
-- servidor. Duas mudanças na view, mesmas 13 colunas na mesma ordem e com o mesmo conteúdo:
--
--  1. `item_names`/`item_quantity` saem da UNION e passam a ser calculados na projeção final, a
--     partir do jsonb cru. Com ORDER BY created_at LIMIT n, o Postgres adia a subconsulta para
--     depois do Sort e só desmonta o jsonb das n linhas da página. Medido na prod (2026-11-01,
--     claude_ro, 32.159 pedidos): página de 50 sem filtro 370 ms → 54 ms.
--  2. Coluna nova no FIM, `busca`: nome do cliente (entidades HTML decodificadas como o
--     `decodeHtml` do front), nº do pedido, nomes dos itens e o total em "250.50" e "250,50",
--     em minúsculas e sem acento (`translate` — a prod não tem `unaccent`; as maiúsculas acentuadas
--     estão no mapa porque `lower` sob locale C não as abaixa). Separador '\n' entre
--     campos: o input de busca não digita quebra de linha, então um termo não casa atravessando
--     dois campos — o mesmo comportamento do filtro em JS que ela substitui
--     (`filterFeedRows` em src/components/salesOrders/feed.ts). O front normaliza o termo do mesmo
--     jeito e filtra com `.ilike('busca', '%termo%')`. Custa um scan dos ~32 k (~0,6 s medido) por
--     busca; a coluna só é calculada quando a consulta a cita.
--
-- Molde TRAVA → PRE → CREATE → PÓS (.claude/skills/lovable-db-operator/references/sql-house-style.md).
-- Sem BEGIN/COMMIT: aplica por `bun run db:aplicar` (a transação é do executor).

-- TRAVA: ALTER sem efeito (security_invoker já é true na prod) prende a view até o COMMIT.
DO $trava$
BEGIN
  IF to_regclass('public.order_feed') IS NULL THEN
    RAISE EXCEPTION 'TRAVA: public.order_feed ausente — esta migration recria a view de 20260606210000, não a cria';
  END IF;
  ALTER VIEW public.order_feed SET (security_invoker = true);
END
$trava$;

-- PRE: o corpo vivo é o de 20260606210000 (md5 lido na prod em 2026-11-01) ou já é este.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(pg_catalog.pg_get_viewdef('public.order_feed'::regclass, true)));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('083e23c30670e87c39a7221bfcbc2b0f', '5a047aa4851f7eaac81ce50d1b6c1f28') THEN
    RAISE EXCEPTION 'PRE FALHOU: order_feed vivo (md5 %) não é o de 20260606210000 nem este — outra sessão mudou a view; confira antes de recriar', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.order_feed
WITH (security_invoker = true)
AS
WITH feed AS (
  SELECT
    'sales'::text               AS origin,
    so.id::uuid                 AS id,
    so.created_at::timestamptz  AS created_at,
    so.account::text            AS account,
    so.omie_numero_pedido::text AS order_number,
    so.omie_pedido_id::bigint   AS omie_pedido_id,
    so.customer_user_id::uuid   AS customer_user_id,
    so.items                    AS items,
    so.status::text             AS status,
    so.subtotal::numeric        AS subtotal,
    so.total::numeric           AS total
  FROM public.sales_orders so
  WHERE so.deleted_at IS NULL

  UNION ALL

  SELECT
    'afiacao'::text             AS origin,
    o.id::uuid                  AS id,
    o.created_at::timestamptz   AS created_at,
    'colacor_sc'::text          AS account,
    NULL::text                  AS order_number,
    NULL::bigint                AS omie_pedido_id,
    o.user_id::uuid             AS customer_user_id,
    o.items                     AS items,
    o.status::text              AS status,
    o.subtotal::numeric         AS subtotal,
    o.total::numeric            AS total
  FROM public.orders o
)
SELECT
  f.origin,
  f.id,
  f.created_at,
  f.account,
  f.order_number,
  f.omie_pedido_id,
  f.customer_user_id,
  p.name::text AS customer_name,
  -- Nome de cada item: sales usa 'descricao' (vazio fica de fora); afiação usa category → name → 'Afiação'.
  CASE WHEN jsonb_typeof(f.items) = 'array' THEN COALESCE((
    SELECT array_agg(n.nome ORDER BY t.ord) FILTER (WHERE n.nome IS NOT NULL)
    FROM jsonb_array_elements(f.items) WITH ORDINALITY AS t(elem, ord)
    CROSS JOIN LATERAL (SELECT CASE WHEN f.origin = 'sales'
      THEN NULLIF(t.elem->>'descricao', '')
      ELSE COALESCE(NULLIF(t.elem->>'category', ''), NULLIF(t.elem->>'name', ''), 'Afiação') END AS nome) n
  ), '{}'::text[]) ELSE '{}'::text[] END AS item_names,
  -- Quantidade: sales soma 'quantidade' (malformada conta 0); afiação soma 'quantity' (malformada conta 1).
  CASE WHEN jsonb_typeof(f.items) = 'array' THEN COALESCE((
    SELECT sum(CASE WHEN (elem->>k.chave) ~ '^-?[0-9]+(\.[0-9]+)?$'
                    THEN (elem->>k.chave)::numeric ELSE k.padrao END)
    FROM jsonb_array_elements(f.items) AS elem
    CROSS JOIN LATERAL (SELECT CASE WHEN f.origin = 'sales' THEN 'quantidade' ELSE 'quantity' END AS chave,
                               CASE WHEN f.origin = 'sales' THEN 0 ELSE 1 END::numeric AS padrao) k
  ), 0) ELSE 0 END::numeric AS item_quantity,
  f.status,
  f.subtotal,
  f.total,
  translate(lower(
    COALESCE(replace(replace(replace(replace(replace(p.name,
      '&amp;', '&'), '&apos;', ''''), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '')
    || E'\n' || COALESCE(f.order_number, '')
    || E'\n' || CASE WHEN jsonb_typeof(f.items) = 'array' THEN COALESCE((
         SELECT string_agg(n.nome, ' ' ORDER BY t.ord)
         FROM jsonb_array_elements(f.items) WITH ORDINALITY AS t(elem, ord)
         CROSS JOIN LATERAL (SELECT CASE WHEN f.origin = 'sales'
           THEN NULLIF(t.elem->>'descricao', '')
           ELSE COALESCE(NULLIF(t.elem->>'category', ''), NULLIF(t.elem->>'name', ''), 'Afiação') END AS nome) n
       ), '') ELSE '' END
    || E'\n' || round(COALESCE(f.total, 0), 2)::text
    || E'\n' || replace(round(COALESCE(f.total, 0), 2)::text, '.', ',')
  ), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
    'aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny')::text AS busca
FROM feed f
LEFT JOIN public.profiles p ON p.user_id = f.customer_user_id;

COMMENT ON VIEW public.order_feed IS
  'Read model da listagem de pedidos (/sales): UNION de sales_orders + orders (afiação) com nome do cliente. Enxuto — detalhe busca por (origin,id). Coluna busca (minúsculas, sem acento) para .ilike no servidor. security_invoker.';

-- PÓS: o corpo vivo é ESTE, a view segue security_invoker e `busca` é a 14ª coluna.
DO $pos$
BEGIN
  IF (SELECT md5(pg_catalog.pg_get_viewdef('public.order_feed'::regclass, true))) IS DISTINCT FROM '5a047aa4851f7eaac81ce50d1b6c1f28' THEN
    RAISE EXCEPTION 'POS FALHOU: order_feed não ficou com o corpo desta migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
    WHERE c.oid = 'public.order_feed'::regclass AND o IN ('security_invoker=true', 'security_invoker=on')
  ) THEN
    RAISE EXCEPTION 'POS FALHOU: order_feed perdeu security_invoker — leria como OWNER e furaria a RLS';
  END IF;
  IF (SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.order_feed'::regclass AND attnum = 14 AND NOT attisdropped) IS DISTINCT FROM 'busca' THEN
    RAISE EXCEPTION 'POS FALHOU: busca não é a 14ª coluna de order_feed';
  END IF;
END
$pos$;

NOTIFY pgrst, 'reload schema';
