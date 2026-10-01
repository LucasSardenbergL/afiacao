-- 20261001014220_universo_pedidos_proposta_whatsapp.sql
-- ============================================================
-- Proposta de WhatsApp (get_whatsapp_proposta_cotacao): o preço "praticado" que vai ao CLIENTE passa a
-- vir só do universo de pedidos CANÔNICO. A data (a cronologia comercial do item) NÃO muda.
-- ============================================================
-- A classe e a autoridade: ver o cabeçalho de 20261001014000_universo_pedidos_caca.sql e
-- docs/historico/universo-pedidos-classe-sql.md. Irmã da 20261001014210 (as outras 6 de preço); vai
-- SOZINHA porque a prova do canal (db/test-whatsapp-proposta.sh) monta o corpo vivo desta função pela
-- cadeia de migrations que a redefinem (db/lib/corpo-vivo.sh) — com as 6 juntas, a PRE de md5 exato
-- abortava na régua, que naquela cadeia está no corpo anterior ao 20260929001651.
--
-- Antes (prod, 2026-10-01): a CTE praticado (último unit_price válido do cliente, por SKU, na conta
-- consultada) não filtrava status NEM deleted_at — o comentário dela dizia "praticado VÁLIDO". Efeito
-- medido na prod (psql-ro, 2026-10-01 01:00 UTC): em 14 de 24.093 (cliente, conta, sku) o último preço
-- vinha de pedido CANCELADO; 11 mudam e, em 5, a proposta cai para o preço de tabela ou `sem_preco`
-- (ausente ≠ zero). Decisão do founder (2026-10-01): universo canônico.
--
-- Conserto: a ÚNICA mudança no corpo é `AND so.status NOT IN (…) AND so.deleted_at IS NULL` na CTE
-- praticado. O resto é o texto VIVO da prod (pg_get_functiondef, 2026-10-01), por troca exata com
-- contagem conferida — mesma assinatura, retorno, volatilidade (STABLE), SECURITY INVOKER, search_path,
-- dono e ACL. Trava (ALTER FUNCTION … STABLE) → PRE (md5 EXATO do prosrc vivo; aceita este corpo) →
-- replace → POS (semântica → md5 → retrato igual).
-- Aplicação: `bun run db:aplicar <este arquivo> --ensaio`, depois sem --ensaio. Provas:
-- db/test-universo-pedidos-classe.sh (bloco U) e db/test-whatsapp-proposta.sh (pela cadeia viva).

ALTER FUNCTION public.get_whatsapp_proposta_cotacao(uuid,text,bigint[]) STABLE;

-- retrato de antes: tabela temporária de SESSÃO (não ON COMMIT DROP) — a cadeia viva de db/lib/corpo-vivo.sh
-- aplica em autocommit; o DROP explícito no fim limpa nos três modos de execução.
CREATE TEMP TABLE IF NOT EXISTS universo_retrato (alvo text PRIMARY KEY, config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.universo_retrato;

DO $pre$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])', 'd73ff1824d15ec00b9e0c85091b9e3e7', 'bda0102ab47ca37b0ee126f5028233c8')
    ) AS x(alvo, predecessor, este)
  LOOP
    IF to_regprocedure(r.alvo) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — esta migration exige o predecessor medido na prod', r.alvo;
    END IF;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_md5 IS DISTINCT FROM r.predecessor AND v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE: % deriva — md5(prosrc)=% não é o predecessor (%) nem este corpo (%)', r.alvo, v_md5, r.predecessor, r.este;
    END IF;
    INSERT INTO pg_temp.universo_retrato
      SELECT r.alvo, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'), coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
        FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
  END LOOP;
END $pre$;

-- public.get_whatsapp_proposta_cotacao
CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(p_customer_user_id uuid, p_account text, p_skus bigint[])
 RETURNS TABLE(omie_codigo_produto bigint, product_id uuid, codigo text, descricao text, unidade text, ativo boolean, estoque numeric, preco numeric, fonte_preco text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH praticado AS (
    -- último preço praticado VÁLIDO do próprio cliente NA CONTA consultada, por SKU
    -- (cronologia comercial: item → pedido pai; tie-break estável por id)
    SELECT DISTINCT ON (oi.omie_codigo_produto)
           oi.omie_codigo_produto, oi.unit_price
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE oi.customer_user_id = p_customer_user_id
       AND so.account = p_account
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND so.deleted_at IS NULL
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
$function$;

DO $pos$
DECLARE r record; v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])', 'bda0102ab47ca37b0ee126f5028233c8')
    ) AS x(alvo, este)
  LOOP
    SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      INTO v_src, v_cfg, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_src IS NULL THEN RAISE EXCEPTION 'POS: % sumiu', r.alvo; END IF;
    -- semântica primeiro (diz O QUE está errado); o md5 depois (só diz QUE está)
    IF position($q$so.status NOT IN ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0
       AND position($q$so.status not in ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS: % sem a denylist canônica dos 4 no alias so', r.alvo;
    END IF;
    IF v_src ~* 'so\.deleted_at\s+is\s+null' IS NOT TRUE THEN
      RAISE EXCEPTION 'POS: % sem so.deleted_at IS NULL', r.alvo;
    END IF;
    IF v_src ~* $re$(is distinct from 'cancelado'|coalesce\(so\.status|status in \('faturado')$re$ THEN
      RAISE EXCEPTION 'POS: % ainda carrega a forma antiga do universo', r.alvo;
    END IF;
    IF md5(v_src) IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS: % md5(prosrc)=% não é o corpo desta migration (%)', r.alvo, md5(v_src), r.este;
    END IF;
    SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = r.alvo;
    IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'POS: % mudou config/ACL — antes [%|%], depois [%|%]', r.alvo, v_ret.config, v_ret.acl, v_cfg, v_acl;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.universo_retrato;
