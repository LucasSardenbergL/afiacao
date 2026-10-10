-- valida-motor-desconta-comprometido.sql — a 2ª testemunha da 20261010210000, READ-ONLY.
-- Rodar:  ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/valida-motor-desconta-comprometido.sql; echo $?
-- Bloco 1: o que a migration instalou (cada linha tem de sair ✅). Bloco 2: o efeito no ÚLTIMO ciclo do motor —
-- os itens com desconto e os 4 SKUs que motivaram a entrega, com o comprometido de AGORA ao lado.

\echo '── 1. instalação'
SELECT CASE WHEN md5(p.prosrc) = '4187116fdf4284f79d416249d3f35335' THEN '✅' ELSE '❌' END AS ok,
       'motor = corpo da 20261010210000' AS item, md5(p.prosrc) AS valor
  FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)')
UNION ALL
SELECT CASE WHEN count(*) = 1 THEN '✅' ELSE '❌' END, 'pedido_compra_item.estoque_comprometido numeric nullable', count(*)::text
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = 'public.pedido_compra_item'::regclass AND a.attname = 'estoque_comprometido'
   AND NOT a.attisdropped AND a.atttypid = 'numeric'::regtype AND NOT a.attnotnull
UNION ALL
SELECT CASE WHEN has_column_privilege('authenticated', 'public.sales_orders', 'omie_reconciliado_em', 'SELECT')
             AND NOT has_table_privilege('authenticated', 'public.sales_orders', 'SELECT')
             AND NOT has_column_privilege('authenticated', 'public.sales_orders', 'omie_payload', 'SELECT')
            THEN '✅' ELSE '❌' END,
       'staff lê omie_reconciliado_em; SELECT de tabela e omie_payload seguem fechados', NULL
UNION ALL
SELECT CASE WHEN p.provolatile = 'v' AND NOT p.prosecdef
             AND array_to_string(p.proconfig, ';') = 'search_path=public, pg_temp;statement_timeout=120s' THEN '✅' ELSE '❌' END,
       'motor segue VOLATILE, INVOKER, config intacta', array_to_string(p.proconfig, ';')
  FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)');

-- A tabela acima é para o OLHO; o veredito é este bloco. Função ausente não vira "zero linhas e dois ✅"
-- (Codex, adversarial 2026-10-10): cada condição é exigida nominalmente e a falha ABORTA (ON_ERROR_STOP → exit ≠ 0,
-- sem o marcador de fim).
DO $v$
DECLARE
  v_oid oid := to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)');
  v_falhas text[] := '{}';
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VALIDA FALHOU: gerar_pedidos_sugeridos_ciclo(text, date) não existe';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM '4187116fdf4284f79d416249d3f35335' THEN
    v_falhas := v_falhas || 'corpo'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid AND p.provolatile = 'v' AND NOT p.prosecdef
                   AND array_to_string(p.proconfig, ';') = 'search_path=public, pg_temp;statement_timeout=120s') THEN
    v_falhas := v_falhas || 'atributos'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = 'public.pedido_compra_item'::regclass AND a.attname = 'estoque_comprometido'
                    AND NOT a.attisdropped AND a.atttypid = 'numeric'::regtype AND NOT a.attnotnull) THEN
    v_falhas := v_falhas || 'coluna'::text;
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'omie_reconciliado_em', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_orders', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sales_orders', 'omie_payload', 'SELECT') THEN
    v_falhas := v_falhas || 'grant'::text;
  END IF;
  IF cardinality(v_falhas) > 0 THEN
    RAISE EXCEPTION 'VALIDA FALHOU: %', array_to_string(v_falhas, ', ');
  END IF;
  RAISE NOTICE 'VALIDA_INSTALACAO_OK: 4 de 4 (corpo, atributos, coluna, grant)';
END
$v$;

\echo '── 2. último ciclo do motor (OBEN)'
SELECT r.run_id, r.data_ciclo, r.pedidos_gerados, r.skus_incluidos, r.suprimidos_n, r.capados_n
  FROM public.reposicao_motor_run r WHERE r.empresa = 'OBEN' ORDER BY r.criado_em DESC LIMIT 1;

-- Itens pendentes do ciclo mais recente: quantos receberam o desconto (> 0), quantos o calcularam (= 0) e
-- quantos não o têm (NULL = grupo, desligado, ou gerado ANTES do apply).
SELECT count(*) FILTER (WHERE i.estoque_comprometido > 0)  AS com_desconto,
       count(*) FILTER (WHERE i.estoque_comprometido = 0)  AS sem_vendido_aberto,
       count(*) FILTER (WHERE i.estoque_comprometido IS NULL) AS nao_se_aplica,
       max(p.criado_em) AS gerado_em
  FROM public.pedido_compra_item i JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
 WHERE p.empresa = 'OBEN' AND p.status = 'pendente_aprovacao' AND COALESCE(p.tipo_ciclo, 'normal') = 'normal'
   AND p.data_ciclo = (SELECT max(data_ciclo) FROM public.pedido_compra_sugerido WHERE empresa = 'OBEN');

-- Os 4 SKUs do briefing: o comprometido AGORA (mesmos filtros do motor) × o que o último ciclo gravou.
WITH alvo(sku) AS (VALUES ('8689733257'), ('11979470842'), ('12017010823'), ('12034226322')),
comp AS (
  SELECT x.sku, sum(x.q) AS qtde
    FROM (SELECT it->>'omie_codigo_produto' AS sku,
                 CASE WHEN jsonb_typeof(it->'quantidade') = 'number' THEN (it->>'quantidade')::numeric END AS q
            FROM public.sales_orders so
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END) it
           WHERE so.account = 'oben' AND so.deleted_at IS NULL AND so.hash_payload LIKE 'omie\_%'
             AND so.status IN ('importado', 'separacao', 'enviado')
             AND so.omie_reconciliado_em > now() - interval '36 hours'
             AND so.omie_numero_pedido IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.sales_orders s2
                              WHERE s2.account = so.account AND s2.omie_numero_pedido = so.omie_numero_pedido
                                AND s2.hash_payload LIKE 'omie\_%' AND s2.id <> so.id)) x
   WHERE x.q > 0 AND x.q < 1e9 GROUP BY 1)
SELECT a.sku, left(sp.sku_descricao, 26) AS descricao, sp.ponto_pedido AS pp, sp.estoque_maximo AS max,
       sea.estoque_fisico AS fisico, sea.estoque_pendente_entrada AS pendente, c.qtde AS comprometido_agora,
       ult.estoque_atual AS efetivo_gravado, ult.estoque_comprometido AS comprometido_gravado,
       ult.qtde_final, ult.status
  FROM alvo a
  LEFT JOIN public.sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie::text = a.sku
  LEFT JOIN public.sku_estoque_atual sea ON sea.empresa = 'OBEN' AND sea.sku_codigo_omie = a.sku
  LEFT JOIN comp c ON c.sku = a.sku
  LEFT JOIN LATERAL (
    SELECT i.estoque_atual, i.estoque_comprometido, i.qtde_final, p.status
      FROM public.pedido_compra_item i JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
     WHERE p.empresa = 'OBEN' AND i.sku_codigo_omie = a.sku
     ORDER BY p.criado_em DESC LIMIT 1) ult ON true
 ORDER BY a.sku;

\echo 'FIM_VALIDA_OK'
