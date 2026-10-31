-- 20261031233000_venda_repasse_substituicao.sql
-- ============================================================
-- Venda por cliente (Task 6, PR #3259): venda_repasse_candidatos() deixa de sugerir repasse num SKU que o
-- cliente SUBSTITUIU por outro de mesma função, e diz se o cliente ainda compra o SKU.
--
-- Regra do founder (2026-10-31): repasse faz sentido quando o cliente segue comprando aquele item e nenhum
-- outro entrou para substituí-lo. Ex.: a Oben passou o cliente de um diluente para outro mais barato mantendo
-- o preço de venda — pedir repasse no SKU antigo é errado. Exceção legítima: quem compra vários da mesma
-- função ao mesmo tempo (convive) não pode ser descartado.
--
-- Cada candidato ganha `situacao_compra` (o candidato em si NÃO some: um repasse vigente segue revogável):
--   'comprando'   — última compra até 2× a cadência (venda_recompra.cadencia_dias) atrás;
--   'parado'      — passou de 2× a cadência e não há substituto provado: sinal, o sugerido fica (a decisão é
--                   do founder; pode ser recompra perdida que volta);
--   'substituido' — parado E um SKU de OUTRA base da MESMA família (só famílias de função única, abaixo)
--                   foi comprado DEPOIS da última compra do candidato sem ter sido comprado nos 365 dias até
--                   ela (base que convivia não substitui). Sai da sugestão: preco_sugerido e
--                   valor_anual_recuperavel = NULL; `substituto` expõe o SKU que entrou;
--   NULL          — cadência ausente/não finita (ausente ≠ zero: não se afirma nem "comprando").
-- Base = código Sayerlack da descrição sem a embalagem (DFA.4128LT/QT/L5 → DFA.4128): mesma base em outra
-- embalagem NÃO é substituto. Sem código na descrição → sem base → não entra como prova de substituição.
-- Famílias de função única (medido em prod 2026-10-31): diluentes, retardadores, seladora nitro e thinners.
-- Catalisador, verniz, fundo, mordente, tingidor etc. trocam por cor/sistema, não por substituto — ficam
-- 'parado' quando param (precisão > recall).
-- Ordem: comprando → parado → substituido → sem cadência; dentro, valor anual desc (o legado é o desempate).
--
-- Medição em prod (31/10, 94 candidatos, R$ 54.822/ano): comprando 22 (R$ 1.848) · parado 60 (R$ 30.883) ·
-- substituido 12 (R$ 22.091). Prova: db/test-venda-repasse.sh (casos-ouro Lohan/Móveis & Cia/Anderson).
-- Só o corpo de venda_repasse_candidatos muda: assinatura, volatilidade, SECURITY DEFINER, SET, dono e ACL
-- intactos (CREATE OR REPLACE preserva; a PÓS confere). NÃO toca _venda_repasse_base, aprovar, gerador.
-- Molde: PRE (md5 medido na prod via psql-ro 2026-10-31 = 922cf8b1…, ou este corpo) → CREATE → PÓS (md5 +
-- ACL). Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`. ⚠️ migration manual (Lovable não auto-aplica).

CREATE TEMP TABLE IF NOT EXISTS repasse_cand_retrato (config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.repasse_cand_retrato;

DO $pre$
DECLARE v_md5 text; v_cfg_antes text;
BEGIN
  IF to_regprocedure('public.venda_repasse_candidatos()') IS NULL THEN
    RAISE EXCEPTION 'PRE: public.venda_repasse_candidatos ausente — aplique antes a 20261020233000';
  END IF;
  -- config lida ANTES da trava (que a reescreve): deriva prévia não é normalizada em silêncio
  SELECT coalesce(array_to_string(p.proconfig, ','), '-') INTO v_cfg_antes
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_repasse_candidatos()');
  IF v_cfg_antes IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'PRE_CONFIG: venda_repasse_candidatos com config inesperada antes da trava: %', v_cfg_antes;
  END IF;
  -- trava a linha de pg_proc antes de medir (CREATE concorrente espera); reescreve o MESMO valor conferido
  ALTER FUNCTION public.venda_repasse_candidatos() SET search_path = public, pg_temp;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_repasse_candidatos()');
  IF v_md5 IS DISTINCT FROM '922cf8b1efcb82f45a6d962ff7e7de96' AND v_md5 IS DISTINCT FROM '12d7fff8f2c8dbd41403715f32cfb35c' THEN
    RAISE EXCEPTION 'PRE_TRAVA: venda_repasse_candidatos deriva — md5(prosrc)=% não é o medido na prod (922cf8b1…) nem este corpo', v_md5;
  END IF;
  INSERT INTO pg_temp.repasse_cand_retrato
    SELECT p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_repasse_candidatos()');
END $pre$;

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
  -- famílias Oben em que um SKU de outra base faz a MESMA função (substituto possível) — medido 2026-10-31
  v_familias_substituiveis constant text[] := ARRAY['Diluente PU', 'Retardador PU', 'Seladora Nitrocelulose',
                                                     'Thinner de Limpeza Sayerlack', 'Thinner Nitrocelulose'];
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
    SELECT b.*,
           -- parado: passou de 2× a cadência; cadência ausente/não finita → NULL (não se afirma nada)
           CASE WHEN b.cadencia_dias > 0 AND private.regua_num_finito(b.cadencia_dias)
                THEN (v_hoje - b.data_ancora) > 2 * b.cadencia_dias END AS parado
      FROM b
     WHERE b.status_defasagem = 'defasado' OR b.abaixo_piso IS TRUE
  ),
  -- base = código da descrição sem a embalagem (DFA.4128LT → DFA.4128); sem código → NULL (não prova nada)
  prod AS MATERIALIZED (
    SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.familia,
           regexp_replace(substring(upper(op.descricao) FROM '[A-Z]{1,4}[0-9]{0,2}\.[0-9]{4}(?:\.[0-9A-Z]+)?'),
                          '[A-Z]+[0-9]?$', '') AS base
      FROM public.omie_products op
     WHERE op.account = 'oben' AND op.familia = ANY (v_familias_substituiveis)
  ),
  -- candidatos PARADOS com base provada numa família substituível
  cp AS MATERIALIZED (
    SELECT c.comprador_id, c.omie_codigo_produto, c.data_ancora, p.familia, p.base
      FROM c JOIN prod p ON p.omie_codigo_produto = c.omie_codigo_produto
     WHERE c.parado IS TRUE AND p.base IS NOT NULL
  ),
  -- dias de compra Oben por comprador × SKU (com base) dessas famílias, só dos compradores de cp — UMA linha
  -- por SKU com as datas num array: o cruzamento com cp fica do tamanho de "candidatos × SKUs da família",
  -- não "× dias de compra" (a versão por linha de dia passava dos 8 s no volume de prova)
  ds AS MATERIALIZED (
    SELECT l.comprador_id, p.familia, p.base, l.omie_codigo_produto, array_agg(DISTINCT l.data_pedido) AS datas
      FROM private.venda_linhas_pedido(v_hoje + 1) l
      JOIN prod p ON p.omie_codigo_produto = l.omie_codigo_produto AND p.base IS NOT NULL
     WHERE l.empresa = 'oben' AND l.comprador_id IN (SELECT cp.comprador_id FROM cp)
     GROUP BY l.comprador_id, p.familia, p.base, l.omie_codigo_produto
  ),
  -- por SKU irmão (mesma família, OUTRA base): compras DEPOIS da última do candidato; e se a BASE dele (qualquer
  -- embalagem) já era comprada nos 365 dias até a última compra do candidato — então convivia e não substitui
  sub AS (
    SELECT cp.comprador_id, cp.omie_codigo_produto, ds.omie_codigo_produto AS sku_sub, x.primeira, x.ultima, x.n_dias,
           bool_or(x.convivia_sku) OVER (PARTITION BY cp.comprador_id, cp.omie_codigo_produto, ds.base) AS convivia
      FROM cp
      JOIN ds ON ds.comprador_id = cp.comprador_id AND ds.familia = cp.familia AND ds.base <> cp.base
      CROSS JOIN LATERAL (
        SELECT min(u.d) FILTER (WHERE u.d > cp.data_ancora) AS primeira,
               max(u.d) FILTER (WHERE u.d > cp.data_ancora) AS ultima,
               count(*) FILTER (WHERE u.d > cp.data_ancora) AS n_dias,
               COALESCE(bool_or(u.d BETWEEN cp.data_ancora - 365 AND cp.data_ancora), false) AS convivia_sku
          FROM unnest(ds.datas) AS u(d)
      ) x
  ),
  s1 AS (   -- o substituto exposto: mais dias de compra; empate → compra mais recente → menor código
    SELECT DISTINCT ON (s.comprador_id, s.omie_codigo_produto) s.*, p.codigo, p.descricao
      FROM sub s JOIN prod p ON p.omie_codigo_produto = s.sku_sub
     WHERE s.convivia IS FALSE AND s.n_dias > 0
     ORDER BY s.comprador_id, s.omie_codigo_produto, s.n_dias DESC, s.ultima DESC, s.sku_sub
  ),
  f AS (
    SELECT c.*, s1.sku_sub, s1.codigo AS sub_codigo, s1.descricao AS sub_descricao,
           s1.primeira AS sub_primeira, s1.ultima AS sub_ultima, s1.n_dias AS sub_dias,
           CASE WHEN c.parado IS NULL THEN NULL
                WHEN s1.sku_sub IS NOT NULL THEN 'substituido'
                WHEN c.parado THEN 'parado'
                ELSE 'comprando' END AS situacao
      FROM c
      LEFT JOIN s1 ON s1.comprador_id = c.comprador_id AND s1.omie_codigo_produto = c.omie_codigo_produto
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

DO $pos$
DECLARE v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
         coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
    INTO v_src, v_cfg, v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_repasse_candidatos()');
  IF position('''substituido''' IN v_src) = 0 OR position('v_familias_substituiveis' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS_SUBST: venda_repasse_candidatos não classifica a substituição';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '12d7fff8f2c8dbd41403715f32cfb35c' THEN
    RAISE EXCEPTION 'POS: md5(prosrc)=% não é o corpo desta migration', md5(v_src);
  END IF;
  SELECT * INTO v_ret FROM pg_temp.repasse_cand_retrato;
  IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: config/ACL mudou — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_cfg, v_acl;
  END IF;
  -- duas pontas (PUBLIC e anon) pelo ACL EFETIVO; authenticated segue abrindo (o gate é o do corpo)
  IF has_function_privilege('anon', 'public.venda_repasse_candidatos()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS_ACL_ANON: venda_repasse_candidatos executável por anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.venda_repasse_candidatos()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS_ACL_AUTH: venda_repasse_candidatos fechada para authenticated';
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.repasse_cand_retrato;
