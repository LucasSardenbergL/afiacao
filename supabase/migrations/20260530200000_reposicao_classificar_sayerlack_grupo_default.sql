-- Reposição — classifica SKU Sayerlack sem grupo no grupo default 'sayerlack_normal'
-- ============================================================================
-- Achado raiz da auditoria: 100 de 124 SKUs RENNER SAYERLACK sem parâmetro estavam SEM
-- GRUPO de produção (sku_grupo_producao). Sem grupo → a v_sku_parametros_sugeridos não
-- calcula lead time teórico (INNER JOIN com sku_grupo_producao + fornecedor_grupo_producao)
-- E o gate status_sugestao trava (AGUARDANDO_CLASSIFICACAO_GRUPO) → nunca sugeridos pra compra.
-- O grupo é o pré-requisito que destrava a cascata (grupo → lead time → sugestão).
--
-- Só há 2 grupos Sayerlack: sayerlack_normal (LT 8 dias úteis) e sayerlack_rapido (5 dias).
-- A divisão é por VELOCIDADE DE ENTREGA (negócio), NÃO derivável do código/descrição. Default
-- conservador (revisado c/ codex): jogar os sem-grupo no 'sayerlack_normal' (LT MAIOR) — reduz
-- o risco vs 'rapido' (LT maior = ponto de pedido mais alto = compra mais cedo; pior caso = leve
-- excesso nos que na verdade são "rápido", nunca o contrário de ruptura por LT subestimado). O
-- grupo controla SÓ lt_producao_dias + horario_corte (sem MOQ/lote/política — verificado), então
-- o default não distorce mais nada. O dono refina (move os rápidos pra 'rapido') na tela depois.
--
-- Marcado com atualizado_por='auto_default_sayerlack' (codex: trilha de revisão visível, sem
-- bloquear a compra esperando classificação perfeita — o maior risco hoje é a INVISIBILIDADE).
-- Filtros (codex): só habilitado_reposicao_automatica=true e NÃO fracionado (450/405ML, que não
-- são comprados). Família-barrada/descontinuado seguem barrados pelo motor downstream.

CREATE OR REPLACE FUNCTION public.classificar_sayerlack_grupo_default()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_inseridos int := 0;
BEGIN
  INSERT INTO sku_grupo_producao (empresa, sku_codigo_omie, grupo_codigo, atualizado_por, atualizado_em)
  SELECT 'OBEN', sp.sku_codigo_omie::text, 'sayerlack_normal', 'auto_default_sayerlack', now()
  FROM sku_parametros sp
  WHERE sp.empresa = 'OBEN'
    AND sp.fornecedor_nome ILIKE '%SAYERLACK%'
    AND sp.habilitado_reposicao_automatica = true
    AND COALESCE(sp.sku_descricao, '') NOT ILIKE '%450ML'
    AND COALESCE(sp.sku_descricao, '') NOT ILIKE '%405ML'
    AND NOT EXISTS (
      SELECT 1 FROM sku_grupo_producao sg
      WHERE sg.empresa = sp.empresa
        AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    );
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  RETURN v_inseridos;
END;
$$;

-- Cron 7h30 — ANTES do reposicao-preencher-parametros-faltantes (8h, que lê a view que precisa
-- do grupo) e do ciclo de geração (9h15). SQL-local, idempotente (NOT EXISTS). Pra produto
-- Sayerlack novo nunca mais acumular sem-grupo (invisível pra compra).
SELECT cron.schedule('reposicao-classificar-sayerlack-grupo', '30 7 * * *',
  $cron$ SELECT public.classificar_sayerlack_grupo_default(); $cron$);
