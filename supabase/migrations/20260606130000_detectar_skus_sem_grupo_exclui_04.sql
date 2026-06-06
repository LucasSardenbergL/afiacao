-- B (Reposição/Alertas): detectar_skus_sem_grupo deixa de gerar o alerta
-- "SKU novo detectado — classifique em um grupo de produção" para Produto Acabado
-- ('04' = tingidor/produto fabricado internamente na OBEN, NÃO comprado → não precisa
-- de grupo de produção/lead-time de fornecedor). Era ruído na fila de alertas.
--
-- Espelha a guarda '04' account-aware do motor gerar_pedidos_sugeridos_ciclo
-- (20260604170000): subquery em omie_products.tipo_produto (COLUNA dedicada, ponte:
-- fallback ao metadata legado), account = lower(empresa).
--
-- Esta função é geradora de ALERTA (escreve em eventos_outlier) — NÃO toca compra/money-path.
-- CREATE OR REPLACE idempotente; corpo = versão viva de produção (schema-snapshot) + a guarda.

CREATE OR REPLACE FUNCTION public.detectar_skus_sem_grupo(p_empresa text DEFAULT 'OBEN'::text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
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
      -- [04-fabricado] Produto Acabado = fabricado internamente, não comprado → sem grupo.
      AND COALESCE((
        SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
        FROM omie_products op04
        WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
          AND op04.account = lower(p_empresa)
        LIMIT 1
      ), '') <> '04'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inseridos FROM inseridos;

  RETURN v_inseridos;
END;
$$;

-- Limpa os alertas de Produto Acabado ('04') que JÁ estão pendentes (param de aparecer
-- agora, não só daqui pra frente). Só sku_sem_grupo + pendente + '04'. status livre (sem CHECK).
UPDATE public.eventos_outlier eo
SET status = 'excluido',
    decidido_em = now(),
    decidido_por = 'sistema (produto_acabado_04)',
    justificativa_decisao = 'Produto Acabado (04) fabricado internamente — não comprado, não precisa de grupo de produção.'
WHERE eo.tipo = 'sku_sem_grupo'
  AND eo.status = 'pendente'
  AND COALESCE((
    SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
    FROM omie_products op04
    WHERE op04.omie_codigo_produto::text = eo.sku_codigo_omie
      AND op04.account = lower(eo.empresa)
    LIMIT 1
  ), '') = '04';
