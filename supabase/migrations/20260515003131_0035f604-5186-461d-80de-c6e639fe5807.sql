CREATE OR REPLACE FUNCTION public.calcular_gatilhos_reposicao(
  p_empresa text DEFAULT 'OBEN'::text,
  p_only_sku bigint DEFAULT NULL::bigint,
  OUT atualizados integer,
  OUT skus_baixo_giro integer,
  OUT skus_normais integer
)
RETURNS record
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  WITH base AS (
    SELECT
      sp.empresa,
      sp.sku_codigo_omie,
      sp.estoque_minimo_omie,
      sp.ponto_pedido_omie,
      sp.estoque_maximo_omie,
      COALESCE(sp.demanda_media_diaria, 0) AS dmd,
      -- Fallback de desvio-padrão por classe XYZ (CV típico)
      COALESCE(
        sp.demanda_desvio_padrao,
        COALESCE(sp.demanda_media_diaria, 0) *
          CASE COALESCE(sp.classe_xyz, '')
            WHEN 'X' THEN 0.20
            WHEN 'Y' THEN 0.50
            WHEN 'Z' THEN 1.00
            ELSE 0.50
          END
      ) AS dstd,
      COALESCE(sp.lt_medio_dias_uteis, 7) AS lt,
      -- Cobertura padrão por classe ABC: A=15d, B=30d, C=45d
      COALESCE(
        sp.cobertura_alvo_dias,
        CASE COALESCE(sp.classe_abc, '')
          WHEN 'A' THEN 15
          WHEN 'B' THEN 30
          WHEN 'C' THEN 45
          ELSE 30
        END
      ) AS cob,
      COALESCE(sp.lote_minimo_fornecedor, 1) AS lote_min,
      CASE COALESCE(sp.classe_abc, '')
        WHEN 'A' THEN 2.33
        WHEN 'B' THEN 1.65
        WHEN 'C' THEN 1.28
        ELSE 1.65
      END AS z,
      -- Baixo giro APENAS quando: (B/C com Y/Z) OU demanda < 0.05/dia
      -- Itens A-class continuam sendo dimensionados pela fórmula clássica,
      -- mesmo com demanda irregular (Y/Z) — o z=2.33 já compensa via segurança.
      (
        (LEFT(COALESCE(sp.classe_abc, ''), 1) IN ('B','C')
         AND COALESCE(sp.classe_xyz, '') IN ('Y','Z'))
        OR COALESCE(sp.demanda_media_diaria, 0) < 0.05
      ) AS is_baixo_giro
    FROM sku_parametros sp
    WHERE sp.empresa = p_empresa
      AND sp.ativo = TRUE
      AND sp.habilitado_reposicao_automatica = TRUE
      AND (p_only_sku IS NULL OR sp.sku_codigo_omie = p_only_sku)
  ),
  calc AS (
    SELECT
      b.*,
      -- Estoque de segurança (= estoque mínimo, com piso 1)
      GREATEST(
        1::numeric,
        CASE WHEN b.is_baixo_giro THEN 1::numeric
             ELSE CEIL(b.z * b.dstd * SQRT(b.lt))
        END
      ) AS estoque_min_novo,
      -- Ponto de pedido (respeita MOQ)
      GREATEST(
        b.lote_min,
        CASE WHEN b.is_baixo_giro THEN GREATEST(1::numeric, b.lote_min)
             ELSE CEIL(b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt))
        END
      ) AS ponto_pedido_novo_raw,
      -- Estoque máximo bruto
      CASE WHEN b.is_baixo_giro
           THEN GREATEST(2::numeric, b.lote_min + 1)
           ELSE CEIL((b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt)) + b.dmd * b.cob)
      END AS estoque_max_novo_raw
    FROM base b
  ),
  final AS (
    SELECT
      c.*,
      -- Garantir Emax >= PP + lote_min (para caber pelo menos 1 lote acima do PP)
      GREATEST(c.estoque_max_novo_raw, c.ponto_pedido_novo_raw + c.lote_min) AS estoque_max_novo,
      c.ponto_pedido_novo_raw AS ponto_pedido_novo
    FROM calc c
  ),
  upd AS (
    UPDATE sku_parametros sp
       SET ponto_pedido = f.ponto_pedido_novo,
           estoque_minimo = f.estoque_min_novo,
           estoque_seguranca = f.estoque_min_novo,
           estoque_maximo = f.estoque_max_novo,
           ultima_atualizacao_calculo = NOW(),
           -- Marca para sincronizar com Omie quando algum valor diferiu
           aplicar_no_omie = CASE
             WHEN sp.estoque_minimo_omie IS DISTINCT FROM f.estoque_min_novo
               OR sp.ponto_pedido_omie  IS DISTINCT FROM f.ponto_pedido_novo
               OR sp.estoque_maximo_omie IS DISTINCT FROM f.estoque_max_novo
             THEN TRUE
             ELSE sp.aplicar_no_omie
           END
      FROM final f
     WHERE sp.empresa = f.empresa
       AND sp.sku_codigo_omie = f.sku_codigo_omie
    RETURNING f.is_baixo_giro AS bg
  )
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE bg)::int,
         COUNT(*) FILTER (WHERE NOT bg)::int
    INTO atualizados, skus_baixo_giro, skus_normais
    FROM upd;
END;
$function$;