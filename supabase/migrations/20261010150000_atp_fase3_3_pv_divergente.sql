-- ============================================================
-- ATP/reserva de estoque — FASE 3.3: a reserva acompanha o PV que JÁ existia
-- no Omie quando o envio é reconciliado por duplicidade [money-path]
-- Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
-- Depende da 3.1 (20261009120000) e da 3.2 (20261009233000), APLICADAS em prod.
-- Pré-flight 2026-10-10 (psql-ro): atp_confirmar_pv vivo = corpo da 3.1
-- (md5 corpo+atributos 50606bbb…); 1 reserva em prod (expirada); 0 envios
-- reconciliados por duplicidade.
--
--  #1 (Codex retroativo da 3.1) — o envio falha DEPOIS de o PV nascer no Omie
--     (write-back perdido), o vendedor ALTERA o carrinho e reenvia. A chave
--     determinística PV_<sales_order_id> faz o Omie recusar por duplicidade, a
--     edge consulta e VINCULA o PV antigo — que tem os itens da tentativa
--     anterior —, enquanto o gate já reservou o carrinho NOVO. A reserva firmava
--     quantidade ≠ do pedido que vai ser faturado.
--     ⇒ No caminho reconciliado (p_omie_response.reconciled = true) a RPC lê os
--     itens do PV na PRÓPRIA resposta do Omie (o fato, não o carrinho) e, na
--     MESMA transação do write-back, ajusta as reservas ativas do pedido ao PV:
--     quantidade diferente → passa a do PV; SKU fora do PV → 'liberada'; SKU do
--     PV sem reserva → reserva nova (nasce sem par e é carimbada logo abaixo,
--     pelo único writer do par). O ajuste fica na trilha (atp_decisoes,
--     contexto 'reconciliacao') e volta à edge como pv_divergente, que avisa o
--     vendedor. Itens ilegíveis ⇒ NADA é ajustado (precisão > recall: não se
--     fabrica reserva de leitura duvidosa) e a resposta diz pv_itens_legiveis
--     = false.
--  #3 é fechado na EDGE (omie-vendas-sync v1.14): a exclusão de pedido Oben sem
--     PID que passou pelo gate consulta o Omie pela chave PV_<id> e cancela o PV
--     órfão antes de apagar — a própria chave de integração é o registro durável
--     do envio. Nada a mudar no banco.
--
-- Assinatura INALTERADA (CREATE OR REPLACE preserva OID e ACL): a edge v1.13 já
-- em produção passa a ajustar a reserva no primeiro apply, sem deploy — só não
-- avisa o vendedor (isso é a v1.14).
--
-- No SQL Editor/MCP: entre BEGIN; … COMMIT;. Pelo db:aplicar: sem envelope.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0) TRAVA → PRE. md5 de corpo+atributos ∈ {3.1 medido em prod, este}.
--    A trava reaplica a volatilidade VIVA (lição P2 do Codex da 3.2).
-- ────────────────────────────────────────────────────────────
DO $trava$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS alvo, p.provolatile
      FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')
  LOOP
    EXECUTE format('ALTER FUNCTION %s %s', f.alvo,
                   CASE f.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END);
  END LOOP;
END
$trava$;

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(p.prosrc || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || COALESCE(p.proconfig::text, ''))
              FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)', '50606bbb21341e9d53e6b058207c24e9', '54630f915185b953d60dac40c7298dc8')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 corpo+atributos %) não é o da 3.1 nem o desta migration — alguém o recriou depois do pré-voo de 2026-10-10; NÃO sobrescrever sem revisar', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ────────────────────────────────────────────────────────────
-- 1) #1 — atp_confirmar_pv ajusta a reserva ao PV reconciliado.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_confirmar_pv(
  p_sales_order_id uuid,
  p_account text,
  p_omie_pedido_id bigint,
  p_omie_numero_pedido text,
  p_omie_payload jsonb,
  p_omie_response jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ck uuid;
  v_lock record;
  v_n_so integer;
  v_n_res integer;
  v_reconciliado boolean := COALESCE(p_omie_response->>'reconciled', '') = 'true';
  v_det jsonb;
  v_pv jsonb;            -- {sku: quantidade} do PV no Omie, agregado por SKU
  v_legivel boolean;     -- NULL = não se aplica (envio normal ou conta sem reserva)
  v_cks uuid[];
  v_expira timestamptz;
  v_aj record;
  v_ajustes jsonb := '[]'::jsonb;
