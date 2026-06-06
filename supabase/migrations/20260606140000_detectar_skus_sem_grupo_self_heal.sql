-- (2+3 backend) detectar_skus_sem_grupo — limpeza do ruído de alerta "SKU sem grupo".
-- SUPERSEDE a 20260606130000 (B): redefine a função completa e adiciona SELF-HEAL.
--   - Exclusão de Produto Acabado ('04'): subquery account-aware em omie_products.tipo_produto
--     (sinal CANÔNICO, espelha o motor 20260604170000). Fabricado não é comprado → sem grupo.
--   - SELF-HEAL: a cada run, resolve ('excluido') os alertas pendentes que não fazem mais
--     sentido — SKU que JÁ ganhou grupo (o alerta velho nunca se auto-resolvia) ou que é '04'.
--     Era a causa do descasamento (alertas mostram dezenas; a tela de grupo, 1).
-- NÃO usa 450/405ML aqui: é regra de fracionado específica do motor de COMPRA; aplicá-la ao
-- alerta de grupo poderia suprimir um item comprável legítimo (decisão eu+Codex). O '04' é o
-- sinal seguro/universal de "não comprado". Gerador de ALERTA — NÃO toca compra/money-path.

CREATE OR REPLACE FUNCTION public.detectar_skus_sem_grupo(p_empresa text DEFAULT 'OBEN'::text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inseridos integer := 0;
BEGIN
  -- SELF-HEAL: resolve alertas pendentes que deixaram de fazer sentido (já agrupado ou '04').
  UPDATE eventos_outlier eo
  SET status = 'excluido',
      decidido_em = now(),
      decidido_por = 'sistema (auto-resolve sku_sem_grupo)',
      justificativa_decisao = 'SKU já tem grupo ou é Produto Acabado (04) fabricado — não precisa de grupo de produção.'
  WHERE eo.tipo = 'sku_sem_grupo'
    AND eo.status = 'pendente'
    AND eo.empresa = p_empresa
    AND (
      EXISTS (
        SELECT 1 FROM sku_grupo_producao sg
        WHERE sg.empresa = eo.empresa AND sg.sku_codigo_omie = eo.sku_codigo_omie
      )
      OR COALESCE((
        SELECT COALESCE(op.tipo_produto, op.metadata->>'tipo_produto')
        FROM omie_products op
        WHERE op.omie_codigo_produto::text = eo.sku_codigo_omie AND op.account = lower(eo.empresa)
        LIMIT 1
      ), '') = '04'
    );

  -- Geração: só SKU comprável sem grupo (exclui Produto Acabado '04').
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
      sp.empresa, sp.sku_codigo_omie::text, sp.sku_descricao,
      'sku_sem_grupo', 'atencao', CURRENT_DATE,
      jsonb_build_object(
        'fornecedor', sp.fornecedor_nome,
        'mensagem', 'SKU novo detectado. Classifique em um grupo de produção antes do próximo ciclo de reposição.'
      )
    FROM sku_parametros sp
    JOIN fornecedores_com_grupos fcg ON fcg.fornecedor_nome = sp.fornecedor_nome
    WHERE sp.empresa = p_empresa
      AND NOT EXISTS (
        SELECT 1 FROM sku_grupo_producao sg
        WHERE sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM eventos_outlier eo
        WHERE eo.empresa = sp.empresa AND eo.sku_codigo_omie = sp.sku_codigo_omie::text
          AND eo.tipo = 'sku_sem_grupo' AND eo.status = 'pendente'
      )
      AND COALESCE((
        SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
        FROM omie_products op04
        WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op04.account = lower(p_empresa)
        LIMIT 1
      ), '') <> '04'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inseridos FROM inseridos;

  RETURN v_inseridos;
END;
$$;

-- Cleanup imediato dos alertas velhos (não espera o próximo run do cron). Todas as empresas.
UPDATE public.eventos_outlier eo
SET status = 'excluido',
    decidido_em = now(),
    decidido_por = 'sistema (auto-resolve sku_sem_grupo)',
    justificativa_decisao = 'SKU já tem grupo ou é Produto Acabado (04) fabricado — não precisa de grupo de produção.'
WHERE eo.tipo = 'sku_sem_grupo'
  AND eo.status = 'pendente'
  AND (
    EXISTS (
      SELECT 1 FROM sku_grupo_producao sg
      WHERE sg.empresa = eo.empresa AND sg.sku_codigo_omie = eo.sku_codigo_omie
    )
    OR COALESCE((
      SELECT COALESCE(op.tipo_produto, op.metadata->>'tipo_produto')
      FROM omie_products op
      WHERE op.omie_codigo_produto::text = eo.sku_codigo_omie AND op.account = lower(eo.empresa)
      LIMIT 1
    ), '') = '04'
  );
