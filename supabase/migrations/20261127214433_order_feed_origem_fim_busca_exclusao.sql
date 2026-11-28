-- /sales leva 3, PR B — order_feed: procedência Omie, fim do período, busca pré-calculada e
-- recuperação server-side da exclusão.   [money-path]
-- Prova: db/test-order-feed-leva3-b.sh (PG17: view/RPC executadas, paridade, RLS, ACL, falsificação)
--
-- #5  A lista decidia "Editar"/"Excluir" pelo STATUS, mas procedência Omie e status "importado" são
--     fatos diferentes: na prod (psql-ro, 2026-11-27) 13 pedidos de origem Omie em `separacao`
--     ganhavam "Editar" e 11.269 `cancelado` ganhavam "Excluir" que a edge sempre recusa. A view
--     ganha `origem_omie` (15ª coluna, NO FIM): hash_payload LIKE 'omie\_%' — o MESMO teste da edge
--     (vereditoExclusaoNoOmie: hashPayload.startsWith("omie_")). Afiação: false.
-- #31 order_feed_total ganha o FIM exclusivo do período (p_ate + p_puros_fim, espelho de
--     p_desde + p_puros): created_at < p_ate E created_at fora das datas-puras do dia seguinte.
--     A assinatura muda ⇒ DROP + CREATE, e o ACL é reemitido nomeando PUBLIC e anon.
-- #35 A coluna `busca` montava o texto de cada pedido (jsonb_array_elements nas 32 mil linhas, ~1,3 s)
--     em DUAS consultas por tela (página e valor do recorte). A parte cara (número, itens, total) vira
--     a coluna GERADA sales_orders.busca_base, calculada uma vez por escrita; a view só junta o nome
--     do cliente (que mora em profiles e muda sem tocar o pedido). O texto final é o MESMO: a PÓS
--     compara, linha a linha, a `busca` nova com a expressão antiga.
-- #19 A exclusão da lista marca deleted_at no navegador, chama a edge e só ele desfaz a marca das
--     falhas: fechar a aba no meio deixa pedidos ocultos para sempre. Agora o servidor recupera:
--       · sales_orders_exclusao_marca registra a marca que um usuário (role authenticated) grava —
--         e só ela. O deleted_at que o cron omie-pv-exclusao-reconciliar grava (service_role, PV
--         excluído no Omie) é baixa LEGÍTIMA e NUNCA é desfeito daqui.
--       · private.sales_orders_exclusao_recuperar() desfaz a marca que segue igual depois de 2 h
--         com o pedido ainda existindo (a edge, no sucesso, APAGA a linha — a marca some junto).
--       · cron a cada 10 min (SQL puro, sem net.http_post).
--     A edge omie-vendas-sync NÃO muda (fatia C).
--
-- Molde TRAVA → PRE → CREATE → PÓS. Transacional (BEGIN/COMMIT): cole INTEIRO no SQL Editor.
-- Idempotente: re-colar é seguro. ANTES do Publish do front (a lista lê `origem_omie` e passa p_ate).

BEGIN;

-- TRAVA: ALTER sem efeito (security_invoker já é true na prod) prende a view até o COMMIT.
DO $trava$
BEGIN
  IF to_regclass('public.order_feed') IS NULL THEN
    RAISE EXCEPTION 'TRAVA: public.order_feed ausente — esta migration recria a view, não a cria';
  END IF;
  ALTER VIEW public.order_feed SET (security_invoker = true);
END
$trava$;

-- PRE: o corpo vivo é o de 20261102160821 (md5 conferido na prod em 2026-11-27) ou já é este.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(pg_catalog.pg_get_viewdef('public.order_feed'::regclass, true)));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('dee24dde20ac343a81f9ebaa0e6df44f', '7f74d95f5205b25fa9e35c64f20bb44e') THEN
    RAISE EXCEPTION 'PRE_FALHOU: order_feed vivo (md5 %) não é o de 20261102160821 nem este — outra sessão mudou a view; confira antes de recriar', v_vivo;
  END IF;
  IF to_regprocedure('public.order_feed_do_vendedor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE_FALHOU: order_feed_do_vendedor ausente (20261123120000 não aplicada)';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'hash_payload', 'SELECT') THEN
    RAISE EXCEPTION 'PRE_FALHOU: authenticated não lê sales_orders.hash_payload — a view security_invoker daria 42501';
  END IF;
