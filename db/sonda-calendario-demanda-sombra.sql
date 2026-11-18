-- Sonda SÓ LEITURA da Etapa 2 do calendário (20261120090000) — rodar por psql-ro:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sonda-calendario-demanda-sombra.sql
-- Exige o marcador final `fim|ok`. Spec §7-E2 (a) neutralidade da sombra · (e) efeito no param-auto se a chave virasse.
\pset pager off

-- 0. Estado da chave (ausente = sombra) e o fator de hoje.
SELECT 'chave' AS item, coalesce((SELECT value FROM public.company_config
        WHERE key = 'reposicao_demanda_calendario_oben_ativa'), '(ausente = sombra)') AS valor;
SELECT 'fator_hoje' AS item, f.*
  FROM public.calendario_fator_demanda('OBEN', (now() AT TIME ZONE 'America/Sao_Paulo')::date) f;

-- 1. (a) Neutralidade: no modo servido, d = legado em TODA linha enquanto a chave não virar.
SELECT 'neutralidade_servida' AS item,
       count(*) AS linhas,
       count(*) FILTER (WHERE calendario_modo IS DISTINCT FROM 'valendo'
                          AND demanda_media_diaria IS DISTINCT FROM demanda_media_diaria_legado) AS divergentes_em_sombra,
       count(*) FILTER (WHERE empresa <> 'OBEN' AND fator_calendario IS NOT NULL) AS fator_fora_da_oben
  FROM public.v_sku_parametros_sugeridos;

-- 2. Sombra gravada pelo job: dias e linhas por dia (lacuna = job não rodou; ausência não é aprovação).
SELECT 'sombra_por_dia' AS item, data_ref, count(*) AS skus,
       count(*) FILTER (WHERE status_sugestao = 'OK') AS skus_ok,
       round(min(fator_calendario), 4) AS fator, bool_or(calendario_baixa_confianca) AS baixa_conf,
       max(registrado_em) AS registrado_em
  FROM public.reposicao_demanda_calendario_sombra
 GROUP BY data_ref ORDER BY data_ref DESC LIMIT 10;

-- 3. (e) Se a chave virasse HOJE: o que o atualizador faria (mesma regra de status do
--    atualizar_parametros_numericos_skus: mudou o arredondado → aplicado; máx > fusível × máx atual → segurado).
BEGIN READ ONLY;
SELECT pg_catalog.set_config('reposicao.demanda_calendario_forcar', 'sombra', true) IS NOT NULL AS forcado;
WITH v AS (
  SELECT sku_codigo_omie, ponto_pedido_sugerido AS pp, estoque_maximo_sugerido AS mx, preco_item_eoq,
         demanda_media_diaria AS d, demanda_media_diaria_legado AS d0
    FROM public.v_sku_parametros_sugeridos WHERE empresa = 'OBEN' AND status_sugestao = 'OK'
), mult AS (
  SELECT coalesce((SELECT value::numeric FROM public.company_config WHERE key = 'param_auto_fusivel_mult'), 3) AS m
)
-- Os dois modos contra o MESMO estado gravado: a diferença das contagens é o efeito da virada (pin não descontado).
SELECT 'efeito_param_auto_sombra' AS item,
       count(*) AS skus_ok,
       count(*) FILTER (WHERE round(v.pp) IS DISTINCT FROM round(sp.ponto_pedido)
                           OR round(v.mx) IS DISTINCT FROM round(sp.estoque_maximo)) AS mudariam_pp_ou_max,
       count(*) FILTER (WHERE sp.estoque_maximo > 0 AND round(v.mx) > (SELECT m FROM mult) * round(sp.estoque_maximo)) AS segurados_pelo_fusivel,
       count(*) FILTER (WHERE sp.ponto_pedido IS NULL) AS sem_pp_gravado,
       round(sum(v.d - v.d0), 4) AS delta_d_total
  FROM v LEFT JOIN public.sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie = v.sku_codigo_omie;
ROLLBACK;

BEGIN READ ONLY;
SELECT pg_catalog.set_config('reposicao.demanda_calendario_forcar', 'valendo', true) IS NOT NULL AS forcado;
WITH v AS (
  SELECT sku_codigo_omie, ponto_pedido_sugerido AS pp, estoque_maximo_sugerido AS mx, preco_item_eoq,
         demanda_media_diaria AS d, demanda_media_diaria_legado AS d0
    FROM public.v_sku_parametros_sugeridos WHERE empresa = 'OBEN' AND status_sugestao = 'OK'
), mult AS (
  SELECT coalesce((SELECT value::numeric FROM public.company_config WHERE key = 'param_auto_fusivel_mult'), 3) AS m
)
-- Os dois modos contra o MESMO estado gravado: a diferença das contagens é o efeito da virada (pin não descontado).
SELECT 'efeito_param_auto_valendo' AS item,
       count(*) AS skus_ok,
       count(*) FILTER (WHERE round(v.pp) IS DISTINCT FROM round(sp.ponto_pedido)
                           OR round(v.mx) IS DISTINCT FROM round(sp.estoque_maximo)) AS mudariam_pp_ou_max,
       count(*) FILTER (WHERE sp.estoque_maximo > 0 AND round(v.mx) > (SELECT m FROM mult) * round(sp.estoque_maximo)) AS segurados_pelo_fusivel,
       count(*) FILTER (WHERE sp.ponto_pedido IS NULL) AS sem_pp_gravado,
       round(sum(v.d - v.d0), 4) AS delta_d_total
  FROM v LEFT JOIN public.sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie = v.sku_codigo_omie;
ROLLBACK;

-- 4. Capital adicional (ΔPP e Δmáximo × custo) da última sombra. O custo NÃO está na sombra (o job lê como dono e a
--    policy dela não tem cap_custo_ler): vem da view agora, lida por quem pode ler custo. SKU sem preço é contado.
WITH u AS (
  SELECT s.*, v.preco_item_eoq
    FROM public.reposicao_demanda_calendario_sombra s
    LEFT JOIN public.v_sku_parametros_sugeridos v ON v.empresa = s.empresa AND v.sku_codigo_omie = s.sku_codigo_omie
   WHERE s.data_ref = (SELECT max(data_ref) FROM public.reposicao_demanda_calendario_sombra) AND s.status_sugestao = 'OK'
)
SELECT 'capital_ultima_sombra' AS item, max(data_ref) AS data_ref, count(*) AS skus_ok,
       sum(pp_calendario - pp_legado) AS delta_pp_un,
       round(sum((pp_calendario - pp_legado) * preco_item_eoq) FILTER (WHERE preco_item_eoq > 0), 2) AS delta_pp_rs,
       round(sum((max_calendario - max_legado) * preco_item_eoq) FILTER (WHERE preco_item_eoq > 0), 2) AS delta_max_rs,
       count(*) FILTER (WHERE NOT (preco_item_eoq > 0) OR preco_item_eoq IS NULL) AS sem_preco
  FROM u;

SELECT 'fim', 'ok';
