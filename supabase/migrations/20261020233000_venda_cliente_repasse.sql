-- 20261020233000_venda_cliente_repasse.sql
-- ============================================================
-- Venda por cliente — Task 6: repasse de preço (money-path). Plano:
-- docs/superpowers/plans/2026-10-20-venda-por-cliente.md (Task 6) · spec §7 Fase 4 / §11.
--
-- 1. Extrai a AVALIAÇÃO da defasagem (cadeia de guards da spec 2b §5.2-5.4) de get_defasagem_cliente
--    para private._defasagem_item(...). O cockpit continua SELECIONANDO seus dados como antes (dInc,
--    unit_price cheio, desconto provado) e só delega a avaliação: saída idêntica (prova: diff de JSON
--    no harness). A seleção NÃO foi unificada de propósito (Codex desenho, resposta 3): o lote usa
--    outra fonte de preço (líquido) e precisa de âncora e preço avaliado vindos da MESMA compra.
-- 2. Lote: private._venda_repasse_base(comprador) — último dia de compra Oben por comprador canônico ×
--    SKU, preço = média ponderada do LÍQUIDO do dia (dia com linha sem preço apurado = preço
--    desconhecido, nunca média parcial nem recuo ao dia anterior), C_last/C_now pelo mesmo resolvedor
--    do cockpit; âncora = preço avaliado = a mesma compra.
-- 3. venda_repasse_candidatos() (master + cap_custo_ler), tabela venda_repasse_aprovado (1 escritor:
--    as RPCs abaixo), venda_aprovar_repasse / venda_revogar_repasse (master), venda_preco_alvo_comprador
--    (staff com a carteira do comprador): SEM custo, markup ou piso.
--
-- Decisões do parecer Codex de desenho (logs/venda-repasse/codex-desenho.out, 8 P1):
--   · o PISO nunca vira preço sugerido (alvo = piso deixaria a farmer reconstruir o CMC por alvo×(1−alíq.));
--     em candidatos sai só o SINAL abaixo_piso, calculado com o MESMO custo fresco da defasagem;
--   · tinta = is_tintometric IS FALSE (NULL não é "não-tinta"), revalidado na aprovação e na leitura;
--   · a leitura revalida o último preço AO VIVO e omite o alvo já alcançado/superado ou sem base;
--   · autoridade da farmer = dono ÚNICO da carteira do grupo canônico (2 donos → nega);
--   · aprovação/revogação serializadas por pg_advisory_xact_lock no trio; substituir exige o id que a
--     tela viu (p_substitui) — conflito explícito (40001) em vez de sobrescrever decisão de tela velha;
--   · faixa de margem usa o CMC de inventory_position (mesmo resolvedor), não product_costs: corrige o §11.
--
-- Molde: get_defasagem_cliente é objeto VIVO → TRAVA → PRE (md5 do predecessor medido) → CREATE → PÓS
-- (md5 + config/ACL iguais). O resto é criação nova, idempotente. Prova: db/test-venda-repasse.sh.
-- ⚠️ migration manual (Lovable não auto-aplica). Depende de private.venda_linhas_pedido e
-- public.venda_recompra (Task 2, 20261020150000 — já aplicada na prod).

BEGIN;

-- ── PRE: dependências da Task 2 ─────────────────────────────────────────────
DO $dep$
BEGIN
  IF to_regprocedure('private.venda_linhas_pedido(date)') IS NULL THEN
    RAISE EXCEPTION 'PRE_DEP: private.venda_linhas_pedido(date) ausente — aplique antes a migration da Task 2 (20261020150000)';
  END IF;
  IF to_regclass('public.venda_recompra') IS NULL THEN
    RAISE EXCEPTION 'PRE_DEP: public.venda_recompra ausente — aplique antes a migration da Task 2 (20261020150000)';
  END IF;
END $dep$;

