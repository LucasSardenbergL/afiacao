CREATE OR REPLACE FUNCTION public.resolver_sku_por_codigo_fornecedor(p_empresa text, p_codigo_fornecedor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int;
  v_unico record;
  v_candidatos jsonb;
  v_empresa text := lower(coalesce(p_empresa, ''));
BEGIN
  IF p_codigo_fornecedor IS NULL OR TRIM(p_codigo_fornecedor) = '' THEN
    RETURN jsonb_build_object('qualidade', 'nao_encontrado', 'motivo', 'codigo_vazio');
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM omie_products op
  WHERE lower(op.account) = v_empresa
    AND COALESCE(op.ativo, true) = true
    AND op.descricao ILIKE '%' || p_codigo_fornecedor || '%';

  IF v_count = 0 THEN
    RETURN jsonb_build_object('qualidade', 'nao_encontrado');
  END IF;

  IF v_count = 1 THEN
    SELECT op.omie_codigo_produto, op.descricao INTO v_unico
    FROM omie_products op
    WHERE lower(op.account) = v_empresa
      AND COALESCE(op.ativo, true) = true
      AND op.descricao ILIKE '%' || p_codigo_fornecedor || '%'
    LIMIT 1;

    RETURN jsonb_build_object(
      'qualidade', 'unico',
      'omie_codigo_produto', v_unico.omie_codigo_produto,
      'descricao', v_unico.descricao
    );
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'omie_codigo_produto', op.omie_codigo_produto,
      'descricao', op.descricao,
      'codigo_interno', op.codigo
    )
    ORDER BY op.descricao
  )
  INTO v_candidatos
  FROM (
    SELECT omie_codigo_produto, descricao, codigo
    FROM omie_products
    WHERE lower(account) = v_empresa
      AND COALESCE(ativo, true) = true
      AND descricao ILIKE '%' || p_codigo_fornecedor || '%'
    LIMIT 5
  ) op;

  RETURN jsonb_build_object(
    'qualidade', 'ambiguo',
    'total_matches', v_count,
    'candidatos', v_candidatos
  );
END;
$function$;