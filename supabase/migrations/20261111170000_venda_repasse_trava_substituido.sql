-- 20261111170000_venda_repasse_trava_substituido.sql
-- ============================================================
-- Venda por cliente — repasse × substituição, 2ª leva (decisões do founder, 2026-11-09, sobre o #3469):
--   1. Janela de convivência = 3 cadências (era 365 dias), medidas pelo MAIS LENTO entre o item e a base irmã
--      (ritmo da irmã = mediana dos intervalos dela até a última compra do item; parecer Codex: item a cada 2 d ×
--      irmão mensal contínuo não é substituição). "Voltou ao produto de antes" (DEA → DEZ → DEA) passa a contar
--      como substituição; quem alterna nas últimas cadências segue convivendo. Medido em prod 09/11 (só com a
--      cadência do item): 2, 3 ou 4 cadências = os MESMOS 11 substituídos de hoje; o ritmo da irmã só AMPLIA a
--      janela (move substituído → parado, nunca o contrário) — a contagem final vai no PR, medida pós-apply.
--   2. TRAVA na aprovação: venda_aprovar_repasse recusa (22023 REPASSE_SUBSTITUIDO) o SKU que o cliente
--      substituiu. A regra sai de dentro dos candidatos para private._venda_repasse_situacao, chamada pelos DOIS
--      (uma regra só: o que a lista mostra como substituído é exatamente o que a aprovação recusa). Parado e
--      sem cadência continuam aprováveis (decisão do founder; nada provado).
-- venda_repasse_candidatos: mesma saída (chaves, ordem), só a janela muda. NÃO toca _venda_repasse_base,
-- venda_preco_alvo_comprador, venda_lista_preco, gerador nem Onda 3.
-- Molde: PRE (md5 medido na prod via psql-ro 2026-11-09: candidatos 12d7fff8…, aprovar 7e3c8dd5…, ou os
-- corpos desta) → CREATE → PÓS (md5 + config/ACL iguais + helper fechado). Sem BEGIN/COMMIT: a transação é do
-- `bun run db:aplicar`. ⚠️ migration manual (Lovable não auto-aplica).

CREATE TEMP TABLE IF NOT EXISTS repasse_trava_retrato (fn text NOT NULL, config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.repasse_trava_retrato;

DO $pre$
DECLARE v_f text; v_md5 text; v_cfg text; v_ok text[];
        v_h regprocedure := to_regprocedure('private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])');
BEGIN
  -- helper: ausente na 1ª aplicação; daí em diante só o corpo DESTA migration (re-colar não sobrescreve uma
  -- correção posterior da regra — parecer Codex 2026-11-09). Primeiro: a deriva dele é a mais silenciosa.
  IF v_h IS NOT NULL THEN
    SELECT coalesce(array_to_string(p.proconfig, ','), '-') INTO v_cfg FROM pg_catalog.pg_proc p WHERE p.oid = v_h;
    IF v_cfg IS DISTINCT FROM 'search_path=public, pg_temp' THEN
      RAISE EXCEPTION 'PRE_CONFIG: % com config inesperada antes da trava: %', v_h, v_cfg;
    END IF;
    ALTER FUNCTION private._venda_repasse_situacao(uuid[], bigint[], date[], numeric[]) SET search_path = public, pg_temp;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_h;
    IF v_md5 IS DISTINCT FROM '880fde236d6a1fce766018c38e42ddee' THEN
      RAISE EXCEPTION 'PRE_TRAVA_HELPER: % deriva — md5(prosrc)=% não é o corpo desta migration', v_h, v_md5;
    END IF;
  END IF;
  FOREACH v_f IN ARRAY ARRAY['public.venda_repasse_candidatos()', 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)'] LOOP
    IF to_regprocedure(v_f) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — aplique antes a 20261020233000 e a 20261031233000', v_f;
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
                 THEN ARRAY['12d7fff8f2c8dbd41403715f32cfb35c', '8753df515389250c82f1b287661079ec']
                 ELSE ARRAY['7e3c8dd5dde62a96b01f153c009010af', '20d3480890707542ed5554d282b8f2c1'] END;
    IF NOT (v_md5 = ANY (v_ok)) THEN
      RAISE EXCEPTION 'PRE_TRAVA: % deriva — md5(prosrc)=% não é o medido na prod nem o desta migration', v_f, v_md5;
    END IF;
    INSERT INTO pg_temp.repasse_trava_retrato
      SELECT v_f, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
                  || coalesce(array_to_string(p.proconfig, ','), '-'),
             coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
        FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_f);
  END LOOP;
END $pre$;

-- ── 1. A regra (uma só): situação de compra de itens comprador × SKU ──
CREATE OR REPLACE FUNCTION private._venda_repasse_situacao(
  p_compradores uuid[], p_skus bigint[], p_ancoras date[], p_cadencias numeric[])
 RETURNS TABLE(comprador_id uuid, omie_codigo_produto bigint, situacao text, sku_sub bigint, sub_codigo text,
               sub_descricao text, sub_primeira date, sub_ultima date, sub_dias bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- itens (comprador canônico × SKU Oben × última compra × cadência), em arrays paralelos
  WITH it AS (
    SELECT u.comprador_id, u.omie_codigo_produto, u.data_ancora, u.cadencia_dias,
           -- parado: passou de 2× a cadência; cadência ausente/não finita → NULL (não se afirma nada)
           CASE WHEN u.cadencia_dias > 0 AND private.regua_num_finito(u.cadencia_dias)
                THEN ((now() AT TIME ZONE 'America/Sao_Paulo')::date - u.data_ancora) > 2 * u.cadencia_dias END AS parado
      FROM unnest(p_compradores, p_skus, p_ancoras, p_cadencias) AS u(comprador_id, omie_codigo_produto, data_ancora, cadencia_dias)
  ),
  -- base = código da descrição sem a embalagem (DFA.4128LT → DFA.4128); sem código → NULL (não prova nada).
  -- Só famílias em que um SKU de outra base faz a MESMA função (medido 2026-10-31).
  prod AS MATERIALIZED (
    SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.familia,
           regexp_replace(substring(upper(op.descricao) FROM '[A-Z]{1,4}[0-9]{0,2}\.[0-9]{4}(?:\.[0-9A-Z]+)?'),
                          '[A-Z]+[0-9]?$', '') AS base
      FROM public.omie_products op
     WHERE op.account = 'oben'
       AND op.familia = ANY (ARRAY['Diluente PU', 'Retardador PU', 'Seladora Nitrocelulose',
                                   'Thinner de Limpeza Sayerlack', 'Thinner Nitrocelulose'])
  ),
  -- itens PARADOS com base provada numa família substituível
  cp AS MATERIALIZED (
    SELECT it.comprador_id, it.omie_codigo_produto, it.data_ancora, it.cadencia_dias, p.familia, p.base
      FROM it JOIN prod p ON p.omie_codigo_produto = it.omie_codigo_produto
     WHERE it.parado IS TRUE AND p.base IS NOT NULL
  ),
  -- dias de compra Oben por comprador × SKU (com base) dessas famílias, só dos compradores de cp — UMA linha
  -- por SKU com as datas num array (o cruzamento fica "itens × SKUs da família", não "× dias de compra")
  ds AS MATERIALIZED (
    SELECT l.comprador_id, p.familia, p.base, l.omie_codigo_produto, array_agg(DISTINCT l.data_pedido) AS datas
      FROM private.venda_linhas_pedido((now() AT TIME ZONE 'America/Sao_Paulo')::date + 1) l
      JOIN prod p ON p.omie_codigo_produto = l.omie_codigo_produto AND p.base IS NOT NULL
     WHERE l.empresa = 'oben' AND l.comprador_id IN (SELECT cp.comprador_id FROM cp)
     GROUP BY l.comprador_id, p.familia, p.base, l.omie_codigo_produto
  ),
  -- por item × BASE irmã (mesma família, outra base, qualquer embalagem): os dias de compra ATÉ a última compra
  -- do item — a última delas e o ritmo dela (mediana dos intervalos; < 2 dias → NULL, não se afirma ritmo)
  antes AS (
    SELECT DISTINCT cp.comprador_id, cp.omie_codigo_produto, ds.base, u.d
      FROM cp
      JOIN ds ON ds.comprador_id = cp.comprador_id AND ds.familia = cp.familia AND ds.base <> cp.base
      CROSS JOIN LATERAL unnest(ds.datas) AS u(d)
     WHERE u.d <= cp.data_ancora
  ),
  irm AS (
    SELECT g.comprador_id, g.omie_codigo_produto, g.base, max(g.d) AS ultima_antes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY g.intervalo) AS cad_irma
      FROM (SELECT a.*, a.d - lag(a.d) OVER (PARTITION BY a.comprador_id, a.omie_codigo_produto, a.base ORDER BY a.d)
                          AS intervalo
              FROM antes a) g
     GROUP BY g.comprador_id, g.omie_codigo_produto, g.base
  ),
  -- por SKU irmão: compras DEPOIS da última do item; a BASE dele convivia se foi comprada nas 3 cadências até a
  -- última compra do item, medindo a cadência pelo MAIS LENTO dos dois (item mensal × irmão semanal e vice-versa;
  -- teto 10 anos) — convivência contínua em ritmos diferentes não vira substituição (parecer Codex 2026-11-09)
  -- (20261111170000: era 365 d; "voltou ao produto de antes" agora conta como substituição — decisão do founder)
  sub AS (
    SELECT cp.comprador_id, cp.omie_codigo_produto, ds.omie_codigo_produto AS sku_sub, x.primeira, x.ultima, x.n_dias,
           COALESCE(irm.ultima_antes >= cp.data_ancora
                      - least(ceil(3 * greatest(cp.cadencia_dias, coalesce(irm.cad_irma, 0))), 3650)::int,
                    false) AS convivia
      FROM cp
      JOIN ds ON ds.comprador_id = cp.comprador_id AND ds.familia = cp.familia AND ds.base <> cp.base
      LEFT JOIN irm ON irm.comprador_id = cp.comprador_id AND irm.omie_codigo_produto = cp.omie_codigo_produto
                   AND irm.base = ds.base
      CROSS JOIN LATERAL (
        SELECT min(u.d) FILTER (WHERE u.d > cp.data_ancora) AS primeira,
               max(u.d) FILTER (WHERE u.d > cp.data_ancora) AS ultima,
               count(*) FILTER (WHERE u.d > cp.data_ancora) AS n_dias
          FROM unnest(ds.datas) AS u(d)
      ) x
  ),
  s1 AS (   -- o substituto exposto: mais dias de compra; empate → compra mais recente → menor código
    SELECT DISTINCT ON (s.comprador_id, s.omie_codigo_produto) s.*, p.codigo, p.descricao
      FROM sub s JOIN prod p ON p.omie_codigo_produto = s.sku_sub
     WHERE s.convivia IS FALSE AND s.n_dias > 0
     ORDER BY s.comprador_id, s.omie_codigo_produto, s.n_dias DESC, s.ultima DESC, s.sku_sub
  )
  SELECT it.comprador_id, it.omie_codigo_produto,
         CASE WHEN it.parado IS NULL THEN NULL
              WHEN s1.sku_sub IS NOT NULL THEN 'substituido'
              WHEN it.parado THEN 'parado'
              ELSE 'comprando' END,
         s1.sku_sub, s1.codigo, s1.descricao, s1.primeira, s1.ultima, s1.n_dias
    FROM it
    LEFT JOIN s1 ON s1.comprador_id = it.comprador_id AND s1.omie_codigo_produto = it.omie_codigo_produto
$function$;

REVOKE ALL ON FUNCTION private._venda_repasse_situacao(uuid[], bigint[], date[], numeric[]) FROM PUBLIC, anon, authenticated;

-- ── 2. Candidatos: a situação vem da regra única (só a janela muda) ──
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
  f AS (
    SELECT c.*, s.situacao, s.sku_sub, s.sub_codigo, s.sub_descricao, s.sub_primeira, s.sub_ultima, s.sub_dias
      FROM c
      LEFT JOIN sit s ON s.comprador_id = c.comprador_id AND s.omie_codigo_produto = c.omie_codigo_produto
  ),
  g AS (
    SELECT f.*,
           -- substituído não é repasse: sem sugerido e sem valor anual (o sinal de piso e a defasagem ficam)
           CASE WHEN f.situacao = 'substituido' THEN NULL ELSE f.sugerido END AS sugerido_final,
           CASE WHEN f.situacao IS DISTINCT FROM 'substituido'
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
                    g.valor_anual DESC NULLS LAST, g.comprador_id, g.omie_codigo_produto), '[]'::jsonb)
    INTO v_out
    FROM g;

  RETURN v_out;
