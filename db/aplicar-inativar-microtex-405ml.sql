-- ============================================================
-- Inativa na reposição o 405ML 8689771187 (BASE BRIL 05 MICROTEX TRANSP WFOT.6861 405ML), OBEN,
-- pelo `db:aplicar` (a transação é do executor — sem BEGIN/COMMIT aqui).
-- Decisão do founder em 2026-11-01 (sessão 511-alertas-reposicao): "ela também segue os 405ml".
-- ============================================================
-- 405ML é fracionado — vendido, nunca comprado (pai é o QT; docs/agent/reposicao.md). Os 17 irmãos
-- 405ML da Sayerlack já estão com sku_parametros.ativo = false; este era o único 405ML Sayerlack
-- ainda ativo e por isso o único alerta `sku_sem_grupo` pendente na fila de /admin/reposicao/alertas.
-- A reposição automática dele já está desligada (habilitado_reposicao_automatica = false), e no Omie
-- ele segue ativo para VENDA — nada disso muda aqui.
--
-- Efeito: o detector `detectar_skus_sem_grupo` (20261031191127) fecha o alerta como "SKU inativo".
-- Triggers da tabela: `trg_historico_sku_parametros` (snapshot, sem efeito de negócio) e
-- `sku_parametros_desconsolidar_ao_religar` (só dispara em habilitado/tipo — não dispara aqui).
-- Re-rodar é no-op.

-- PRE: é o SKU certo e é um 405ML (a descrição do Omie manda).
DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sku_parametros sp
      JOIN public.omie_products op ON op.omie_codigo_produto = sp.sku_codigo_omie AND op.account = 'oben'
     WHERE sp.empresa = 'OBEN' AND sp.sku_codigo_omie = 8689771187
       AND op.descricao ILIKE '%405ML'
       AND sp.habilitado_reposicao_automatica IS FALSE
  ) THEN
    RAISE EXCEPTION 'PRE FALHOU: 8689771187 não é o 405ML OBEN com reposição automática desligada esperado';
  END IF;
END
$pre$;

UPDATE public.sku_parametros
   SET ativo = false
 WHERE empresa = 'OBEN' AND sku_codigo_omie = 8689771187
   AND ativo IS NOT FALSE;

SELECT public.detectar_skus_sem_grupo('OBEN');

-- PÓS: inativo, e o alerta dele saiu da fila.
DO $pos$
BEGIN
  IF (SELECT ativo FROM public.sku_parametros
       WHERE empresa = 'OBEN' AND sku_codigo_omie = 8689771187) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POS FALHOU: 8689771187 não ficou inativo em sku_parametros';
  END IF;
  IF EXISTS (SELECT 1 FROM public.eventos_outlier
              WHERE empresa = 'OBEN' AND sku_codigo_omie = '8689771187'
                AND tipo = 'sku_sem_grupo' AND status = 'pendente') THEN
    RAISE EXCEPTION 'POS FALHOU: alerta sku_sem_grupo de 8689771187 continua pendente';
  END IF;
END
$pos$;
