-- ============================================================
-- APLICAÇÃO via `bun run db:aplicar` — cockpit_itens_snapshot passa a transportar desconto_valor
--
-- Mesmo EFEITO da migration `20260908222500_snapshot_transporta_desconto_valor.sql`,
-- SEM o envelope `BEGIN;`/`COMMIT;`: a transação é do `db:aplicar`, que executa o corpo
-- via `aplicar_sql()` — e lá comandos de transação são proibidos. Os dois caminhos
-- coexistem de propósito (#2434): a migration com envelope é a que se cola no SQL Editor.
--
-- NÃO desenvelopar no cliente: `aplicar_sql()` recalcula o sha256 do corpo recebido e o
-- compara com o declarado. Qualquer transformação na hora do envio quebra a cadeia que
-- prova que o executado é byte a byte o que está no repo. Daí este arquivo ser COMMITADO.
--
-- Idempotente: só `CREATE OR REPLACE`. A postcondição confere o ESTADO final, não o
-- caminho — reaplicar é seguro e dá o mesmo veredito.
-- ============================================================

-- ============================================================
-- cockpit_itens_snapshot transporta desconto_valor
--
-- O `fin-valor-cockpit` NÃO lê `order_items` direto: ele chama esta RPC, que monta o universo num
-- jsonb com campos EXPLÍCITOS. Preencher a coluna e trocar a fórmula na edge não bastaria — sem
-- este transporte a edge receberia `undefined` em toda linha e recusaria o universo inteiro.
--
-- ADITIVO: `discount` continua no payload. Os sete consumidores da coluna legado migram um a um,
-- e remover o campo antigo aqui os quebraria todos de uma vez.
--
-- NULL ATRAVESSA COMO NULL. É a única razão de a coluna existir: distinguir "não apurado" de "o
-- Omie informou que não há desconto". Um `coalesce(..., 0)` aqui desfaria a cadeia inteira em
-- silêncio — a régua degradaria para receita cheia, idêntica ao caso legítimo.
--
-- Gerada de `pg_get_functiondef` da PRODUÇÃO (psql-ro, 2026-09-08), não do repo.
-- ============================================================


CREATE OR REPLACE FUNCTION public.cockpit_itens_snapshot(p_created_at_de timestamp with time zone, p_teto_linhas integer DEFAULT 150000, p_teto_bytes bigint DEFAULT 25165824)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_max_linhas constant integer := 500000;
  c_max_bytes  constant bigint  := 33554432;
  v_teto_linhas integer := least(coalesce(p_teto_linhas, 0), c_max_linhas);
  v_teto_bytes  bigint  := least(coalesce(p_teto_bytes, 0), c_max_bytes);
  v_itens jsonb;
  v_bytes bigint;
BEGIN
  -- Sem prefiltro de carga a leitura viraria a tabela INTEIRA (70.531 linhas contra 14.628 na
  -- janela medida) — degradar para "tudo" é o oposto de fail-closed.
  IF p_created_at_de IS NULL THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: `p_created_at_de` ausente — sem o prefiltro de carga a leitura viraria a tabela inteira'
      USING ERRCODE = '22023';
  END IF;
  IF v_teto_linhas <= 0 OR v_teto_bytes <= 0 THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: teto inválido (linhas=%, bytes=%)', v_teto_linhas, v_teto_bytes
      USING ERRCODE = '22023';
  END IF;

  -- ═══ A ÚNICA QUERY QUE TOCA AS TABELAS ═══════════════════════════════════════════════════
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'customer_user_id',    t.customer_user_id,
               'product_id',          t.product_id,
               'omie_codigo_produto', t.omie_codigo_produto,
               'quantity',            t.quantity,
               'unit_price',          t.unit_price,
               'discount',            t.discount,
               -- O desconto CANÔNICO (R$ da linha). `discount` acima é a coluna LEGADO, e as
               -- duas viajam juntas de propósito: os consumidores migram um a um, e quem ainda
               -- não migrou continua lendo o campo antigo em vez de receber `undefined`.
               -- NULL aqui é NÃO APURADO e chega ao consumidor COMO null — o jsonb preserva a
               -- distinção que a coluna existe para carregar. Um `coalesce(...,0)` neste ponto
               -- desfaria em silêncio toda a cadeia: a linha chegaria ao cockpit afirmando
               -- "sem desconto", e a receita voltaria cheia.
               'desconto_valor',      t.desconto_valor,
               'sales_order_id',      t.sales_order_id,
               'sales_orders', jsonb_build_object(
                 'status',         t.status,
                 'deleted_at',     t.deleted_at,
                 'order_date_kpi', t.order_date_kpi,
                 'account',        t.account,
                 'origem',         t.origem,
                 'checkout_id',    t.checkout_id
               )
             )
             ORDER BY t.id
           ),
           '[]'::jsonb
         )
    INTO v_itens
  FROM (
    SELECT oi.id, oi.customer_user_id, oi.product_id, oi.omie_codigo_produto, oi.quantity,
           oi.unit_price, oi.discount, oi.desconto_valor, oi.sales_order_id,
           so.status, so.deleted_at, so.order_date_kpi, so.account, so.origem, so.checkout_id
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    WHERE oi.created_at >= p_created_at_de
    ORDER BY oi.id
    LIMIT v_teto_linhas + 1
  ) t;
  -- ═════════════════════════════════════════════════════════════════════════════════════════

  IF jsonb_array_length(v_itens) > v_teto_linhas THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: universo excede o teto de % linhas — aumente o teto DEPOIS de conferir o heap da edge, ou estreite a janela de carga', v_teto_linhas
      USING ERRCODE = '54000';
  END IF;
  v_bytes := octet_length(v_itens::text);
  IF v_bytes > v_teto_bytes THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: universo com % bytes excede o teto de % bytes — aumente o teto DEPOIS de conferir o heap da edge, ou estreite a janela de carga', v_bytes, v_teto_bytes
      USING ERRCODE = '54000';
  END IF;

  RETURN jsonb_build_object(
    'total',       jsonb_array_length(v_itens),
    'bytes_itens', v_bytes,
    'itens',       v_itens
  );
END;
$function$

;

DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cockpit_itens_snapshot';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FALHOU: cockpit_itens_snapshot não existe — a migration não pegou.';
  END IF;
  IF position('desconto_valor' in v_def) = 0 THEN
    RAISE EXCEPTION 'FALHOU: o snapshot não transporta desconto_valor — o cockpit receberia undefined em toda linha.';
  END IF;
  -- Aditivo de verdade: perder `discount` aqui quebraria os consumidores que ainda não migraram.
  IF position('''discount''' in v_def) = 0 THEN
    RAISE EXCEPTION 'FALHOU: o snapshot perdeu o campo legado discount — a migração dos consumidores tem de ser um a um.';
  END IF;
  IF v_def ~* 'coalesce[^\n]*desconto_valor[^\n]*,\s*0\s*\)' THEN
    RAISE EXCEPTION 'FALHOU: coalesce(desconto_valor, 0) no snapshot — a distinção "não apurado" morre aqui e a receita volta cheia.';
  END IF;

  RAISE NOTICE 'OK: cockpit_itens_snapshot transporta desconto_valor E discount, sem coalesce.';
END
$post$;

