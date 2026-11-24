-- Limpeza de 10 PVs da OBEN que foram EXCLUÍDOS direto no Omie e seguiam no app contando como venda.
-- Fatia 1A da reconciliação de PV excluído (incidente PV 13693 / PR #4082; diagnóstico 2026-11-21).
--
-- Prova da ausência (2026-11-21, sessão sad-wilson-584ca2):
--   1. ListarPedidos COMPLETO da Oben (13.541 PVs, paginado até página vazia) não contém nenhum destes códigos;
--   2. ConsultarPedido({codigo_pedido}) de CADA UM respondeu o fault integral
--      "ERROR: Pedido não cadastrado para o Código [<codigo>] !" — o código citado é o consultado.
--   Os outros 8 ausentes da listagem da Oben e os 11 da Colacor NÃO entram: sem a 2ª prova (o Omie respondeu
--   425/bloqueio ou não foram consultados). O FATURADO ausente da Colacor fica para revisão humana.
--
-- Efeito: deleted_at = now() nas linhas (importada canônica + a linha do app do PV 12231), status preservado,
-- sem DELETE. Os KPIs de venda filtram deleted_at IS NULL. Nenhuma reserva ativa existe (pré-voo), mas a
-- postcondição confere que nenhuma ficou ativa nesses PVs.
-- Pré-voo psql-ro 2026-11-21: 11 linhas não-deletadas (10 importado + 1 app 'enviado'), R$ 9.566,40.
-- Aplicar: bun run db:aplicar db/2026-11-21-limpeza-pvs-excluidos-omie.sql (sem BEGIN/COMMIT: o executor abre).

UPDATE public.sales_orders
   SET deleted_at = now()
 WHERE account = 'oben'
   AND omie_pedido_id IN (12049288140, 12121835342, 12121839465, 12122021156, 12136268451,
                          12156020937, 12158135460, 12169921125, 12172563575, 12172847394)
   AND deleted_at IS NULL
   AND status IN ('importado', 'separacao', 'enviado');

DO $post$
DECLARE
  v_vivas integer;
  v_apagadas integer;
BEGIN
  SELECT count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL)
    INTO v_vivas, v_apagadas
    FROM public.sales_orders
   WHERE account = 'oben'
     AND omie_pedido_id IN (12049288140, 12121835342, 12121839465, 12122021156, 12136268451,
                            12156020937, 12158135460, 12169921125, 12172563575, 12172847394);
  IF v_vivas IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P1_FALHOU: % linha(s) desses PVs seguem sem deleted_at (status fora de importado/separacao/enviado?)', v_vivas;
  END IF;
  IF v_apagadas IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'P2_FALHOU: esperado 11 linhas apagadas (10 importadas + 1 do app), achei %', v_apagadas;
  END IF;
  IF EXISTS (SELECT 1 FROM public.estoque_reservas
              WHERE status = 'ativa' AND omie_account = 'oben'
                AND omie_pedido_id IN (12049288140, 12121835342, 12121839465, 12122021156, 12136268451,
                                       12156020937, 12158135460, 12169921125, 12172563575, 12172847394)) THEN
    RAISE EXCEPTION 'P3_FALHOU: reserva ativa num PV excluído';
  END IF;
  RAISE NOTICE 'LIMPEZA_PV_EXCLUIDO_OK: 10 PVs, 11 linhas com deleted_at';
END
$post$;
