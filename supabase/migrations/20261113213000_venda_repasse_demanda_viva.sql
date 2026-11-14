-- 20261113213000_venda_repasse_demanda_viva.sql
-- ============================================================
-- Venda por cliente — rodada 2, Entrega 5 (aprovada pelo founder em 12/11/2026): repasse só em DEMANDA VIVA.
--   1. Parado e sem cadência saem do repasse: sem preço sugerido, sem valor anual e com a aprovação RECUSADA no
--      servidor (22023 REPASSE_PARADO / REPASSE_SEM_CADENCIA), pela MESMA regra única que já recusa o
--      substituído (private._venda_repasse_situacao, 20261111170000 — não é recriada aqui). "Vivo" = situação
--      'comprando' = dias desde a última compra <= 2× a cadência (a régua vigente; nenhuma régua nova). O valor
--      anual só existe no vivo: o "recuperável" do painel passa a somar só demanda viva. Reverte a decisão de
--      09/11 ("parado e sem cadência seguem aprováveis") por decisão da rodada 2 + parecer Codex (anualizar a
--      cadência de item parado é receita imaginária; ausência de prova não autoriza repasse).
--   2. Encaminhamento do parado: o gerador JÁ o cobre — atrasado = 2×dias >= 3×cadência, sem teto (medido em
--      13/11: 56 de 57 parados sugeridos como recompra ativa nos 7 dias anteriores; o restante sem farmer na
--      carteira). Não se toca no gerador; a lista mostra a prova: 'recompra_sugerida_em' = último dia em que o
--      SKU entrou na lista ATIVA da farmer como recompra (NULL = sem registro; não é "foi trabalhado").
--   3. Ordem: vivo primeiro, pela compra MAIS RECENTE (data da última compra DESC), depois valor.
--   4. Sensor do repasse aprovado: public.venda_repasse_sensor() — por versão aprovada, a quantidade vendida
--      ao preço novo ÷ a quantidade elegível (comprada) na janela, e o critério de desligar (perda de volume
--      >= ganho de preço, na mesma base tributária). A linha de base é CONGELADA na aprovação (cadência,
--      quantidade de referência, última compra e custo): a cadência atual absorveria a própria queda que se
--      quer medir (parecer Codex). Colunas novas em venda_repasse_aprovado, todas NULL nas linhas antigas
--      (0 linhas na prod em 13/11) — ausente ≠ zero: sem linha de base o veredito é 'indisponivel'.
-- NÃO toca _venda_repasse_base, _venda_repasse_situacao, venda_preco_alvo_comprador, gerador nem Onda 3.
-- Molde: TRAVA → PRE (md5 medido na prod via psql-ro 2026-11-13: candidatos 8753df51…, aprovar 20d34808…,
-- helper 880fde23…, ou os corpos desta) → CREATE → PÓS (md5 + config/ACL + regra única + helper intacto).
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`. ⚠️ migration manual (Lovable não auto-aplica).

CREATE TEMP TABLE IF NOT EXISTS repasse_vivo_retrato (fn text NOT NULL, config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.repasse_vivo_retrato;

DO $pre$
DECLARE v_f text; v_md5 text; v_cfg text; v_ok text[];
        v_h regprocedure := to_regprocedure('private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])');
        v_s regprocedure := to_regprocedure('public.venda_repasse_sensor()');
BEGIN
  -- a regra única é PRÉ-REQUISITO (não é recriada): tem de ser o corpo da 20261111170000
  IF v_h IS NULL THEN
    RAISE EXCEPTION 'PRE: private._venda_repasse_situacao ausente — aplique antes a 20261111170000';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_h;
  IF v_md5 IS DISTINCT FROM '880fde236d6a1fce766018c38e42ddee' THEN
    RAISE EXCEPTION 'PRE_HELPER: % deriva — md5(prosrc)=% não é o da 20261111170000', v_h, v_md5;
  END IF;
  -- sensor: ausente na 1ª aplicação; daí em diante só o corpo DESTA migration
  IF v_s IS NOT NULL THEN
    SELECT coalesce(array_to_string(p.proconfig, ','), '-') INTO v_cfg FROM pg_catalog.pg_proc p WHERE p.oid = v_s;
    IF v_cfg IS DISTINCT FROM 'search_path=public, pg_temp' THEN
      RAISE EXCEPTION 'PRE_CONFIG: % com config inesperada antes da trava: %', v_s, v_cfg;
    END IF;
    ALTER FUNCTION public.venda_repasse_sensor() SET search_path = public, pg_temp;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_s;
    IF v_md5 IS DISTINCT FROM 'c82b33288c3879dc6a1b63813dab78c3' THEN
      RAISE EXCEPTION 'PRE_TRAVA_SENSOR: % deriva — md5(prosrc)=% não é o corpo desta migration', v_s, v_md5;
    END IF;
  END IF;
  FOREACH v_f IN ARRAY ARRAY['public.venda_repasse_candidatos()', 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)'] LOOP
    IF to_regprocedure(v_f) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — aplique antes a cadeia do repasse (20261020233000 … 20261111170000)', v_f;
    END IF;
    -- config lida ANTES da trava (que a reescreve): deriva prévia não é normalizada em silêncio
    SELECT coalesce(array_to_string(p.proconfig, ','), '-') INTO v_cfg FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_f);
    IF v_cfg IS DISTINCT FROM 'search_path=public, pg_temp' THEN
      RAISE EXCEPTION 'PRE_CONFIG: % com config inesperada antes da trava: %', v_f, v_cfg;
    END IF;
  END LOOP;
  -- trava as linhas de pg_proc antes de medir (CREATE concorrente espera); reescreve o MESMO valor conferido
  ALTER FUNCTION public.venda_repasse_candidatos() SET search_path = public, pg_temp;
  ALTER FUNCTION public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid) SET search_path = public, pg_temp;
  FOREACH v_f IN ARRAY ARRAY['public.venda_repasse_candidatos()', 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)'] LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_f);
    v_ok := CASE WHEN v_f LIKE 'public.venda_repasse_candidatos%'
                 THEN ARRAY['8753df515389250c82f1b287661079ec', '3679078c645ae6090153678ab1300961']
                 ELSE ARRAY['20d3480890707542ed5554d282b8f2c1', '4f9b0f18f2ed6d5d44d5c5d792f4c94d'] END;
    IF NOT (v_md5 = ANY (v_ok)) THEN
      RAISE EXCEPTION 'PRE_TRAVA: % deriva — md5(prosrc)=% não é o medido na prod nem o desta migration', v_f, v_md5;
    END IF;
    INSERT INTO pg_temp.repasse_vivo_retrato
      SELECT v_f, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
                  || coalesce(array_to_string(p.proconfig, ','), '-'),
             coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
        FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_f);
  END LOOP;
END $pre$;

-- ── 1. Linha de base do sensor, congelada na aprovação (NULL nas linhas antigas: ausente ≠ zero) ──
ALTER TABLE public.venda_repasse_aprovado
  ADD COLUMN IF NOT EXISTS cadencia_na_aprovacao numeric,
  ADD COLUMN IF NOT EXISTS qtd_ref_na_aprovacao numeric,
  ADD COLUMN IF NOT EXISTS ultima_compra_na_aprovacao date,
  ADD COLUMN IF NOT EXISTS custo_na_aprovacao numeric;
COMMENT ON COLUMN public.venda_repasse_aprovado.cadencia_na_aprovacao IS
  'Cadência (dias) do comprador×SKU em venda_recompra no instante da aprovação — linha de base do sensor (20261113213000).';
COMMENT ON COLUMN public.venda_repasse_aprovado.qtd_ref_na_aprovacao IS
  'Quantidade por compra (qtd_sugerida de venda_recompra) na aprovação — linha de base do sensor.';
COMMENT ON COLUMN public.venda_repasse_aprovado.ultima_compra_na_aprovacao IS
  'Data da última compra ao vivo na aprovação.';
COMMENT ON COLUMN public.venda_repasse_aprovado.custo_na_aprovacao IS
  'Custo atual FRESCO (c_now de _venda_repasse_base) na aprovação; NULL se não havia custo fresco.';

-- ── 2. Candidatos: valor e sugerido só no vivo; prova do encaminhamento do parado; ordem por compra recente ──
CREATE OR REPLACE FUNCTION public.venda_repasse_candidatos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
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
           op.descricao, op.familia,
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
    SELECT b.* FROM b WHERE b.status_defasagem = 'defasado' OR b.abaixo_piso IS TRUE
  ),
  -- situação de compra: a MESMA regra que a aprovação usa para recusar (private._venda_repasse_situacao)
  arr AS (
    SELECT array_agg(c.comprador_id ORDER BY c.comprador_id, c.omie_codigo_produto) AS compradores,
           array_agg(c.omie_codigo_produto ORDER BY c.comprador_id, c.omie_codigo_produto) AS skus,
           array_agg(c.data_ancora ORDER BY c.comprador_id, c.omie_codigo_produto) AS ancoras,
           array_agg(c.cadencia_dias ORDER BY c.comprador_id, c.omie_codigo_produto) AS cadencias
      FROM c
  ),
  sit AS MATERIALIZED (
    SELECT s.* FROM arr CROSS JOIN LATERAL private._venda_repasse_situacao(arr.compradores, arr.skus, arr.ancoras, arr.cadencias) s
  ),
  -- encaminhamento à farmer: último dia em que o SKU entrou na lista ATIVA como recompra (uma varredura só)
  enc AS (
    SELECT vs.comprador_id, vs.omie_codigo_produto, max(vs.dia_referencia) AS ultimo_dia
      FROM public.venda_sugestao vs
     WHERE vs.tipo = 'recompra' AND vs.fase = 'ativa' AND vs.empresa = 'oben'
       AND vs.comprador_id IN (SELECT c.comprador_id FROM c)
     GROUP BY vs.comprador_id, vs.omie_codigo_produto
  ),
  f AS (
    SELECT c.*, s.situacao, s.sku_sub, s.sub_codigo, s.sub_descricao, s.sub_primeira, s.sub_ultima, s.sub_dias,
           e.ultimo_dia AS recompra_sugerida_em,
           (s.situacao = 'comprando') IS TRUE AS viva
      FROM c
      LEFT JOIN sit s ON s.comprador_id = c.comprador_id AND s.omie_codigo_produto = c.omie_codigo_produto
      LEFT JOIN enc e ON e.comprador_id = c.comprador_id AND e.omie_codigo_produto = c.omie_codigo_produto
  ),
  g AS (
    SELECT f.*,
           -- só a demanda VIVA é repasse (20261113213000): parado, substituído e sem cadência ficam sem sugerido e
           -- sem valor anual (o sinal de piso e a defasagem ficam)
           CASE WHEN f.viva THEN f.sugerido END AS sugerido_final,
           CASE WHEN f.viva
                     AND f.sugerido IS NOT NULL AND f.qtd_sugerida > 0 AND f.cadencia_dias > 0
                     AND private.regua_num_finito(f.qtd_sugerida) AND private.regua_num_finito(f.cadencia_dias)
                THEN round(f.qtd_sugerida * 365 / f.cadencia_dias * (f.sugerido - f.ultimo_preco), 2)
           END AS valor_anual
      FROM f
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'comprador_id',            g.comprador_id,
           'empresa',                 'oben',
           'omie_codigo_produto',     g.omie_codigo_produto,
           'descricao',               g.descricao,
           'status_defasagem',        g.status_defasagem,
           'motivo',                  g.motivo,
           'abaixo_piso',             g.abaixo_piso,
           'ultimo_preco',            round(g.ultimo_preco, 4),
           'data_ultima_compra',      g.data_ancora,
           'preco_sugerido',          g.sugerido_final,
           'alta_custo_perc',         round(g.alta_custo_perc, 2),
           'valor_anual_recuperavel', g.valor_anual,
           -- evidência (o master tem a capacidade de custo — gate acima)
           'c_last',                  g.c_last,
           'c_now',                   g.c_now,
           'n_pedidos',               g.n_pedidos,
           'cadencia_dias',           g.cadencia_dias,
           'qtd_sugerida',            g.qtd_sugerida,
           'situacao_compra',         g.situacao,
           'demanda_viva',            g.viva,
           'recompra_sugerida_em',    g.recompra_sugerida_em,
           'dias_sem_comprar',        v_hoje - g.data_ancora,
           'substituto', CASE WHEN g.sku_sub IS NOT NULL THEN jsonb_build_object(
                                'omie_codigo_produto', g.sku_sub,
                                'codigo',              g.sub_codigo,
                                'descricao',           g.sub_descricao,
                                'primeira_compra',     g.sub_primeira,
                                'ultima_compra',       g.sub_ultima,
                                'dias_com_compra',     g.sub_dias) END,
           -- a VERSÃO do trio = o registro mais recente (revogado ou não): é o que a tela devolve em p_substitui
           'repasse_atual', (
             SELECT jsonb_build_object('id', ra.id, 'preco_alvo', ra.preco_alvo, 'valido_ate', ra.valido_ate,
                                       'revogado', ra.revogado_em IS NOT NULL,
                                       'vigente', ra.revogado_em IS NULL
                                                  AND ra.valido_ate >= v_hoje)
               FROM public.venda_repasse_aprovado ra
              WHERE ra.comprador_id = g.comprador_id AND ra.empresa = 'oben'
                AND ra.omie_codigo_produto = g.omie_codigo_produto
              ORDER BY ra.aprovado_em DESC, ra.id DESC
              LIMIT 1)
         ) ORDER BY CASE g.situacao WHEN 'comprando' THEN 0 WHEN 'parado' THEN 1 WHEN 'substituido' THEN 2 ELSE 3 END,
                    -- vivo: compra mais recente primeiro (o founder aprova primeiro quem acabou de comprar)
                    CASE WHEN g.viva THEN g.data_ancora END DESC NULLS LAST,
                    g.valor_anual DESC NULLS LAST, g.comprador_id, g.omie_codigo_produto), '[]'::jsonb)
    INTO v_out
    FROM g;

  RETURN v_out;
END;
$function$;

-- ── 3. Aprovar: só demanda viva; congela a linha de base do sensor ──
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
  v_ancora date;
  v_c_now numeric;
  v_c_fresco boolean;
  v_cad numeric;
  v_qtd numeric;
  v_sit record;
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
  SELECT b.ultimo_preco, b.data_ancora, b.c_now, b.c_now_fresco INTO v_ultimo, v_ancora, v_c_now, v_c_fresco
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

  -- só demanda VIVA é repasse (20261113213000). MESMA regra da lista de candidatos (private._venda_repasse_situacao):
  -- substituído (trocou de SKU), parado (> 2x a cadência sem compra) e sem cadência (nada provado) são recusados.
  SELECT r.cadencia_dias, r.qtd_sugerida INTO v_cad, v_qtd FROM public.venda_recompra r
   WHERE r.comprador_id = v_comprador AND r.empresa = 'oben' AND r.omie_codigo_produto = p_codigo;
  SELECT s.situacao, s.sub_codigo, s.sub_primeira INTO v_sit
    FROM private._venda_repasse_situacao(ARRAY[v_comprador], ARRAY[p_codigo], ARRAY[v_ancora], ARRAY[v_cad]) s;
  IF v_sit.situacao IS NOT DISTINCT FROM 'substituido' THEN
    RAISE EXCEPTION 'REPASSE_SUBSTITUIDO: o cliente trocou o SKU % por % (desde %) - nao e repasse',
      p_codigo, coalesce(v_sit.sub_codigo, '?'), v_sit.sub_primeira USING ERRCODE = '22023';
  END IF;
  IF v_sit.situacao IS NOT DISTINCT FROM 'parado' THEN
    RAISE EXCEPTION 'REPASSE_PARADO: o cliente nao compra o SKU % ha % dias (mais de 2x a cadencia de % d) - e recompra, nao repasse',
      p_codigo, v_hoje - v_ancora, round(v_cad, 1) USING ERRCODE = '22023';
  END IF;
  IF v_sit.situacao IS DISTINCT FROM 'comprando' THEN
    RAISE EXCEPTION 'REPASSE_SEM_CADENCIA: sem cadencia de compra provada para o SKU % - nao da para dizer que a demanda esta viva',
      p_codigo USING ERRCODE = '22023';
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

  -- linha de base do sensor, congelada AGORA (custo só se fresco e finito; quantidade/cadência só se finitas > 0)
  INSERT INTO public.venda_repasse_aprovado
    (comprador_id, empresa, omie_codigo_produto, preco_alvo, ultimo_preco_na_aprovacao, valido_ate,
     aprovado_por, aprovado_em, substitui_id,
     cadencia_na_aprovacao, qtd_ref_na_aprovacao, ultima_compra_na_aprovacao, custo_na_aprovacao)
  VALUES (v_comprador, 'oben', p_codigo, p_preco_alvo, v_ultimo, p_valido_ate, v_uid, clock_timestamp(), p_substitui,
          CASE WHEN v_cad > 0 AND private.regua_num_finito(v_cad) THEN v_cad END,
          CASE WHEN v_qtd > 0 AND private.regua_num_finito(v_qtd) THEN v_qtd END,
          v_ancora,
          CASE WHEN v_c_fresco AND v_c_now > 0 AND private.regua_num_finito(v_c_now) THEN v_c_now END)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ── 4. Sensor do repasse aprovado ──
-- Por VERSÃO aprovada (vigente ou não). Janela = dias de pedido em (dia da aprovação, fim], fim = o MENOR entre o
-- dia da revogação, a validade e hoje (SP): o dia da aprovação fica de fora (venda_linhas_pedido só tem DATA —
-- não prova que o pedido veio depois do aprovar) e versões do mesmo trio não se sobrepõem (a nova começa no dia
-- seguinte ao da revogação da anterior).
--   qtd_elegivel        = tudo o que o comprador canônico comprou do SKU (Oben) na janela, preço conhecido ou não
--   qtd_ao_preco_novo   = a parte com preço líquido >= alvo (meio centavo de tolerância de arredondamento)
--   razao_preco_novo    = qtd_ao_preco_novo / qtd_elegivel; NULL se elegível 0 ou se há quantidade sem preço
--   ganho_preco         = Σ qtd × (preço − último na aprovação) × (1 − alíquota), TODAS as linhas com preço
--                         (aumento parcial conta; desconto abaixo do preço antigo entra negativo); NULL se há
--                         quantidade sem preço (desconhecido, não o subtotal)
--   perda_volume        = max(qtd_esperada − qtd_elegivel, 0) × (último × (1 − alíquota) − custo na aprovação)
--                         qtd_esperada = qtd_ref × dias_janela / cadência — ambas CONGELADAS na aprovação
--   criterio_desligar   = 'cedo' (janela < 1 cadência) · 'indisponivel' (sem linha de base, custo, margem
--                         positiva ou com quantidade sem preço) · 'atingido' (perda > 0 e perda >= ganho: a perda de
--                         volume anula o ganho → revisar/revogar) · 'nao_atingido'
-- É referência ESTIMADA (a cadência é a de antes), não prova causal — o founder decide; nada desliga sozinho.
CREATE OR REPLACE FUNCTION public.venda_repasse_sensor()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_aliq numeric;
  v_out jsonb;
BEGIN
  -- mesma porta dos candidatos: o resultado usa custo
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role)
     OR NOT private.cap_custo_ler(v_uid) THEN
    RAISE EXCEPTION 'venda_repasse_sensor: requer master com capacidade de custo' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE((SELECT cc.value::numeric FROM public.company_config cc
                    WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliq;

  WITH ap AS (
    SELECT ra.*,
           (ra.aprovado_em AT TIME ZONE 'America/Sao_Paulo')::date AS ini,
           least(coalesce((ra.revogado_em AT TIME ZONE 'America/Sao_Paulo')::date, v_hoje), ra.valido_ate, v_hoje) AS fim
      FROM public.venda_repasse_aprovado ra
     WHERE ra.empresa = 'oben'
  ),
  lin AS (
    SELECT l.comprador_id, l.omie_codigo_produto, l.data_pedido, l.quantidade, l.preco_unit_liquido
      FROM private.venda_linhas_pedido(v_hoje + 1) l
     WHERE l.empresa = 'oben' AND l.comprador_id IN (SELECT ap.comprador_id FROM ap)
  ),
  m AS (
    SELECT ap.*,
           greatest(ap.fim - ap.ini, 0) AS dias_janela,
           x.qtd_elegivel, x.qtd_ao_preco_novo, x.qtd_sem_preco, x.ganho_bruto
      FROM ap
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(l.quantidade), 0) AS qtd_elegivel,
               COALESCE(sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido >= ap.preco_alvo - 0.005), 0) AS qtd_ao_preco_novo,
               COALESCE(sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido IS NULL
                                                     OR NOT private.regua_num_finito(l.preco_unit_liquido)), 0) AS qtd_sem_preco,
               COALESCE(sum(l.quantidade * (l.preco_unit_liquido - ap.ultimo_preco_na_aprovacao))
                          FILTER (WHERE private.regua_num_finito(l.preco_unit_liquido)), 0) AS ganho_bruto
          FROM lin l
         WHERE l.comprador_id = ap.comprador_id AND l.omie_codigo_produto = ap.omie_codigo_produto
           AND l.data_pedido > ap.ini AND l.data_pedido <= ap.fim
      ) x
  ),
  v AS (
    SELECT m.*,
           CASE WHEN m.qtd_elegivel > 0 AND m.qtd_sem_preco = 0
                THEN round(m.qtd_ao_preco_novo / m.qtd_elegivel, 4) END AS razao,
           -- precisão cheia no cálculo; o arredondamento é só da saída (um intermediário arredondado inverte o
           -- veredito na borda — parecer Codex 2026-11-13)
           CASE WHEN m.qtd_ref_na_aprovacao > 0 AND m.cadencia_na_aprovacao > 0
                THEN m.qtd_ref_na_aprovacao * m.dias_janela / m.cadencia_na_aprovacao END AS qtd_esp,
           CASE WHEN m.custo_na_aprovacao > 0
                THEN m.ultimo_preco_na_aprovacao * (1 - v_aliq) - m.custo_na_aprovacao END AS margem_unit,
           -- com quantidade sem preço o ganho é DESCONHECIDO (NULL), não o subtotal das linhas com preço
           CASE WHEN m.qtd_sem_preco = 0 THEN m.ganho_bruto * (1 - v_aliq) END AS ganho
      FROM m
  ),
  w AS (
    SELECT v.*,
           CASE WHEN v.qtd_esp IS NOT NULL AND v.margem_unit > 0
                THEN greatest(v.qtd_esp - v.qtd_elegivel, 0) * v.margem_unit END AS perda
      FROM v
  ),
  z AS (
    SELECT w.*,
           CASE WHEN w.cadencia_na_aprovacao IS NULL OR w.qtd_ref_na_aprovacao IS NULL THEN 'indisponivel'
                WHEN w.dias_janela < w.cadencia_na_aprovacao THEN 'cedo'
                WHEN w.perda IS NULL OR w.ganho IS NULL THEN 'indisponivel'
                WHEN w.perda > 0 AND w.perda >= w.ganho THEN 'atingido'
                ELSE 'nao_atingido' END AS criterio,
           CASE WHEN w.cadencia_na_aprovacao IS NULL OR w.qtd_ref_na_aprovacao IS NULL THEN 'sem_linha_de_base'
                WHEN w.dias_janela < w.cadencia_na_aprovacao THEN 'janela_menor_que_cadencia'
                WHEN w.custo_na_aprovacao IS NULL THEN 'sem_custo_na_aprovacao'
                WHEN w.margem_unit IS NULL OR w.margem_unit <= 0 THEN 'margem_nao_positiva'
                WHEN w.qtd_sem_preco > 0 THEN 'quantidade_sem_preco'
                END AS motivo
      FROM w
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',                        z.id,
           'comprador_id',              z.comprador_id,
           'empresa',                   z.empresa,
           'omie_codigo_produto',       z.omie_codigo_produto,
           'descricao',                 op.descricao,
           'preco_alvo',                z.preco_alvo,
           'ultimo_preco_na_aprovacao', round(z.ultimo_preco_na_aprovacao, 4),
           'aprovado_em',               z.aprovado_em,
           'valido_ate',                z.valido_ate,
           'revogado_em',               z.revogado_em,
           'vigente',                   z.revogado_em IS NULL AND z.valido_ate >= v_hoje,
           'dias_janela',               z.dias_janela,
           'cadencia_na_aprovacao',     z.cadencia_na_aprovacao,
           'qtd_elegivel',              z.qtd_elegivel,
           'qtd_ao_preco_novo',         z.qtd_ao_preco_novo,
           'qtd_sem_preco',             z.qtd_sem_preco,
           'razao_preco_novo',          z.razao,
           'qtd_esperada',              round(z.qtd_esp, 2),
           'ganho_preco',               round(z.ganho, 2),
           'perda_volume',              round(z.perda, 2),
           'criterio_desligar',         z.criterio,
           'motivo',                    z.motivo
         ) ORDER BY (z.revogado_em IS NULL AND z.valido_ate >= v_hoje) DESC, z.aprovado_em DESC, z.id), '[]'::jsonb)
    INTO v_out
    FROM z
    LEFT JOIN public.omie_products op ON op.omie_codigo_produto = z.omie_codigo_produto AND op.account = 'oben';

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.venda_repasse_sensor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_repasse_sensor() TO authenticated, service_role;

DO $pos$
DECLARE v_r record; v_src text; v_cfg text; v_acl text; v_esperado text;
        v_h text := 'private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])';
        v_s text := 'public.venda_repasse_sensor()';
BEGIN
  FOR v_r IN SELECT * FROM pg_temp.repasse_vivo_retrato LOOP
    SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      INTO v_src, v_cfg, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_r.fn);
    v_esperado := CASE WHEN v_r.fn LIKE 'public.venda_repasse_candidatos%' THEN '3679078c645ae6090153678ab1300961' ELSE '4f9b0f18f2ed6d5d44d5c5d792f4c94d' END;
    IF md5(v_src) IS DISTINCT FROM v_esperado THEN
      RAISE EXCEPTION 'POS: % md5(prosrc)=% não é o corpo desta migration', v_r.fn, md5(v_src);
    END IF;
    IF position('private._venda_repasse_situacao(' IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS_REGRA: % não usa a regra única private._venda_repasse_situacao', v_r.fn;
    END IF;
    IF v_r.config IS DISTINCT FROM v_cfg OR v_r.acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'POS: config/ACL de % mudou — antes [%|%], depois [%|%]', v_r.fn, v_r.config, v_r.acl, v_cfg, v_acl;
    END IF;
    IF has_function_privilege('anon', v_r.fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL: % deveria fechar anon e abrir authenticated', v_r.fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_temp.repasse_vivo_retrato) <> 2 THEN RAISE EXCEPTION 'POS: retrato incompleto'; END IF;
  -- sensor: corpo desta migration, DEFINER com search_path fixo, fechado a anon/PUBLIC, aberto a authenticated
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v_s)) IS DISTINCT FROM 'c82b33288c3879dc6a1b63813dab78c3' THEN
    RAISE EXCEPTION 'POS: % md5(prosrc) não é o corpo desta migration', v_s;
  END IF;
  IF (SELECT NOT prosecdef OR coalesce(array_to_string(proconfig, ','), '-') <> 'search_path=public, pg_temp'
        FROM pg_proc WHERE oid = to_regprocedure(v_s)) THEN
    RAISE EXCEPTION 'POS_CONFIG: % deveria ser SECURITY DEFINER com search_path=public, pg_temp', v_s;
  END IF;
  IF has_function_privilege('anon', v_s, 'EXECUTE') OR has_function_privilege('public', v_s, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_s, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS_ACL_SENSOR: % deveria fechar anon/PUBLIC e abrir authenticated', v_s;
  END IF;
  -- a regra única não foi tocada
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v_h)) IS DISTINCT FROM '880fde236d6a1fce766018c38e42ddee' THEN
    RAISE EXCEPTION 'POS: % mudou — esta migration não recria a regra única', v_h;
  END IF;
  -- as 4 colunas da linha de base existem com o TIPO certo (numeric sem escala; date), nulas e sem default
  -- (ausente ≠ zero; uma coluna preexistente integer arredondaria a cadência congelada — parecer Codex)
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'venda_repasse_aprovado'
         AND ((column_name IN ('cadencia_na_aprovacao', 'qtd_ref_na_aprovacao', 'custo_na_aprovacao')
               AND data_type = 'numeric' AND numeric_precision IS NULL AND numeric_scale IS NULL)
              OR (column_name = 'ultima_compra_na_aprovacao' AND data_type = 'date'))
         AND is_nullable = 'YES' AND column_default IS NULL) <> 4 THEN
    RAISE EXCEPTION 'POS_COLUNAS: linha de base do sensor incompleta em venda_repasse_aprovado';
  END IF;
  IF has_table_privilege('authenticated', 'public.venda_repasse_aprovado', 'SELECT') THEN
    RAISE EXCEPTION 'POS_ACL_TABELA: venda_repasse_aprovado não pode abrir a authenticated';
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.repasse_vivo_retrato;
