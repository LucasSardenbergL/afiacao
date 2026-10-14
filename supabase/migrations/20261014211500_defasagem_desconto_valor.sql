-- 20261014211500_defasagem_desconto_valor.sql
-- ============================================================
-- Cockpit de preço (get_defasagem_cliente): o guard `desconto_nao_provado` passa a ler o desconto
-- REAL do item, `order_items.desconto_valor` (R$ da linha; NULL = não apurado), no lugar da coluna
-- legada `order_items.discount`, que é 0 em 100% do acervo (72.315 linhas, medido 2026-10-14) — o
-- guard projetado na spec 2b §5.4 ("nunca fabricar alerta") nunca disparou.
--
-- Semântica: a âncora só serve de preço CHEIO quando TODA linha do dia dela tem desconto apurado = 0.
-- Desconto > 0, NULL (não apurado), NaN ou negativo → neutro/desconto_nao_provado.
--
-- Efeito medido na prod (psql-ro, 2026-10-14; 24.211 pares cliente×produto×empresa, db/medicao no PR):
--   status que o vendedor vê como alerta/"em dia" (calculável, sem_alta, prejuizo_ancora):
--     só desconto > 0 → 172 pares; com NULL também → 176 pares.
--   o resto dos 19.202 pares com NULL já era neutro/sem custo (âncora antiga, sem snapshot de cmc).
--
-- Única mudança de corpo: 2 linhas (o alias disc_item e o bool_or). Assinatura, retorno,
-- volatilidade, SECURITY DEFINER, search_path, dono e ACL intactos (CREATE OR REPLACE preserva).
-- Molde TRAVA → PRE → CREATE → PÓS (lovable-db-operator, "Recriar objeto VIVO"): a trava prende a
-- linha de pg_proc antes de medir; PRE aceita o predecessor medido em prod ou este corpo (re-colar é
-- seguro); PÓS: semântica → md5 → retrato de config/ACL igual ao de antes.
-- Prova: db/test-defasagem-desconto-valor.sh.

BEGIN;

ALTER FUNCTION public.get_defasagem_cliente(jsonb,uuid) STABLE;

