CREATE OR REPLACE FUNCTION public.calcular_gatilhos_reposicao(
  p_empresa text DEFAULT 'OBEN',
  p_only_sku bigint DEFAULT NULL
)
RETURNS TABLE(atualizados integer, baixo_giro integer, normais integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_atualizados integer := 0;
  v_baixo integer := 0;
  v_normais integer := 0;
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
      ) AS baixo_giro
    FROM sku_parametros sp
    WHERE sp.empresa = p_empresa
      AND sp.ativo = TRUE
      AND sp.habilitado_reposicao_automatica = TRUE
      AND (p_only_sku IS NULL OR sp.sku_codigo_omie = p_only_sku)
  ),
  calc AS (
    SELECT
      b.*,
      CASE WHEN b.baixo_giro THEN 1::numeric
           ELSE CEIL(b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt))
      END AS ponto_pedido_novo,
      CASE WHEN b.baixo_giro THEN 1::numeric
           ELSE CEIL(b.z * b.dstd * SQRT(b.lt))
      END AS estoque_min_novo,
      CASE WHEN b.baixo_giro THEN GREATEST(2::numeric, b.lote_min + 1)
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
    RETURNING c.baixo_giro
  )
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE baixo_giro),
         COUNT(*) FILTER (WHERE NOT baixo_giro)
    INTO v_atualizados, v_baixo, v_normais
    FROM upd;

  RETURN QUERY SELECT v_atualizados, v_baixo, v_normais;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calcular_gatilhos_reposicao(text, bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.calcular_gatilhos_reposicao IS
'Calcula ponto_pedido / estoque_minimo / estoque_maximo dos SKUs habilitados.
Aplica regra "baixo giro = sugere 1" para classe Y/Z ou demanda < 0.05/dia.';