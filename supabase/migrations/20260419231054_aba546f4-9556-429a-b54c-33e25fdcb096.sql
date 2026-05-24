-- Função para detectar SKUs novos sem grupo de produção em fornecedores que possuem grupos cadastrados
CREATE OR REPLACE FUNCTION public.detectar_skus_sem_grupo(p_empresa text DEFAULT 'OBEN'::text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inseridos integer := 0;
BEGIN
  WITH fornecedores_com_grupos AS (
    SELECT DISTINCT fornecedor_nome
    FROM fornecedor_grupo_producao
    WHERE empresa = p_empresa
  ),
  inseridos AS (
    INSERT INTO eventos_outlier (
      empresa, sku_codigo_omie, sku_descricao,
      tipo, severidade, data_evento, detalhes
    )
    SELECT
      sp.empresa,
      sp.sku_codigo_omie::text,
      sp.sku_descricao,
      'sku_sem_grupo',
      'atencao',
      CURRENT_DATE,
      jsonb_build_object(
        'fornecedor', sp.fornecedor_nome,
        'mensagem', 'SKU novo detectado. Classifique em um grupo de produção antes do próximo ciclo de reposição.'
      )
    FROM sku_parametros sp
    JOIN fornecedores_com_grupos fcg ON fcg.fornecedor_nome = sp.fornecedor_nome
    WHERE sp.empresa = p_empresa
      AND NOT EXISTS (
        SELECT 1 FROM sku_grupo_producao sg
        WHERE sg.empresa = sp.empresa
          AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM eventos_outlier eo
        WHERE eo.empresa = sp.empresa
          AND eo.sku_codigo_omie = sp.sku_codigo_omie::text
          AND eo.tipo = 'sku_sem_grupo'
          AND eo.status = 'pendente'
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inseridos FROM inseridos;

  RETURN v_inseridos;
END;
$$;