END;
$function$;

-- ── 3. Aprovar: recusa o substituído ──
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
  v_cad numeric;
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
  SELECT b.ultimo_preco, b.data_ancora INTO v_ultimo, v_ancora
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

  -- substituído não é repasse (20261111170000): o cliente parou o SKU e passou a comprar outro da mesma função.
  -- MESMA regra da lista de candidatos; sem cadência na recompra → situação NULL → não se recusa (nada provado)
  SELECT r.cadencia_dias INTO v_cad FROM public.venda_recompra r
   WHERE r.comprador_id = v_comprador AND r.empresa = 'oben' AND r.omie_codigo_produto = p_codigo;
  SELECT s.situacao, s.sub_codigo, s.sub_primeira INTO v_sit
    FROM private._venda_repasse_situacao(ARRAY[v_comprador], ARRAY[p_codigo], ARRAY[v_ancora], ARRAY[v_cad]) s;
  IF v_sit.situacao IS NOT DISTINCT FROM 'substituido' THEN
    RAISE EXCEPTION 'REPASSE_SUBSTITUIDO: o cliente trocou o SKU % por % (desde %) - nao e repasse',
      p_codigo, coalesce(v_sit.sub_codigo, '?'), v_sit.sub_primeira USING ERRCODE = '22023';
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