BEGIN
  -- Defesa em profundidade: o EXECUTE já é só de service_role (REVOKE da 3.1).
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'atp_confirmar_pv é exclusiva do edge (service_role)'
      USING ERRCODE = '42501';
  END IF;
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'p_sales_order_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_account IS NULL OR btrim(p_account) = '' THEN
    RAISE EXCEPTION 'p_account é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_omie_pedido_id IS NULL OR p_omie_pedido_id <= 0 THEN
    RAISE EXCEPTION 'p_omie_pedido_id inválido: %', p_omie_pedido_id USING ERRCODE = '22023';
  END IF;

  -- Itens do PV reconciliado, lidos da resposta do ConsultarPedido. Só o pool
  -- oben reserva. Qualquer item fora do formato (código não inteiro positivo,
  -- quantidade não numérica ou ≤ 0, soma fora do domínio da reserva) torna a
  -- leitura INTEIRA ilegível: ajustar metade seria fabricar reserva.
  IF v_reconciliado AND p_account = 'oben' THEN
    v_det := COALESCE(p_omie_response #> '{consulta,pedido_venda_produto,det}',
                      p_omie_response #> '{consulta,det}');
    -- CASE (não AND): jsonb_array_length/jsonb_array_elements LANÇAM sobre
    -- não-array, e um erro aqui desfaria o write-back de um PV que existe.
    v_legivel := CASE
      WHEN COALESCE(jsonb_typeof(v_det), '') <> 'array' THEN false
      WHEN jsonb_array_length(v_det) = 0 THEN false
      ELSE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_det) e
         WHERE NOT (
           CASE WHEN COALESCE(e #>> '{produto,codigo_produto}', '') !~ '^[0-9]{1,18}$' THEN false
                WHEN jsonb_typeof(e #> '{produto,quantidade}') IS DISTINCT FROM 'number' THEN false
                ELSE (e #>> '{produto,quantidade}')::numeric > 0 END))
    END;
    IF v_legivel THEN
      SELECT jsonb_object_agg(s.sku::text, s.qtd),
             COALESCE(bool_and(s.sku > 0 AND s.qtd > 0 AND s.qtd <= 1000000), false)
        INTO v_pv, v_legivel
        FROM (SELECT (e #>> '{produto,codigo_produto}')::bigint AS sku,
                     sum((e #>> '{produto,quantidade}')::numeric) AS qtd
                FROM jsonb_array_elements(v_det) e
               GROUP BY 1) s;
    END IF;
    IF NOT v_legivel THEN
      v_pv := NULL;
    END IF;
  END IF;

  -- O ajuste só existe sobre reserva viva do pedido, num checkout só (o índice
  -- único da reserva é por checkout; dois checkouts no mesmo pedido = estado
  -- que nenhum writer produz, e então não se ajusta nada).
  SELECT array_agg(DISTINCT r.checkout_id ORDER BY r.checkout_id), max(r.expira_em)
    INTO v_cks, v_expira
    FROM public.estoque_reservas r
   WHERE r.sales_order_id = p_sales_order_id AND r.status = 'ativa';
  IF v_pv IS NOT NULL AND COALESCE(array_length(v_cks, 1), 0) <> 1 THEN
    v_pv := NULL;
  END IF;

  -- Serialização com reservar_estoque, na MESMA ordem global dele: checkout(s)
  -- primeiro, depois SKUs em ordem crescente, mesmo namespace. O conjunto de
  -- SKUs inclui os do PV: o ajuste pode CRIAR reserva de SKU que o pedido não
  -- tinha.
  FOREACH v_ck IN ARRAY COALESCE(v_cks, '{}'::uuid[])
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:checkout:' || v_ck::text, 0));
  END LOOP;
  FOR v_lock IN
    SELECT DISTINCT x.pool, x.sku
      FROM (SELECT r.pool, r.omie_codigo_produto AS sku
              FROM public.estoque_reservas r
             WHERE r.sales_order_id = p_sales_order_id AND r.status = 'ativa'
            UNION
            SELECT 'oben', k::bigint
              FROM jsonb_object_keys(COALESCE(v_pv, '{}'::jsonb)) k) x
     ORDER BY x.sku, x.pool
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:sku:' || v_lock.pool || ':' || v_lock.sku::text, 0));
  END LOOP;

  UPDATE public.sales_orders
     SET omie_pedido_id = p_omie_pedido_id,
         omie_numero_pedido = p_omie_numero_pedido,
         omie_payload = p_omie_payload,
         omie_response = p_omie_response,
         status = 'enviado'
   WHERE id = p_sales_order_id
     AND account = p_account;
  GET DIAGNOSTICS v_n_so = ROW_COUNT;
  IF v_n_so <> 1 THEN
    RAISE EXCEPTION 'write-back do PV % não casou exatamente 1 linha (id=%, account=%)',
      p_omie_pedido_id, p_sales_order_id, p_account
      USING ERRCODE = 'P0002';
  END IF;

  -- #1: a reserva passa a ser a do PV. ANTES do carimbo: a reserva criada
  -- aqui nasce sem par (o trigger write-once exige) e é carimbada abaixo.
  IF v_pv IS NOT NULL THEN
    FOR v_aj IN
      SELECT COALESCE(r.sku, p.sku) AS sku, r.id, r.quantidade AS antes, p.qtd AS depois
        FROM (SELECT er.id, er.omie_codigo_produto AS sku, er.quantidade
                FROM public.estoque_reservas er
               WHERE er.sales_order_id = p_sales_order_id AND er.status = 'ativa'
                 AND er.pool = 'oben') r
        FULL JOIN (SELECT k::bigint AS sku, (v_pv ->> k)::numeric AS qtd
                     FROM jsonb_object_keys(v_pv) k) p ON p.sku = r.sku
       WHERE r.quantidade IS DISTINCT FROM p.qtd
       ORDER BY 1
    LOOP
      IF v_aj.id IS NULL THEN
        INSERT INTO public.estoque_reservas
          (pool, omie_codigo_produto, quantidade, checkout_id, sales_order_id,
           status, expira_em, motivo)
        VALUES
          ('oben', v_aj.sku, v_aj.depois, v_cks[1], p_sales_order_id,
           'ativa', v_expira, 'pv_divergente: item do PV no Omie sem reserva');
      ELSIF v_aj.depois IS NULL THEN
        UPDATE public.estoque_reservas
           SET status = 'liberada',
               motivo = 'pv_divergente: SKU fora do PV no Omie',
               atualizado_em = now()
         WHERE id = v_aj.id;
      ELSE
        UPDATE public.estoque_reservas
           SET quantidade = v_aj.depois,
               atualizado_em = now()
         WHERE id = v_aj.id;
      END IF;
      v_ajustes := v_ajustes || jsonb_build_object(
        'sku', v_aj.sku, 'antes', COALESCE(v_aj.antes, 0), 'depois', COALESCE(v_aj.depois, 0));
    END LOOP;
  END IF;

  -- Carimba SÓ as ativas: reserva já encerrada (expirada/liberada/consumida)
  -- continua encerrada — o cálculo exige 'ativa' e a fase 3 já travou que
  -- expirada não ressuscita (assert A5). O trigger write-once barra PID trocado.
  UPDATE public.estoque_reservas r
     SET omie_pedido_id = p_omie_pedido_id,
         omie_account = p_account,
         atualizado_em = now()
   WHERE r.sales_order_id = p_sales_order_id
     AND r.status = 'ativa';
  GET DIAGNOSTICS v_n_res = ROW_COUNT;

  IF jsonb_array_length(v_ajustes) > 0 THEN
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, atp_snapshot)
    VALUES
      (p_sales_order_id, v_cks[1], 'oben', p_account, 'reservado', 'reconciliacao', true,
       jsonb_build_object('pv_divergente', true,
                          'omie_pedido_id', p_omie_pedido_id,
                          'ajustes', v_ajustes));
  END IF;

  RETURN jsonb_build_object('ok', true,
                            'sales_order_id', p_sales_order_id,
                            'omie_pedido_id', p_omie_pedido_id,
                            'reservas_firmadas', v_n_res,
                            'pv_itens_legiveis', v_legivel,
                            'pv_divergente', jsonb_array_length(v_ajustes) > 0,
                            'ajustes', v_ajustes);
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 2) PÓS — estrutural + privilégios. Aborta o apply se algo não pegou.
--    (REPLACE preserva o ACL, mas a PÓS confere — é o que a 3.1 promete.)
-- ────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_cpv oid := to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)');
BEGIN
  IF v_cpv IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: atp_confirmar_pv ausente';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_cpv) !~ 'pv_divergente' THEN
    RAISE EXCEPTION 'POS FALHOU: atp_confirmar_pv sem o ajuste ao PV reconciliado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_cpv
              AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION 'POS FALHOU: atp_confirmar_pv perdeu SECURITY DEFINER ou o search_path';
  END IF;
  IF has_function_privilege('anon', v_cpv, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cpv, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: anon/authenticated com EXECUTE em atp_confirmar_pv';
  END IF;
  IF NOT has_function_privilege('service_role', v_cpv, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: service_role sem EXECUTE em atp_confirmar_pv (o write-back da edge quebraria)';
  END IF;
END
$pos$;
