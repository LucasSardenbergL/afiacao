-- Baixa MANUAL do PV 13600 da OBEN (codigo_pedido 12212025516, R$ 2.157,50), excluído direto no Omie.
-- Decisão do founder (2026-11-25): a reconciliação automática (edge omie-pv-exclusao-reconciliar, PR #4130) provou a
-- exclusão, mas parou o PV em revisão (`teto_valor_pv`: acima de R$ 2.000 por PV). O teto CONTINUA; só este PV sai.
--
-- Prova (omie_pv_consulta_log 3 e 5, mesma régua da baixa automática):
--   ConsultarPedido 2026-11-25 03:17 e 05:17 UTC → "ERROR: Pedido não cadastrado para o Código [12212025516] !",
--   2ª iniciada ≥ 1h depois da 1ª, sem presença no meio; o PV também falta na listagem completa de 2026-11-21.
-- Efeito: o MESMO da baixa automática — deleted_at nas linhas do PV (status preservado, sem DELETE) e o ledger
-- marcado como aplicado (durável: o trigger trg_sales_orders_pv_excluido_omie impede ressuscitar). Sem reserva ativa
-- (pré-voo). `origem_historica` na prova: baixa humana não consome o teto diário da automática.
-- Pré-voo psql-ro 2026-11-25: 1 linha viva (importado, R$ 2.157,50), ledger com contradicao=teto_valor_pv e 2 ausências.
-- Aplicar: bun run db:aplicar db/2026-11-25-baixa-manual-pv13600-oben.sql (sem BEGIN/COMMIT: o executor abre).

DO $pre$
BEGIN
  -- Idempotente: já aplicado = nada a fazer (a pós-condição confere).
  IF EXISTS (SELECT 1 FROM public.omie_pv_conferencia
              WHERE account = 'oben' AND omie_pedido_id = 12212025516 AND aplicado_em IS NOT NULL) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omie_pv_conferencia
                  WHERE account = 'oben' AND omie_pedido_id = 12212025516
                    AND contradicao = 'teto_valor_pv' AND ausencias_afirmadas >= 2) THEN
    RAISE EXCEPTION 'PRE_FALHOU: o ledger do PV 12212025516 não está mais em revisão por teto com 2 ausências — reavalie antes';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_orders
              WHERE account = 'oben' AND omie_pedido_id = 12212025516
                AND (status IN ('faturado', 'cancelado') OR (deleted_at IS NULL AND total IS DISTINCT FROM 2157.5))) THEN
    RAISE EXCEPTION 'PRE_FALHOU: linha do PV 12212025516 mudou (terminal ou valor diferente de R$ 2.157,50) — reavalie antes';
  END IF;
  IF EXISTS (SELECT 1 FROM public.estoque_reservas
              WHERE status = 'ativa' AND ((omie_account = 'oben' AND omie_pedido_id = 12212025516)
                 OR sales_order_id IN (SELECT id FROM public.sales_orders WHERE account = 'oben' AND omie_pedido_id = 12212025516))) THEN
    RAISE EXCEPTION 'PRE_FALHOU: o PV 12212025516 ganhou reserva ativa — a baixa manual não libera estoque; reavalie';
  END IF;

  UPDATE public.sales_orders
     SET deleted_at = now()
   WHERE account = 'oben' AND omie_pedido_id = 12212025516 AND deleted_at IS NULL;

  UPDATE public.omie_pv_conferencia c
     SET aplicado_em = now(), valor_baixado = 2157.5, contradicao = NULL, contradicao_em = NULL, adiado_motivo = NULL,
         atualizado_em = now(),
         prova = jsonb_build_object(
           'origem_historica', 'baixa manual acima do teto (founder, 2026-11-25)',
           'consultas', (SELECT jsonb_agg(l.id ORDER BY l.id) FROM public.omie_pv_consulta_log l
                          WHERE l.account = 'oben' AND l.omie_pedido_id = 12212025516 AND l.resultado = 'ausente'),
           'primeira_ausencia', c.primeira_ausencia_afirmada_em, 'ultima_ausencia', c.ultima_ausencia_afirmada_em,
           'valor', 2157.5, 'revisao_anterior', 'teto_valor_pv')
   WHERE c.account = 'oben' AND c.omie_pedido_id = 12212025516 AND c.aplicado_em IS NULL;
END
$pre$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales_orders
              WHERE account = 'oben' AND omie_pedido_id = 12212025516 AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'P1_FALHOU: o PV 12212025516 segue com linha viva';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omie_pv_conferencia
                  WHERE account = 'oben' AND omie_pedido_id = 12212025516 AND aplicado_em IS NOT NULL
                    AND contradicao IS NULL AND prova ? 'origem_historica'
                    AND jsonb_array_length(prova->'consultas') >= 2) THEN
    RAISE EXCEPTION 'P2_FALHOU: ledger do PV 12212025516 não ficou aplicado com a prova das 2 consultas';
  END IF;
  RAISE NOTICE 'BAIXA_MANUAL_PV13600_OK';
END
$post$;