DO $pos$
DECLARE v_r record; v_src text; v_cfg text; v_acl text; v_esperado text; v_h text := 'private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])';
BEGIN
  FOR v_r IN SELECT * FROM pg_temp.repasse_trava_retrato LOOP
    SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      INTO v_src, v_cfg, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_r.fn);
    v_esperado := CASE WHEN v_r.fn LIKE 'public.venda_repasse_candidatos%' THEN '8753df515389250c82f1b287661079ec' ELSE '20d3480890707542ed5554d282b8f2c1' END;
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
  IF (SELECT count(*) FROM pg_temp.repasse_trava_retrato) <> 2 THEN RAISE EXCEPTION 'POS: retrato incompleto'; END IF;
  -- helper: privado, sem DEFINER, fechado a anon/authenticated
  IF has_function_privilege('anon', v_h, 'EXECUTE') OR has_function_privilege('authenticated', v_h, 'EXECUTE')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_h)) THEN
    RAISE EXCEPTION 'POS_ACL_HELPER: % executável por anon/authenticated ou SECURITY DEFINER', v_h;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v_h)) IS DISTINCT FROM '880fde236d6a1fce766018c38e42ddee' THEN
    RAISE EXCEPTION 'POS: % md5(prosrc) não é o corpo desta migration', v_h;
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.repasse_trava_retrato;