CREATE TEMP TABLE IF NOT EXISTS defasagem_desc_retrato (config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.defasagem_desc_retrato;

DO $pre$
DECLARE v_md5 text;
BEGIN
  IF to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE: get_defasagem_cliente ausente — esta migration exige o predecessor medido na prod';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
  IF v_md5 IS DISTINCT FROM 'a03eb600ef0d2a946e550aa55bba415e' AND v_md5 IS DISTINCT FROM '2ed6e15998b5c48e7b4de590e5dbbaf3' THEN
    RAISE EXCEPTION 'PRE: get_defasagem_cliente deriva — md5(prosrc)=% não é o predecessor (a03eb600…) nem este corpo', v_md5;
  END IF;
  INSERT INTO pg_temp.defasagem_desc_retrato
    SELECT p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
END $pre$;

CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- constantes (espelho de DEFASAGEM_CONST do helper)
  c_tol_pp        constant numeric := 3;      -- pontos percentuais
  c_piso_alta     constant numeric := 2;      -- % alta mínima (anti-ruído)
  c_piso_acao_pp  constant numeric := 2;      -- % de p_now
  c_piso_acao_rs  constant numeric := 1;      -- R$ absolutos
  c_ancora_max    constant int     := 18;     -- meses
  c_quarentena    constant numeric := 50;     -- % alta absurda
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
  v_data_label text;
BEGIN
  -- Gate de staff IDÊNTICO à 2a.
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := private.cap_custo_ler(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item
    v_p_last := NULL; v_qtd_ancora := NULL; v_data_ancora := NULL; v_disc := NULL;
    v_c_last := NULL; v_c_now := NULL; v_c_now_synced := NULL; v_qty_carrinho := NULL;
    v_status := NULL; v_motivo := NULL; v_p_req := NULL; v_alta_perc := NULL;
    v_markup_ant := NULL; v_tem_ancora := false; v_data_label := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_qty_carrinho := NULLIF(v_item->>'qty','')::numeric;  -- opcional (G5); se ausente, qty_ratio passa

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    -- ── ÂNCORA: última compra REAL deste cliente p/ este produto (account-aware) ──
    -- Data da âncora: dInc do omie_payload (DD/MM/YYYY) → fallback order_date_kpi.
    -- Pega o pedido mais recente por essa data; média ponderada por quantity é tratada
    -- abaixo (mesmo dia). Aqui resolvemos a DATA e o flag de desconto do pedido vencedor.
    WITH ancora AS (
      SELECT
        oi.unit_price,
        oi.quantity,
        -- desconto do ITEM em R$ da linha (desconto-omie.ts). NULL = NÃO APURADO ≠ 0 = o Omie
        -- informou zero. A coluna legada `order_items.discount` (0 em 100% das linhas — lia `prod.desconto`,
        -- chave que a API não tem): o guard abaixo nunca disparou enquanto lia ela.
        oi.desconto_valor AS disc_item,
        so.discount AS disc_pedido,
        COALESCE(
          to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'),
          so.order_date_kpi
        ) AS data_real,
        (so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL
          OR so.order_date_kpi IS NOT NULL AS data_ok
      FROM order_items oi
      JOIN sales_orders so ON so.id = oi.sales_order_id
      WHERE oi.customer_user_id = p_customer_user_id
        AND oi.omie_codigo_produto = v_codigo
        AND so.account = ANY(v_accounts)
        AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')  -- universo canônico (src/lib/farmer/universo-pedidos.ts)
        AND so.omie_pedido_id IS NOT NULL
        AND so.deleted_at IS NULL
    ),
    melhor_data AS (
      -- a data da âncora = a maior data_real entre as linhas válidas (com data_ok)
      SELECT max(data_real) AS data_real
      FROM ancora
      WHERE data_ok AND data_real IS NOT NULL
    ),
    no_dia AS (
      -- todas as linhas naquele dia → média ponderada por quantity do unit_price
      SELECT
        a.*,
        (SELECT data_real FROM melhor_data) AS data_alvo
      FROM ancora a
      WHERE a.data_real = (SELECT data_real FROM melhor_data)
    )
    SELECT
      -- ⚠️ As duas somas do PRECO sao FILTRADAS pelas linhas com preco utilizavel; a
      -- quantidade da ancora (linha de baixo) NAO e — sao medidas diferentes.
      -- Sem o FILTER no DENOMINADOR, uma linha sem preco DILUI a media: duas linhas do
      -- mesmo SKU/dia, quantidade 1 cada, precos 100 e NULL, davam 100/2 = 50. Um preco
      -- que ninguem praticou, que depois passa pelo guard positivo e alimenta p_req,
      -- markup e a classificacao de defasagem. [P1 do challenge Codex]
      -- `> 0` e nao `IS NOT NULL`: preco zero informado tambem nao e preco praticado.
      CASE WHEN sum(quantity) FILTER (WHERE unit_price > 0) > 0
           THEN sum(unit_price * quantity) FILTER (WHERE unit_price > 0)
                / sum(quantity) FILTER (WHERE unit_price > 0)
           ELSE NULL END,
      sum(quantity),
      (SELECT data_real FROM melhor_data),
      -- Âncora só é preço CHEIO provado se TODA linha do dia tem desconto apurado = 0. NULL (não
      -- apurado), NaN e negativo também NÃO provam ausência de desconto → `IS DISTINCT FROM 0`, e não
      -- `COALESCE(…,0) > 0`, que trataria "não sei" como "sem desconto" (spec 2b §5.4: nunca
      -- fabricar alerta). Medido em 2026-10-14: o NULL soma +4 pares aos 172 que o >0 já neutraliza
      -- entre os pares com status acionável; os NULL vivem em âncora antiga, já neutra.
      -- `so.discount` (capa) é 0 por desenho: o writer grava 0 e o Omie distribui o desconto de
      -- capa aos itens — fica como defesa, com a régua de sempre.
      bool_or(disc_item IS DISTINCT FROM 0 OR COALESCE(disc_pedido,0) > 0),
      (count(*) > 0)
    INTO v_p_last, v_qtd_ancora, v_data_ancora, v_disc, v_tem_ancora
    FROM no_dia;

    -- ── C_now: CMC atual freshest (account-aware), + frescor (G6) ──
    SELECT ip.cmc, ip.synced_at
      INTO v_c_now, v_c_now_synced
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
      AND ip.account = ANY(v_accounts)
    ORDER BY ip.synced_at DESC NULLS LAST
    LIMIT 1;

    -- ── C_last: cmc_snapshot na data da âncora, janela ±7 dias, o mais próximo ──
    IF v_data_ancora IS NOT NULL THEN
      SELECT cs.cmc
        INTO v_c_last
      FROM cmc_snapshot cs
      WHERE cs.omie_codigo_produto = v_codigo
        AND cs.account = ANY(v_accounts)
        AND cs.cmc > 0 AND cs.cmc <> 'NaN'::numeric
        AND abs(cs.data_posicao - v_data_ancora) <= c_janela_dias
      ORDER BY abs(cs.data_posicao - v_data_ancora) ASC, cs.synced_at DESC
      LIMIT 1;
    END IF;

    -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
    -- Ordem dos guards = literal da spec §5.2-5.4.
    IF NOT v_tem_ancora THEN
      v_status := 'sem_historico'; v_motivo := 'sem_historico';
    ELSIF v_disc THEN
      v_status := 'neutro'; v_motivo := 'desconto_nao_provado';
    ELSIF v_data_ancora IS NULL THEN
      v_status := 'sem_data_confiavel'; v_motivo := 'sem_data_confiavel';
    ELSIF v_c_now IS NULL OR v_c_now_synced IS NULL
          OR v_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
      v_status := 'sem_custo_atual_fresco'; v_motivo := 'sem_custo_atual_fresco';
    ELSIF v_c_last IS NULL THEN
      -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
      v_status := 'neutro'; v_motivo := 'sem_custo_historico';
    ELSIF v_p_last IS NULL OR v_p_last <= 0 OR v_p_last = 'NaN'::numeric
          OR v_c_last <= 0 OR v_c_last = 'NaN'::numeric
          OR v_c_now  <= 0 OR v_c_now  = 'NaN'::numeric THEN
      v_status := 'neutro'; v_motivo := 'sem_base';
    ELSIF v_qty_carrinho IS NOT NULL AND v_qtd_ancora IS NOT NULL AND v_qtd_ancora > 0
          AND (v_qty_carrinho / v_qtd_ancora >= 10 OR v_qtd_ancora / v_qty_carrinho >= 10) THEN
      -- G5: ordem de grandeza divergente → revisar
      v_status := 'revisar'; v_motivo := 'qty_divergente';
    ELSIF EXTRACT(EPOCH FROM (now() - v_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
      v_status := 'neutro'; v_motivo := 'ancora_antiga';
    ELSE
      v_razao := v_c_now / v_c_last;
      IF v_razao - 1 > c_quarentena / 100 THEN
        v_status := 'revisar'; v_motivo := 'quarentena_custo';
      ELSIF v_p_last <= v_c_last THEN
        v_status := 'neutro'; v_motivo := 'prejuizo_ancora';   -- G1
      ELSIF v_c_now <= v_c_last THEN
        v_status := 'sem_alta'; v_motivo := 'custo_nao_subiu';
      ELSE
        v_alta := v_razao - 1;
        IF v_alta < c_piso_alta / 100 THEN
          v_status := 'sem_alta'; v_motivo := 'alta_ruido';
        ELSE
          v_p_req := round(v_p_last * v_razao, 2);
          v_alta_perc := v_alta * 100;
          v_subiu_preco := CASE WHEN v_preco > 0 THEN v_preco / v_p_last - 1 ELSE -1 END;
          IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
            -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
            v_gap_reais := round(v_p_req, 2) - round(v_preco, 2);
            v_piso_acao := greatest((c_piso_acao_pp / 100) * v_preco, c_piso_acao_rs);
            IF v_gap_reais < v_piso_acao THEN
              v_status := 'em_dia'; v_motivo := 'gap_abaixo_do_piso';
            ELSE
              v_status := 'defasado'; v_motivo := 'custo_subiu_preco_nao_acompanhou';
            END IF;
          ELSE
            v_status := 'em_dia'; v_motivo := 'preco_acompanhou';
          END IF;
        END IF;
      END IF;
    END IF;

    -- markup anterior (só p/ gestor) — só faz sentido com base válida.
    IF v_p_last IS NOT NULL AND v_c_last IS NOT NULL AND v_c_last > 0 AND v_c_last <> 'NaN'::numeric THEN
      v_markup_ant := (v_p_last - v_c_last) / v_c_last * 100;
    END IF;

    -- rótulo da data da âncora = MM/AAAA
    v_data_label := CASE WHEN v_data_ancora IS NOT NULL THEN to_char(v_data_ancora,'MM/YYYY') ELSE NULL END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'status_defasagem', v_status,
      'tem_ancora', v_tem_ancora,
      'p_req', to_jsonb(v_p_req),
      'alta_custo_perc', to_jsonb(v_alta_perc),
      'data_ancora', to_jsonb(v_data_label),
      'motivo', v_motivo,
      'calculated_at', now(),
      -- role-gated (absolutos só p/ pode_ver_carteira_completa):
      'p_last',         CASE WHEN v_pode_num THEN to_jsonb(v_p_last)      ELSE 'null'::jsonb END,
      'c_last',         CASE WHEN v_pode_num THEN to_jsonb(v_c_last)      ELSE 'null'::jsonb END,
      'c_now',          CASE WHEN v_pode_num THEN to_jsonb(v_c_now)       ELSE 'null'::jsonb END,
      'markup_anterior',CASE WHEN v_pode_num THEN to_jsonb(v_markup_ant)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$function$;

DO $pos$
DECLARE v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
         coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
    INTO v_src, v_cfg, v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
  IF v_src IS NULL THEN RAISE EXCEPTION 'POS: get_defasagem_cliente sumiu'; END IF;
  -- semântica primeiro (diz O QUE está errado); o md5 depois (só diz QUE está)
  IF position('oi.desconto_valor AS disc_item' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS: a âncora não lê order_items.desconto_valor';
  END IF;
  IF v_src ~* 'oi\.discount\M' THEN
    RAISE EXCEPTION 'POS: a âncora ainda lê a coluna legada order_items.discount';
  END IF;
  IF position('disc_item IS DISTINCT FROM 0' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS: desconto NULL (não apurado) não é tratado como não provado';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '2ed6e15998b5c48e7b4de590e5dbbaf3' THEN
    RAISE EXCEPTION 'POS: md5(prosrc)=% não é o corpo desta migration', md5(v_src);
  END IF;
  SELECT * INTO v_ret FROM pg_temp.defasagem_desc_retrato;
  IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: config/ACL mudou — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_cfg, v_acl;
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.defasagem_desc_retrato;

COMMIT;
