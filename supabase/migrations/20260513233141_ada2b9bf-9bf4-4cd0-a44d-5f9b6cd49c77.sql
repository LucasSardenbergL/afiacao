DROP FUNCTION IF EXISTS public.calcular_gatilhos_reposicao(text, bigint);

CREATE FUNCTION public.calcular_gatilhos_reposicao(
  p_empresa text DEFAULT 'OBEN',
  p_only_sku bigint DEFAULT NULL,
  OUT atualizados integer,
  OUT skus_baixo_giro integer,
  OUT skus_normais integer
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  WITH base AS (
    SELECT
      sp.empresa,
      sp.sku_codigo_omie,
      COALESCE(sp.demanda_media_diaria, 0) AS dmd,
      COALESCE(sp.demanda_desvio_padrao,
               COALESCE(sp.demanda_media_diaria, 0) * 0.5) AS dstd,
      COALESCE(sp.lt_medio_dias_uteis, 7) AS lt,
      COALESCE(sp.cobertura_alvo_dias, 30) AS cob,
      COALESCE(sp.lote_minimo_fornecedor, 1) AS lote_min,
      CASE LEFT(COALESCE(sp.classe_consolidada, ''), 1)
        WHEN 'A' THEN 2.33
        WHEN 'B' THEN 1.65
        WHEN 'C' THEN 1.28
        ELSE 1.65
      END AS z,
      (
        RIGHT(COALESCE(sp.classe_consolidada, ''), 1) IN ('Y','Z')
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
      CASE WHEN b.is_baixo_giro THEN 1::numeric
           ELSE CEIL(b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt))
      END AS ponto_pedido_novo,
      CASE WHEN b.is_baixo_giro THEN 1::numeric
           ELSE CEIL(b.z * b.dstd * SQRT(b.lt))
      END AS estoque_min_novo,
      CASE WHEN b.is_baixo_giro THEN GREATEST(2::numeric, b.lote_min + 1)
           ELSE CEIL((b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt)) + b.dmd * b.cob)
      END AS estoque_max_novo
    FROM base b
  ),
  upd AS (
    UPDATE sku_parametros sp
       SET ponto_pedido = c.ponto_pedido_novo,
           estoque_minimo = c.estoque_min_novo,
           estoque_seguranca = c.estoque_min_novo,
           estoque_maximo = c.estoque_max_novo,
           ultima_atualizacao_calculo = NOW()
      FROM calc c
     WHERE sp.empresa = c.empresa
       AND sp.sku_codigo_omie = c.sku_codigo_omie
    RETURNING c.is_baixo_giro AS bg
  )
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE bg)::int,
         COUNT(*) FILTER (WHERE NOT bg)::int
    INTO atualizados, skus_baixo_giro, skus_normais
    FROM upd;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calcular_gatilhos_reposicao(text, bigint)
  TO authenticated, service_role;