-- ── 1. Avaliação da defasagem (núcleo extraído) ─────────────────────────────
-- Corpo da cadeia de guards copiado LITERALMENTE de 20261014211500 (linhas 211-270). STABLE: usa now().
-- Sem SECURITY DEFINER e sem EXECUTE para ninguém além do dono: só é chamada por funções definer.
CREATE OR REPLACE FUNCTION private._defasagem_item(
  p_tem_ancora boolean, p_disc boolean, p_data_ancora date, p_p_last numeric, p_qtd_ancora numeric,
  p_c_last numeric, p_c_now numeric, p_c_now_synced timestamptz, p_preco numeric, p_qty numeric,
  OUT status text, OUT motivo text, OUT p_req numeric, OUT alta_perc numeric, OUT markup_ant numeric)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
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
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
BEGIN
  -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
  -- Ordem dos guards = literal da spec §5.2-5.4.
  IF NOT p_tem_ancora THEN
    status := 'sem_historico'; motivo := 'sem_historico';
  ELSIF p_disc THEN
    status := 'neutro'; motivo := 'desconto_nao_provado';
  ELSIF p_data_ancora IS NULL THEN
    status := 'sem_data_confiavel'; motivo := 'sem_data_confiavel';
  ELSIF p_c_now IS NULL OR p_c_now_synced IS NULL
        OR p_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
    status := 'sem_custo_atual_fresco'; motivo := 'sem_custo_atual_fresco';
  ELSIF p_c_last IS NULL THEN
    -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
    status := 'neutro'; motivo := 'sem_custo_historico';
  ELSIF p_p_last IS NULL OR p_p_last <= 0 OR p_p_last = 'NaN'::numeric
        OR p_c_last <= 0 OR p_c_last = 'NaN'::numeric
        OR p_c_now  <= 0 OR p_c_now  = 'NaN'::numeric THEN
    status := 'neutro'; motivo := 'sem_base';
  ELSIF p_qty IS NOT NULL AND p_qtd_ancora IS NOT NULL AND p_qtd_ancora > 0
        AND (p_qty / p_qtd_ancora >= 10 OR p_qtd_ancora / p_qty >= 10) THEN
    -- G5: ordem de grandeza divergente → revisar
    status := 'revisar'; motivo := 'qty_divergente';
  ELSIF EXTRACT(EPOCH FROM (now() - p_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
    status := 'neutro'; motivo := 'ancora_antiga';
  ELSE
    v_razao := p_c_now / p_c_last;
    IF v_razao - 1 > c_quarentena / 100 THEN
      status := 'revisar'; motivo := 'quarentena_custo';
    ELSIF p_p_last <= p_c_last THEN
      status := 'neutro'; motivo := 'prejuizo_ancora';   -- G1
    ELSIF p_c_now <= p_c_last THEN
      status := 'sem_alta'; motivo := 'custo_nao_subiu';
    ELSE
      v_alta := v_razao - 1;
      IF v_alta < c_piso_alta / 100 THEN
        status := 'sem_alta'; motivo := 'alta_ruido';
      ELSE
        p_req := round(p_p_last * v_razao, 2);
        alta_perc := v_alta * 100;
        v_subiu_preco := CASE WHEN p_preco > 0 THEN p_preco / p_p_last - 1 ELSE -1 END;
        IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
          -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
          v_gap_reais := round(p_req, 2) - round(p_preco, 2);
          v_piso_acao := greatest((c_piso_acao_pp / 100) * p_preco, c_piso_acao_rs);
          IF v_gap_reais < v_piso_acao THEN
            status := 'em_dia'; motivo := 'gap_abaixo_do_piso';
          ELSE
            status := 'defasado'; motivo := 'custo_subiu_preco_nao_acompanhou';
          END IF;
        ELSE
          status := 'em_dia'; motivo := 'preco_acompanhou';
        END IF;
      END IF;
    END IF;
  END IF;

  -- markup anterior (só p/ gestor) — só faz sentido com base válida.
  IF p_p_last IS NOT NULL AND p_c_last IS NOT NULL AND p_c_last > 0 AND p_c_last <> 'NaN'::numeric THEN
    markup_ant := (p_p_last - p_c_last) / p_c_last * 100;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private._defasagem_item(boolean,boolean,date,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric)
  FROM PUBLIC, anon, authenticated;

-- ── 1b. get_defasagem_cliente passa a delegar a avaliação (objeto VIVO) ─────
-- A trava (ALTER … STABLE) ESCREVE a volatilidade: guardar a de antes (mesmo molde de 20261014211500).
CREATE TEMP TABLE IF NOT EXISTS repasse_def_volatil (provolatile text);
TRUNCATE pg_temp.repasse_def_volatil;
INSERT INTO pg_temp.repasse_def_volatil
  SELECT p.provolatile::text FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');

ALTER FUNCTION public.get_defasagem_cliente(jsonb,uuid) STABLE;

CREATE TEMP TABLE IF NOT EXISTS repasse_def_retrato (config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.repasse_def_retrato;

DO $pre$
DECLARE v_md5 text;
BEGIN
  IF to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE: get_defasagem_cliente ausente — esta migration exige o predecessor medido na prod';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
  IF (SELECT provolatile FROM pg_temp.repasse_def_volatil) IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'PRE_VOLATIL: get_defasagem_cliente não era STABLE antes da trava (provolatile=%)',
      (SELECT provolatile FROM pg_temp.repasse_def_volatil);
  END IF;
  -- predecessor medido na prod (2026-10-20, psql-ro) = corpo de 20261014211500; ou este corpo (re-colar é seguro)
  IF v_md5 IS DISTINCT FROM '2ed6e15998b5c48e7b4de590e5dbbaf3' AND v_md5 IS DISTINCT FROM '5b5c8206fcb4650f1180be3fb13eeeaf' THEN
    RAISE EXCEPTION 'PRE: get_defasagem_cliente deriva — md5(prosrc)=% não é o predecessor (2ed6e159…) nem este corpo', v_md5;
  END IF;
  INSERT INTO pg_temp.repasse_def_retrato
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
  -- constante de SELEÇÃO (as de avaliação vivem em private._defasagem_item)
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
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

    -- ════════ AVALIAÇÃO: núcleo compartilhado com o lote de repasse (Task 6) ════════
    SELECT d.status, d.motivo, d.p_req, d.alta_perc, d.markup_ant
      INTO v_status, v_motivo, v_p_req, v_alta_perc, v_markup_ant
      FROM private._defasagem_item(v_tem_ancora, v_disc, v_data_ancora, v_p_last, v_qtd_ancora,
                                   v_c_last, v_c_now, v_c_now_synced, v_preco, v_qty_carrinho) d;

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

-- ── 2. Base do lote: último dia de compra Oben por comprador canônico × SKU ──
-- p_comprador NULL = todos (candidatos); senão só o comprador CANÔNICO informado.
-- Preço do dia: média ponderada do líquido; dia com qualquer linha de líquido não apurado (NULL),
-- negativo ou não finito → preço NULL (ausente ≠ zero; nunca média parcial, nunca recuo ao dia anterior).
-- Linha de líquido 0 (bonificação) é valor CONHECIDO: fica fora da média, como no cockpit.
-- Âncora e preço avaliado são a MESMA compra: o lote pergunta "o último preço já acompanhou o custo?".
-- C_now/C_last: mesmos filtros e desempate do cockpit; janela de C_last escrita como BETWEEN
-- (equivalente a abs(…) <= 7, mas usa o índice (account, omie_codigo_produto, data_posicao)).
CREATE OR REPLACE FUNCTION private._venda_repasse_base(p_comprador uuid)
 RETURNS TABLE(comprador_id uuid, omie_codigo_produto bigint, data_ancora date, ultimo_preco numeric,
               qtd_ancora numeric, c_last numeric, c_now numeric, c_now_fresco boolean,
               status_defasagem text, motivo text, p_req numeric, alta_custo_perc numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT x.comprador_id, x.omie_codigo_produto, x.quantidade, x.preco_unit_liquido, x.data_pedido
      FROM private.venda_linhas_pedido(((now() AT TIME ZONE 'America/Sao_Paulo')::date + 1)) x
     WHERE x.empresa = 'oben'
       AND (p_comprador IS NULL OR x.comprador_id = p_comprador)
  ),
  ult AS (
    SELECT l.comprador_id, l.omie_codigo_produto, max(l.data_pedido) AS dia
      FROM l GROUP BY l.comprador_id, l.omie_codigo_produto
  ),
  dia AS (
    SELECT u.comprador_id, u.omie_codigo_produto, u.dia,
           sum(l.quantidade) AS qtd,
           bool_and(l.preco_unit_liquido IS NOT NULL AND l.preco_unit_liquido >= 0
                    AND l.preco_unit_liquido < 1e9) AS completo,
           sum(l.preco_unit_liquido * l.quantidade) FILTER (WHERE l.preco_unit_liquido > 0) AS soma,
           sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido > 0) AS qtd_preco
      FROM ult u
      JOIN l ON l.comprador_id = u.comprador_id AND l.omie_codigo_produto = u.omie_codigo_produto
            AND l.data_pedido = u.dia
     GROUP BY u.comprador_id, u.omie_codigo_produto, u.dia
  )
  SELECT d.comprador_id, d.omie_codigo_produto, d.dia, p.p_last, d.qtd, cl.cmc, cn.cmc,
         -- MESMO critério de frescor do guard sem_custo_atual_fresco (48h em _defasagem_item)
         (cn.cmc IS NOT NULL AND cn.synced_at IS NOT NULL AND cn.synced_at >= now() - make_interval(hours => 48)),
         e.status, e.motivo, e.p_req, e.alta_perc
    FROM dia d
    CROSS JOIN LATERAL (
      SELECT CASE WHEN d.completo AND d.qtd_preco > 0 THEN d.soma / d.qtd_preco END AS p_last
    ) p
    LEFT JOIN LATERAL (
      SELECT ip.cmc, ip.synced_at FROM public.inventory_position ip
       WHERE ip.omie_codigo_produto = d.omie_codigo_produto
         AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0   -- finito: Infinity não é custo (Codex código P1)
         AND ip.account = ANY (ARRAY['vendas','oben'])
       ORDER BY ip.synced_at DESC NULLS LAST
       LIMIT 1
    ) cn ON true
    LEFT JOIN LATERAL (
      SELECT cs.cmc FROM public.cmc_snapshot cs
       WHERE cs.omie_codigo_produto = d.omie_codigo_produto
         AND cs.account = ANY (ARRAY['vendas','oben'])
         AND private.regua_num_finito(cs.cmc) AND cs.cmc > 0
         AND cs.data_posicao BETWEEN d.dia - 7 AND d.dia + 7
       ORDER BY abs(cs.data_posicao - d.dia) ASC, cs.synced_at DESC
       LIMIT 1
    ) cl ON true
    CROSS JOIN LATERAL private._defasagem_item(
      true, false, d.dia, p.p_last, d.qtd, cl.cmc, cn.cmc, cn.synced_at, p.p_last, NULL::numeric) e
$function$;

REVOKE ALL ON FUNCTION private._venda_repasse_base(uuid) FROM PUBLIC, anon, authenticated;

-- ── 2b. SKU elegível à régua v1: Oben e NÃO-tinta PROVADO (is_tintometric = false; NULL não serve) ──
CREATE OR REPLACE FUNCTION private._venda_repasse_sku_ok(p_codigo bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(bool_and(op.is_tintometric IS FALSE), false)
    FROM public.omie_products op
   WHERE op.omie_codigo_produto = p_codigo AND op.account = 'oben';
$function$;

REVOKE ALL ON FUNCTION private._venda_repasse_sku_ok(bigint) FROM PUBLIC, anon, authenticated;

-- ── 3. Tabela de repasses aprovados (1 escritor: venda_aprovar_repasse / venda_revogar_repasse) ──
CREATE TABLE IF NOT EXISTS public.venda_repasse_aprovado (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comprador_id               uuid NOT NULL,           -- comprador CANÔNICO
  empresa                    text NOT NULL CHECK (empresa = 'oben'),
  omie_codigo_produto        bigint NOT NULL,
  -- `> 0 AND < 1e9` também barra NaN (NaN > tudo) e ±Infinity
  preco_alvo                 numeric NOT NULL CHECK (preco_alvo > 0 AND preco_alvo < 1e9 AND preco_alvo = round(preco_alvo, 2)),
  ultimo_preco_na_aprovacao  numeric NOT NULL CHECK (ultimo_preco_na_aprovacao > 0 AND ultimo_preco_na_aprovacao < 1e9),
  valido_ate                 date NOT NULL,
  aprovado_por               uuid NOT NULL,
  aprovado_em                timestamptz NOT NULL DEFAULT clock_timestamp(),
  revogado_em                timestamptz NULL,
  revogado_por               uuid NULL,
  substitui_id               uuid NULL REFERENCES public.venda_repasse_aprovado(id),  -- versão anterior do trio
  CONSTRAINT venda_repasse_alvo_acima_ultimo CHECK (preco_alvo > ultimo_preco_na_aprovacao),
  CONSTRAINT venda_repasse_revogacao_par CHECK ((revogado_em IS NULL) = (revogado_por IS NULL))
);

-- 1 NÃO-REVOGADO por trio (vencido ainda ocupa a chave: a aprovação o substitui revogando — Codex P2)
CREATE UNIQUE INDEX IF NOT EXISTS venda_repasse_aprovado_vigente_uq
  ON public.venda_repasse_aprovado (comprador_id, empresa, omie_codigo_produto)
  WHERE revogado_em IS NULL;

ALTER TABLE public.venda_repasse_aprovado ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito: leitura e escrita só pelas RPCs SECURITY DEFINER abaixo.
REVOKE ALL ON TABLE public.venda_repasse_aprovado FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.venda_repasse_aprovado IS
  'Venda por cliente (Task 6): preço alvo aprovado pelo master por comprador canônico × SKU Oben não-tinta. '
  '1 escritor (venda_aprovar_repasse/venda_revogar_repasse). Leitura da farmer: venda_preco_alvo_comprador (sem custo).';

-- ── 4. Candidatos (master + cap_custo_ler) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_repasse_candidatos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_aliq numeric;
  v_out jsonb;
BEGIN
  -- master E cap (redundante hoje — cap inclui master —, mas são decisões distintas: escopo do founder
  -- × capacidade de ler custo; estratégico NÃO vê candidatos na v1 — Codex desenho, resposta 7)
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role)
     OR NOT private.cap_custo_ler(v_uid) THEN
    RAISE EXCEPTION 'venda_repasse_candidatos: requer master com capacidade de custo' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE((SELECT cc.value::numeric FROM public.company_config cc
                    WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliq;

  WITH b AS (
    SELECT b.*,
           r.n_pedidos, r.cadencia_dias, r.qtd_sugerida,
           op.descricao,
           CASE WHEN b.status_defasagem = 'defasado' AND private.regua_num_finito(b.p_req) AND b.p_req > b.ultimo_preco
                THEN b.p_req END AS sugerido,
           -- SINAL do piso com o MESMO custo fresco da defasagem; sem custo fresco ou sem preço → NULL
           CASE WHEN b.c_now_fresco AND private.regua_num_finito(b.ultimo_preco) AND b.ultimo_preco > 0
                THEN b.ultimo_preco < (private.regua_piso_calc(b.c_now, v_aliq, NULL::numeric[], NULL::numeric)).piso
           END AS abaixo_piso
      FROM private._venda_repasse_base(NULL) b
      JOIN public.venda_recompra r
        ON r.comprador_id = b.comprador_id AND r.empresa = 'oben' AND r.omie_codigo_produto = b.omie_codigo_produto
      JOIN public.omie_products op
        ON op.omie_codigo_produto = b.omie_codigo_produto AND op.account = 'oben' AND op.is_tintometric IS FALSE
  ),
  c AS (
    SELECT b.*,
           CASE WHEN b.sugerido IS NOT NULL AND b.qtd_sugerida > 0 AND b.cadencia_dias > 0
                     AND private.regua_num_finito(b.qtd_sugerida) AND private.regua_num_finito(b.cadencia_dias)
                THEN round(b.qtd_sugerida * 365 / b.cadencia_dias * (b.sugerido - b.ultimo_preco), 2)
           END AS valor_anual
      FROM b
     WHERE b.status_defasagem = 'defasado' OR b.abaixo_piso IS TRUE
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'comprador_id',            c.comprador_id,
           'empresa',                 'oben',
           'omie_codigo_produto',     c.omie_codigo_produto,
           'descricao',               c.descricao,
           'status_defasagem',        c.status_defasagem,
           'motivo',                  c.motivo,
           'abaixo_piso',             c.abaixo_piso,
           'ultimo_preco',            round(c.ultimo_preco, 4),
           'data_ultima_compra',      c.data_ancora,
           'preco_sugerido',          c.sugerido,
           'alta_custo_perc',         round(c.alta_custo_perc, 2),
           'valor_anual_recuperavel', c.valor_anual,
           -- evidência (o master tem a capacidade de custo — gate acima)
           'c_last',                  c.c_last,
           'c_now',                   c.c_now,
           'n_pedidos',               c.n_pedidos,
           'cadencia_dias',           c.cadencia_dias,
           'qtd_sugerida',            c.qtd_sugerida,
           -- a VERSÃO do trio = o registro mais recente (revogado ou não): é o que a tela devolve em p_substitui
           'repasse_atual', (
             SELECT jsonb_build_object('id', ra.id, 'preco_alvo', ra.preco_alvo, 'valido_ate', ra.valido_ate,
                                       'revogado', ra.revogado_em IS NOT NULL,
                                       'vigente', ra.revogado_em IS NULL
                                                  AND ra.valido_ate >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
               FROM public.venda_repasse_aprovado ra
              WHERE ra.comprador_id = c.comprador_id AND ra.empresa = 'oben'
                AND ra.omie_codigo_produto = c.omie_codigo_produto
              ORDER BY ra.aprovado_em DESC, ra.id DESC
              LIMIT 1)
         ) ORDER BY c.valor_anual DESC NULLS LAST, c.comprador_id, c.omie_codigo_produto), '[]'::jsonb)
    INTO v_out
    FROM c;

  RETURN v_out;
END;
$function$;

-- ── 5. Aprovar (master) ─────────────────────────────────────────────────────
-- Versão do trio = o registro MAIS RECENTE (revogado ou não). p_substitui = a versão que a tela viu
-- (repasse_atual.id dos candidatos), NULL só para trio sem histórico. Divergiu → 40001: decisão de tela velha
-- não sobrescreve, e repetir uma criação depois de uma revogação NÃO ressuscita a aprovação (Codex código P1).
-- Retry idêntico (mesmo alvo, validade e mesmo p_substitui da requisição que criou a versão vigente) devolve o
-- mesmo id — vale para a criação e para a substituição (substitui_id guarda o antecessor).
CREATE OR REPLACE FUNCTION public.venda_aprovar_repasse(
  p_comprador uuid, p_empresa text, p_codigo bigint, p_preco_alvo numeric, p_valido_ate date,
  p_substitui uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_comprador uuid;
  v_ultimo numeric;
  v_atual public.venda_repasse_aprovado%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_aprovar_repasse: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL OR p_codigo IS NULL OR p_preco_alvo IS NULL OR p_valido_ate IS NULL THEN
    RAISE EXCEPTION 'REPASSE_PARAM: parametro obrigatorio ausente' USING ERRCODE = '22023';
  END IF;
  IF p_empresa IS DISTINCT FROM 'oben' THEN
    RAISE EXCEPTION 'REPASSE_EMPRESA: regua v1 so Oben (empresa=%)', p_empresa USING ERRCODE = '22023';
  END IF;
  IF NOT private._venda_repasse_sku_ok(p_codigo) THEN
    RAISE EXCEPTION 'REPASSE_SKU: SKU % nao e Oben nao-tinta provado', p_codigo USING ERRCODE = '22023';
  END IF;
  IF NOT (p_preco_alvo > 0 AND p_preco_alvo < 1e9) OR p_preco_alvo <> round(p_preco_alvo, 2) THEN
    RAISE EXCEPTION 'REPASSE_ALVO_INVALIDO: alvo precisa ser finito, > 0 e em centavos' USING ERRCODE = '22023';
  END IF;
  IF p_valido_ate <= v_hoje OR p_valido_ate > v_hoje + 365 THEN
    RAISE EXCEPTION 'REPASSE_VALIDADE: valido_ate deve estar em (hoje, hoje+365] no fuso de SP' USING ERRCODE = '22023';
  END IF;

  SELECT a.canonical_user_id INTO v_comprador
    FROM public.customer_canonical_alias a
   WHERE a.alias_user_id = p_comprador AND a.status = 'active';
  v_comprador := COALESCE(v_comprador, p_comprador);

  -- serializa aprovação/revogação do trio ANTES da leitura usada na validação (1ª aprovação incluída)
  PERFORM pg_advisory_xact_lock(hashtextextended('venda_repasse:' || v_comprador::text || ':oben:' || p_codigo::text, 0));

  -- último preço praticado AO VIVO (não o snapshot): média ponderada do líquido do último dia
  SELECT b.ultimo_preco INTO v_ultimo
    FROM private._venda_repasse_base(v_comprador) b
   WHERE b.omie_codigo_produto = p_codigo;
  IF v_ultimo IS NULL OR NOT private.regua_num_finito(v_ultimo) OR v_ultimo <= 0 THEN
    RAISE EXCEPTION 'REPASSE_SEM_ULTIMO: sem ultimo preco praticado provado para comprador/SKU' USING ERRCODE = '22023';
  END IF;
  -- compara com o último NÃO arredondado (Codex desenho, resposta 4)
  IF p_preco_alvo <= v_ultimo THEN
    RAISE EXCEPTION 'REPASSE_ALVO_ABAIXO: alvo % nao supera o ultimo preco praticado %', p_preco_alvo, round(v_ultimo, 4)
      USING ERRCODE = '22023';
  END IF;
  IF p_preco_alvo > 2 * v_ultimo THEN
    RAISE EXCEPTION 'REPASSE_ALVO_TETO: alvo % passa de 2x o ultimo preco % (digitacao?)', p_preco_alvo, round(v_ultimo, 4)
      USING ERRCODE = '22023';
  END IF;

  -- versão do trio (sob o advisory lock: ninguém insere/revoga o trio em paralelo)
  SELECT * INTO v_atual FROM public.venda_repasse_aprovado ra
   WHERE ra.comprador_id = v_comprador AND ra.empresa = 'oben' AND ra.omie_codigo_produto = p_codigo
   ORDER BY ra.aprovado_em DESC, ra.id DESC
   LIMIT 1
   FOR UPDATE;

  -- retry idêntico da requisição que criou a versão vigente
  IF v_atual.id IS NOT NULL AND v_atual.revogado_em IS NULL
     AND v_atual.preco_alvo = p_preco_alvo AND v_atual.valido_ate = p_valido_ate
     AND v_atual.substitui_id IS NOT DISTINCT FROM p_substitui THEN
    RETURN v_atual.id;
  END IF;
  IF p_substitui IS DISTINCT FROM v_atual.id THEN
    RAISE EXCEPTION 'REPASSE_CONFLITO: a versao do trio mudou desde a leitura (atual=%, vista=%)', v_atual.id, p_substitui
      USING ERRCODE = '40001';
  END IF;
  IF v_atual.id IS NOT NULL AND v_atual.revogado_em IS NULL THEN
    UPDATE public.venda_repasse_aprovado
       SET revogado_em = clock_timestamp(), revogado_por = v_uid
     WHERE id = v_atual.id;
  END IF;

  INSERT INTO public.venda_repasse_aprovado
    (comprador_id, empresa, omie_codigo_produto, preco_alvo, ultimo_preco_na_aprovacao, valido_ate,
     aprovado_por, aprovado_em, substitui_id)
  VALUES (v_comprador, 'oben', p_codigo, p_preco_alvo, v_ultimo, p_valido_ate, v_uid, clock_timestamp(), p_substitui)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ── 6. Revogar (master) — repetida é no-op (preserva autor/data originais) ──
CREATE OR REPLACE FUNCTION public.venda_revogar_repasse(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_r public.venda_repasse_aprovado%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_revogar_repasse: requer master' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_r FROM public.venda_repasse_aprovado WHERE id = p_id;
  IF v_r.id IS NULL THEN
    RAISE EXCEPTION 'REPASSE_INEXISTENTE: %', p_id USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'venda_repasse:' || v_r.comprador_id::text || ':oben:' || v_r.omie_codigo_produto::text, 0));
  UPDATE public.venda_repasse_aprovado
     SET revogado_em = clock_timestamp(), revogado_por = v_uid
   WHERE id = p_id AND revogado_em IS NULL;
END;
$function$;

-- ── 7. Leitura da farmer: SÓ empresa, SKU, último preço, alvo, faixa e validade ──
-- Gate: staff E (cap_carteira_ler OU dono ÚNICO das atribuições elegíveis do grupo canônico).
-- 2+ donos no grupo → nega (alias de A não abre a carteira de B — Codex P1). Medido em 2026-10-20:
-- 0 de 5.174 grupos com dono múltiplo.
-- Só repasse vigente (não revogado, valido_ate >= hoje SP), SKU ainda Oben não-tinta, último preço AO VIVO
-- provado e ABAIXO do alvo (alvo alcançado/superado ou base desconhecida → some; o registro fica).
-- Faixa: margem do ALVO sobre o CMC fresco (inventory_position, mesmo resolvedor), limiares de
-- farmer_algorithm_config; sem custo fresco → 'neutro'. "O número fecha, o sinal fica."
CREATE OR REPLACE FUNCTION public.venda_preco_alvo_comprador(p_comprador uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_comprador uuid;
  v_cadastros uuid[];
  v_donos uuid[];
  v_piso numeric;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'master'::public.app_role)
                           OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'venda_preco_alvo_comprador: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'REPASSE_PARAM: comprador obrigatorio' USING ERRCODE = '22023';
  END IF;

  SELECT a.canonical_user_id INTO v_comprador
    FROM public.customer_canonical_alias a
   WHERE a.alias_user_id = p_comprador AND a.status = 'active';
  v_comprador := COALESCE(v_comprador, p_comprador);

  SELECT array_agg(x.u) INTO v_cadastros
    FROM (SELECT v_comprador AS u
          UNION
          SELECT a.alias_user_id FROM public.customer_canonical_alias a
           WHERE a.canonical_user_id = v_comprador AND a.status = 'active') x;

  SELECT COALESCE(array_agg(DISTINCT ca.owner_user_id), '{}'::uuid[]) INTO v_donos
    FROM public.carteira_assignments ca
   WHERE ca.eligible = true AND ca.customer_user_id = ANY (v_cadastros) AND ca.owner_user_id IS NOT NULL;

  IF NOT private.cap_carteira_ler(v_uid)
     AND NOT (cardinality(v_donos) = 1 AND v_donos[1] = v_uid) THEN
    RAISE EXCEPTION 'venda_preco_alvo_comprador: comprador fora da sua carteira' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(max(c.value::numeric) FILTER (WHERE c.key = 'margem_faixa_piso_pct'), 30)
    INTO v_piso
    FROM public.farmer_algorithm_config c
   WHERE c.key = 'margem_faixa_piso_pct';

  WITH r AS (
    SELECT ra.omie_codigo_produto, ra.preco_alvo, ra.valido_ate, b.ultimo_preco,
           CASE WHEN b.c_now_fresco THEN (ra.preco_alvo - b.c_now) / ra.preco_alvo * 100 END AS pct
      FROM public.venda_repasse_aprovado ra
      JOIN private._venda_repasse_base(v_comprador) b
        ON b.omie_codigo_produto = ra.omie_codigo_produto
     WHERE ra.comprador_id = v_comprador AND ra.empresa = 'oben'
       AND ra.revogado_em IS NULL AND ra.valido_ate >= v_hoje
       AND private._venda_repasse_sku_ok(ra.omie_codigo_produto)
       AND private.regua_num_finito(b.ultimo_preco) AND b.ultimo_preco > 0
       AND b.ultimo_preco < ra.preco_alvo
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'empresa',             'oben',
           'omie_codigo_produto', r.omie_codigo_produto,
           'ultimo_preco',        round(r.ultimo_preco, 2),
           'preco_alvo',          r.preco_alvo,
           'faixa_margem',        CASE WHEN r.pct IS NULL THEN 'neutro'
                                       WHEN r.pct < 0      THEN 'vermelho'
                                       WHEN r.pct < v_piso THEN 'amarelo'
                                       ELSE                     'verde' END,
           'valido_ate',          r.valido_ate
         ) ORDER BY r.omie_codigo_produto), '[]'::jsonb)
    INTO v_out
    FROM r;

  RETURN v_out;
END;
$function$;

-- ── ACL das RPCs novas: fecha PUBLIC E anon (duas pontas), abre authenticated/service_role ──
REVOKE ALL ON FUNCTION public.venda_repasse_candidatos() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_revogar_repasse(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_preco_alvo_comprador(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_repasse_candidatos() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venda_revogar_repasse(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venda_preco_alvo_comprador(uuid) TO authenticated, service_role;

-- ── PÓS ──────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE v_src text; v_cfg text; v_acl text; v_ret record; v_f text;
BEGIN
  -- get_defasagem_cliente: semântica → md5 → config/ACL iguais aos de antes
  SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
         coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
    INTO v_src, v_cfg, v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
  IF v_src IS NULL THEN RAISE EXCEPTION 'POS: get_defasagem_cliente sumiu'; END IF;
  IF position('private._defasagem_item(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS_NUCLEO: get_defasagem_cliente não delega a private._defasagem_item';
  END IF;
  IF position('oi.desconto_valor AS disc_item' IN v_src) = 0 OR position('disc_item IS DISTINCT FROM 0' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS_DESC: a seleção da âncora perdeu o desconto real (20261014211500)';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '5b5c8206fcb4650f1180be3fb13eeeaf' THEN
    RAISE EXCEPTION 'POS: md5(prosrc)=% não é o corpo desta migration', md5(v_src);
  END IF;
  SELECT * INTO v_ret FROM pg_temp.repasse_def_retrato;
  IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: config/ACL de get_defasagem_cliente mudou — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_cfg, v_acl;
  END IF;

  -- helpers privados: ninguém além do dono executa
  FOREACH v_f IN ARRAY ARRAY[
    'private._defasagem_item(boolean,boolean,date,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric)',
    'private._venda_repasse_base(uuid)',
    'private._venda_repasse_sku_ok(bigint)'] LOOP
    IF has_function_privilege('anon', v_f, 'EXECUTE') OR has_function_privilege('authenticated', v_f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_HELPER: % executável por anon/authenticated', v_f;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_f)) THEN
      RAISE EXCEPTION 'POS_DEFINER_HELPER: % não deveria ser SECURITY DEFINER', v_f;
    END IF;
  END LOOP;

  -- RPCs: definer, search_path fixo, anon fechado, authenticated aberto
  FOREACH v_f IN ARRAY ARRAY[
    'public.venda_repasse_candidatos()',
    'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)',
    'public.venda_revogar_repasse(uuid)',
    'public.venda_preco_alvo_comprador(uuid)'] LOOP
    IF has_function_privilege('anon', v_f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_ANON: % executável por anon', v_f;
    END IF;
    IF NOT has_function_privilege('authenticated', v_f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_AUTH: % fechada para authenticated', v_f;
    END IF;
    IF NOT (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE 'search_path=%' FROM pg_proc WHERE oid = to_regprocedure(v_f)) THEN
      RAISE EXCEPTION 'POS_DEFINER: % sem SECURITY DEFINER ou sem search_path', v_f;
    END IF;
  END LOOP;

  -- tabela: RLS ligada, sem acesso direto, índice de 1 não-revogado por trio
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.venda_repasse_aprovado'::regclass) THEN
    RAISE EXCEPTION 'POS_RLS: venda_repasse_aprovado sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.venda_repasse_aprovado', 'SELECT')
     OR has_table_privilege('anon', 'public.venda_repasse_aprovado', 'SELECT')
     OR has_table_privilege('authenticated', 'public.venda_repasse_aprovado', 'INSERT') THEN
    RAISE EXCEPTION 'POS_TABELA_ACL: venda_repasse_aprovado acessível direto por anon/authenticated';
  END IF;
  IF to_regclass('public.venda_repasse_aprovado_vigente_uq') IS NULL THEN
    RAISE EXCEPTION 'POS_UQ: índice de 1 não-revogado por trio ausente';
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.repasse_def_retrato;
DROP TABLE IF EXISTS pg_temp.repasse_def_volatil;

COMMIT;