END
$pre$;

-- #35 ─ texto de busca do pedido, sem o nome do cliente ──────────────────────────────────────────
-- IMMUTABLE de verdade: só jsonb/texto/numeric. Mudar o corpo NÃO recalcula as linhas gravadas
-- (coluna gerada STORED): quem mudar recria a coluna.
CREATE OR REPLACE FUNCTION private.busca_base_pedido(p_origin text, p_items jsonb, p_numero text, p_total numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT translate(lower(
    E'\n' || COALESCE(p_numero, '')
    || E'\n' || CASE WHEN jsonb_typeof(p_items) = 'array' THEN COALESCE((
         SELECT string_agg(n.nome, ' ' ORDER BY t.ord)
         FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(elem, ord)
         CROSS JOIN LATERAL (SELECT CASE WHEN p_origin = 'sales'
           THEN NULLIF(t.elem->>'descricao', '')
           ELSE COALESCE(NULLIF(t.elem->>'category', ''), NULLIF(t.elem->>'name', ''), 'Afiação') END AS nome) n
       ), '') ELSE '' END
    || E'\n' || round(COALESCE(p_total, 0), 2)::text
    || E'\n' || replace(round(COALESCE(p_total, 0), 2)::text, '.', ',')
  ), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
     'aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny')
$fn$;

COMMENT ON FUNCTION private.busca_base_pedido(text, jsonb, text, numeric) IS
  'Parte da coluna order_feed.busca que não depende do cliente: \n número \n itens \n total \n total com vírgula, em minúsculas e sem acento. Base da coluna gerada sales_orders.busca_base.';

-- EXECUTE fica no padrão (PUBLIC) de propósito: função pura sobre os próprios argumentos, e TODO papel
-- que grava sales_orders (recalcula a coluna) ou lê order_feed (linha de afiação) precisa dela —
-- authenticated, service_role, claude_ro, o conector do Lovable. Fechar daria 42501 a quem não se listou.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS busca_base text
  GENERATED ALWAYS AS (private.busca_base_pedido('sales', items, omie_numero_pedido, total)) STORED;

COMMENT ON COLUMN public.sales_orders.busca_base IS
  'Gerada (não escreva): texto de busca do pedido sem o nome do cliente. A view order_feed junta o nome. 1 escritor: o próprio Postgres.';

-- sales_orders é fechada por COLUNA para authenticated: a view security_invoker lê esta coluna.
GRANT SELECT (busca_base) ON public.sales_orders TO authenticated;

-- #5 + #35 ─ a view ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.order_feed
WITH (security_invoker = true)
AS
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
  -- Nome do cliente (minúsculo, sem acento, entidades HTML decodificadas) + a base pré-calculada.
  (translate(lower(
    COALESCE(replace(replace(replace(replace(replace(p.name,
      '&amp;', '&'), '&apos;', ''''), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '')
  ), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
    'aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny') || f.busca_base)::text AS busca,
  f.origem_omie
FROM (
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
      so.total::numeric           AS total,
      so.busca_base               AS busca_base,
      COALESCE(so.hash_payload LIKE 'omie\_%', false) AS origem_omie
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
      o.total::numeric            AS total,
      private.busca_base_pedido('afiacao', o.items, NULL, o.total::numeric) AS busca_base,
      false                       AS origem_omie
    FROM public.orders o
) f
LEFT JOIN public.profiles p ON p.user_id = f.customer_user_id;

COMMENT ON VIEW public.order_feed IS
  'Read model da listagem de pedidos (/sales): UNION de sales_orders + orders (afiação) com nome do cliente. Enxuto — detalhe busca por (origin,id). busca = nome do cliente + sales_orders.busca_base (gerada) para .ilike no servidor. origem_omie = procedência Omie (hash_payload omie_*), não o status. Sem CTE de propósito. security_invoker.';

-- #31 ─ valor do recorte com o fim do período ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.order_feed_total(
  p_account   text          DEFAULT NULL,
  p_status    text[]        DEFAULT NULL,
  p_desde     timestamptz   DEFAULT NULL,
  p_puros     timestamptz[] DEFAULT NULL,
  p_customer  uuid          DEFAULT NULL,
  p_busca     text          DEFAULT NULL,
  p_vendedor  uuid          DEFAULT NULL,
  p_ate       timestamptz   DEFAULT NULL,
  p_puros_fim timestamptz[] DEFAULT NULL
)
RETURNS TABLE (pedidos bigint, soma numeric, sem_total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Fonte: a view inteira, ou só os pedidos do vendedor. Um ramo por fonte (não um OR): a função
  -- do vendedor recusa NULL e nunca deve ser avaliada quando o recorte não é "Meus".
  -- Fim do período (#31): created_at < p_ate E fora das datas-puras do dia seguinte (p_puros_fim,
  -- espelho de p_puros no início) — a listagem aplica o MESMO par (.lt + .neq).
  IF p_vendedor IS NULL THEN
    RETURN QUERY
      SELECT count(*)::bigint, round(sum(f.total), 2), count(*) FILTER (WHERE f.total IS NULL)::bigint
      FROM public.order_feed f
      WHERE (p_account  IS NULL OR f.account = p_account)
        AND (p_status   IS NULL OR f.status = ANY (p_status))
        AND (p_desde    IS NULL OR f.created_at >= p_desde OR f.created_at = ANY (COALESCE(p_puros, '{}'::timestamptz[])))
        AND (p_ate      IS NULL OR (f.created_at < p_ate AND NOT (f.created_at = ANY (COALESCE(p_puros_fim, '{}'::timestamptz[])))))
        AND (p_customer IS NULL OR f.customer_user_id = p_customer)
        AND (p_busca    IS NULL OR f.busca ILIKE private.padrao_like_contem(p_busca) ESCAPE '\');
  ELSE
    RETURN QUERY
      SELECT count(*)::bigint, round(sum(f.total), 2), count(*) FILTER (WHERE f.total IS NULL)::bigint
      FROM public.order_feed_do_vendedor(p_vendedor) f
      WHERE (p_account  IS NULL OR f.account = p_account)
        AND (p_status   IS NULL OR f.status = ANY (p_status))
        AND (p_desde    IS NULL OR f.created_at >= p_desde OR f.created_at = ANY (COALESCE(p_puros, '{}'::timestamptz[])))
        AND (p_ate      IS NULL OR (f.created_at < p_ate AND NOT (f.created_at = ANY (COALESCE(p_puros_fim, '{}'::timestamptz[])))))
        AND (p_customer IS NULL OR f.customer_user_id = p_customer)
        AND (p_busca    IS NULL OR f.busca ILIKE private.padrao_like_contem(p_busca) ESCAPE '\');
  END IF;
END
$fn$;

COMMENT ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid, timestamptz, timestamptz[]) IS
  'Valor do recorte da listagem /sales: os MESMOS filtros que o front aplica em order_feed (feed.ts → recorteDoFeed), com o fim exclusivo do período (p_ate/p_puros_fim). soma NULL = nenhum total conhecido (ausente ≠ zero). SECURITY INVOKER: RLS da view vale igual.';

-- DROP + CREATE resetou o ACL: reemitido nomeando as roles.
REVOKE ALL ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid, timestamptz, timestamptz[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid, timestamptz, timestamptz[]) TO authenticated, service_role;

-- #19 ─ marca de exclusão do usuário e a recuperação pelo servidor ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_orders_exclusao_marca (
  sales_order_id uuid PRIMARY KEY REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  carimbo        timestamptz NOT NULL,
  marcado_por    uuid,
  marcado_em     timestamptz NOT NULL DEFAULT now(),
  desfecho       text CHECK (desfecho IN ('desfeito', 'recuperado', 'mantido')),
  resolvido_em   timestamptz
);

COMMENT ON TABLE public.sales_orders_exclusao_marca IS
  'Marca de exclusão gravada por um USUÁRIO (deleted_at via PostgREST, role authenticated) em sales_orders. desfecho NULL = em curso. Sucesso da edge apaga o pedido e a marca (cascade); desfeito = o navegador desfez; recuperado = o servidor desfez (private.sales_orders_exclusao_recuperar); mantido = o servidor tentou e a baixa do Omie (trg_sales_orders_pv_excluido_omie) manteve oculto. 1 escritor: o trigger trg_sales_orders_exclusao_marca + a recuperação.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_exclusao_marca_em_curso
  ON public.sales_orders_exclusao_marca (marcado_em) WHERE desfecho IS NULL;

ALTER TABLE public.sales_orders_exclusao_marca ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito: ninguém do app lê nem escreve aqui (o trigger é SECURITY DEFINER).
REVOKE ALL ON public.sales_orders_exclusao_marca FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sales_orders_exclusao_marca TO service_role;

CREATE OR REPLACE FUNCTION public.sales_orders_exclusao_marca_registrar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    -- Marca desfeita (o navegador, ou a recuperação — que já gravou 'recuperado' antes).
    UPDATE public.sales_orders_exclusao_marca
       SET desfecho = 'desfeito', resolvido_em = now()
     WHERE sales_order_id = NEW.id AND desfecho IS NULL;
  ELSIF OLD.deleted_at IS NULL THEN
    -- Só a marca do USUÁRIO entra: a do reconciliador do Omie (service_role) é baixa legítima.
    IF coalesce(auth.role(), '') = 'authenticated' THEN
      INSERT INTO public.sales_orders_exclusao_marca AS m (sales_order_id, carimbo, marcado_por, marcado_em, desfecho, resolvido_em)
      VALUES (NEW.id, NEW.deleted_at, auth.uid(), now(), NULL, NULL)
      ON CONFLICT (sales_order_id) DO UPDATE
        SET carimbo = EXCLUDED.carimbo, marcado_por = EXCLUDED.marcado_por, marcado_em = EXCLUDED.marcado_em,
            desfecho = NULL, resolvido_em = NULL;
    END IF;
  ELSE
    -- Re-carimbo de uma marca do usuário ainda em curso: a marca acompanha o carimbo novo.
    UPDATE public.sales_orders_exclusao_marca
       SET carimbo = NEW.deleted_at, marcado_em = now()
     WHERE sales_order_id = NEW.id AND desfecho IS NULL;
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.sales_orders_exclusao_marca_registrar() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sales_orders_exclusao_marca ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_exclusao_marca
  AFTER UPDATE OF deleted_at ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.sales_orders_exclusao_marca_registrar();

-- Desfaz a marca do usuário que ficou para trás: segue IGUAL depois de p_idade e o pedido existe.
-- 2 h: o lote do navegador marca tudo no início e chama a edge pedido a pedido (com consulta ao Omie);
-- um lote de centenas não pode reaparecer na lista dos outros enquanto ainda corre.
-- Ordem de lock = a do front (sales_orders → marca); SKIP LOCKED pula o pedido que a edge está
-- apagando agora. Devolve quantos pedidos voltaram DE FATO para a lista: o trigger durável do
-- reconciliador (PV excluído no Omie) pode manter o deleted_at — esse vira 'mantido', não conta.
CREATE OR REPLACE FUNCTION private.sales_orders_exclusao_recuperar(p_idade interval DEFAULT interval '2 hours')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ids    uuid[];
  v_voltou uuid[];
BEGIN
  IF p_idade IS NULL OR p_idade < interval '10 minutes' THEN
    RAISE EXCEPTION 'EXCLUSAO_RECUPERAR_PARAM: idade minima de 10 min (a edge pode estar no meio)' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(x.id) INTO v_ids FROM (
    SELECT so.id
      FROM public.sales_orders so
      JOIN public.sales_orders_exclusao_marca m ON m.sales_order_id = so.id
     WHERE m.desfecho IS NULL
       AND m.marcado_em < now() - p_idade
       AND so.deleted_at = m.carimbo
       FOR UPDATE OF so SKIP LOCKED
  ) x;
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;
  -- RETURNING devolve a linha DEPOIS dos BEFORE triggers: deleted_at ainda preenchido = a baixa manteve.
  WITH upd AS (
    UPDATE public.sales_orders so
       SET deleted_at = NULL
      FROM public.sales_orders_exclusao_marca m
     WHERE so.id = ANY (v_ids) AND m.sales_order_id = so.id AND so.deleted_at = m.carimbo
    RETURNING so.id, so.deleted_at
  )
  SELECT array_agg(id) FILTER (WHERE deleted_at IS NULL) INTO v_voltou FROM upd;
  -- O trigger já gravou 'desfeito' em quem voltou; o desfecho do servidor sobrescreve.
  UPDATE public.sales_orders_exclusao_marca
     SET desfecho = CASE WHEN sales_order_id = ANY (COALESCE(v_voltou, '{}'::uuid[])) THEN 'recuperado' ELSE 'mantido' END,
         resolvido_em = now()
   WHERE sales_order_id = ANY (v_ids) AND (desfecho IS NULL OR desfecho = 'desfeito');
  RETURN COALESCE(cardinality(v_voltou), 0);
END
$fn$;

COMMENT ON FUNCTION private.sales_orders_exclusao_recuperar(interval) IS
  'Recuperação server-side da exclusão de /sales (#19): devolve à lista o pedido cuja marca do USUÁRIO ficou para trás (aba fechada no meio do lote). Nunca toca deleted_at sem marca registrada (baixa do reconciliador do Omie).';

REVOKE ALL ON FUNCTION private.sales_orders_exclusao_recuperar(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.sales_orders_exclusao_recuperar(interval) TO service_role;

SELECT cron.unschedule('sales-orders-exclusao-recuperar')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sales-orders-exclusao-recuperar');
SELECT cron.schedule('sales-orders-exclusao-recuperar', '*/10 * * * *',
  $cron$ SELECT private.sales_orders_exclusao_recuperar(); $cron$);

-- PÓS ────────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_fn text;
  v_div bigint;
BEGIN
  -- view: corpo, security_invoker, ordem das colunas (só acrescenta no fim)
  IF (SELECT md5(pg_catalog.pg_get_viewdef('public.order_feed'::regclass, true))) IS DISTINCT FROM '7f74d95f5205b25fa9e35c64f20bb44e' THEN
    RAISE EXCEPTION 'POS_FALHOU: order_feed não ficou com o corpo desta migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
    WHERE c.oid = 'public.order_feed'::regclass AND o IN ('security_invoker=true', 'security_invoker=on')
  ) THEN
    RAISE EXCEPTION 'POS_FALHOU: order_feed perdeu security_invoker — leria como OWNER e furaria a RLS';
  END IF;
  IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.order_feed'::regclass AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM 'origin,id,created_at,account,order_number,omie_pedido_id,customer_user_id,customer_name,item_names,item_quantity,status,subtotal,total,busca,origem_omie' THEN
    RAISE EXCEPTION 'POS_FALHOU: colunas de order_feed fora da ordem (origem_omie é a 15ª, busca a 14ª)';
  END IF;
  -- busca_base gerada e legível pela view
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.sales_orders'::regclass AND attname = 'busca_base'
                   AND attgenerated = 's' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POS_FALHOU: sales_orders.busca_base não é coluna gerada STORED';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'busca_base', 'SELECT') THEN
    RAISE EXCEPTION 'POS_FALHOU: authenticated não lê sales_orders.busca_base — toda leitura de /sales daria 42501';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'vendedor_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS_FALHOU: authenticated lê sales_orders.vendedor_user_id direto — o fecho por coluna é de propósito';
  END IF;
  -- #35 paridade: a busca nova = a expressão antiga, linha a linha, em TODOS os pedidos vivos.
  SELECT count(*) INTO v_div
    FROM public.order_feed f
    JOIN public.sales_orders so ON so.id = f.id AND f.origin = 'sales'
    LEFT JOIN public.profiles p ON p.user_id = so.customer_user_id
   WHERE f.busca IS DISTINCT FROM translate(lower(
    COALESCE(replace(replace(replace(replace(replace(p.name,
      '&amp;', '&'), '&apos;', ''''), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '')
    || E'\n' || COALESCE(so.omie_numero_pedido, '')
    || E'\n' || CASE WHEN jsonb_typeof(so.items) = 'array' THEN COALESCE((
         SELECT string_agg(NULLIF(t.elem->>'descricao', ''), ' ' ORDER BY t.ord)
         FROM jsonb_array_elements(so.items) WITH ORDINALITY AS t(elem, ord)
       ), '') ELSE '' END
    || E'\n' || round(COALESCE(so.total, 0), 2)::text
    || E'\n' || replace(round(COALESCE(so.total, 0), 2)::text, '.', ',')
  ), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
    'aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny');
  IF v_div <> 0 THEN
    RAISE EXCEPTION 'POS_FALHOU: % pedidos com busca diferente da expressão antiga', v_div;
  END IF;
  -- #31 assinatura nova e ACL (anon fora nas DUAS pontas; authenticated dentro); a velha sumiu
  IF to_regprocedure('public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POS_FALHOU: order_feed_total de 7 argumentos ainda existe (chamada ambígua no PostgREST)';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid, timestamptz, timestamptz[])',
    'public.order_feed_do_vendedor(uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_FALHOU: ACL de % (anon fora, authenticated dentro)', v_fn;
    END IF;
  END LOOP;
  IF (SELECT prosecdef FROM pg_catalog.pg_proc
      WHERE oid = 'public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid, timestamptz, timestamptz[])'::regprocedure) THEN
    RAISE EXCEPTION 'POS_FALHOU: order_feed_total virou SECURITY DEFINER — furaria a RLS';
  END IF;
  -- #19 marca, trigger, recuperação e cron
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.sales_orders_exclusao_marca'::regclass) THEN
    RAISE EXCEPTION 'POS_FALHOU: sales_orders_exclusao_marca sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.sales_orders_exclusao_marca', 'SELECT')
     OR has_table_privilege('anon', 'public.sales_orders_exclusao_marca', 'SELECT') THEN
    RAISE EXCEPTION 'POS_FALHOU: sales_orders_exclusao_marca legível pelo app';
  END IF;
  -- Forma, não só existência (CREATE TABLE IF NOT EXISTS não corrige um rascunho colado antes):
  -- sem CASCADE o DELETE da edge daria 23503 em todo pedido marcado.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.sales_orders_exclusao_marca'::regclass AND contype = 'f'
                   AND confrelid = 'public.sales_orders'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POS_FALHOU: a marca não apaga junto com o pedido (FK sem ON DELETE CASCADE) — a exclusão da edge daria 23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.sales_orders_exclusao_marca'::regclass AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%mantido%') THEN
    RAISE EXCEPTION 'POS_FALHOU: o CHECK de desfecho não aceita mantido (tabela de um rascunho anterior)';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.sales_orders'::regclass AND t.tgname = 'trg_sales_orders_exclusao_marca' AND t.tgenabled = 'O')
     NOT LIKE 'CREATE TRIGGER trg_sales_orders_exclusao_marca AFTER UPDATE OF deleted_at ON public.sales_orders FOR EACH ROW WHEN ((old.deleted_at IS DISTINCT FROM new.deleted_at)) EXECUTE FUNCTION %sales_orders_exclusao_marca_registrar()'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                    WHERE tgrelid = 'public.sales_orders'::regclass AND tgname = 'trg_sales_orders_exclusao_marca' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POS_FALHOU: trigger trg_sales_orders_exclusao_marca ausente, desligado ou com outra forma';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = 'private.sales_orders_exclusao_recuperar(interval)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = 'public.sales_orders_exclusao_marca_registrar()'::regprocedure) THEN
    RAISE EXCEPTION 'POS_FALHOU: recuperação/registro da marca sem SECURITY DEFINER (o app não escreve a marca)';
  END IF;
  IF has_function_privilege('anon', 'private.sales_orders_exclusao_recuperar(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.sales_orders_exclusao_recuperar(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS_FALHOU: a recuperação da exclusão é executável pelo app';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'sales-orders-exclusao-recuperar' AND schedule = '*/10 * * * *' AND active) <> 1 THEN
    RAISE EXCEPTION 'POS_FALHOU: cron sales-orders-exclusao-recuperar ausente, duplicado ou inativo';
  END IF;
END
$pos$;

NOTIFY pgrst, 'reload schema';

COMMIT;
