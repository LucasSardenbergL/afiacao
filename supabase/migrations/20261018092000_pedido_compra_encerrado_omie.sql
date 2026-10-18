-- ============================================================
-- purchase_orders_tracking.encerrado_omie_em — pedido de compra ENCERRADO no Omie (money-path)
--
-- Por quê: o encerramento NÃO aparece no cabeçalho do PesquisarPedCompra (1014/1049/1032, encerrados
-- pelo founder, vêm com cEtapa="15"; até o webhook CompraProduto.Encerrada traz "15"). O único sinal
-- é o filtro lExibirPedidosEncerrados: a edge omie-sync-pedidos-compra faz uma passada SÓ de
-- encerrados depois do completo limpo e publica o conjunto aqui. O backtest do orçamento de compra
-- (R59) tira do caixa o disparado encerrado e sem NF.
--
-- Coluna DEDICADA, 1 writer: `status` já tem 2 escritores (este sync pelo cEtapa e o
-- omie-sync-nfes-recebidas com FATURADO/RECEBIDO) e sinal money-path nunca mora em coluna
-- multi-writer. O único writer é reposicao_marcar_encerrados_omie (service_role-only).
--
-- Semântica: encerrado_omie_em = quando a passada de encerrados viu o pedido encerrado pela 1ª vez
-- (o Omie não expõe a data real do encerramento). NULL = não visto encerrado na última passada
-- limpa que cobriu a previsão dele. Pedido marcado que some de uma passada limpa, com previsão
-- dentro da janela dela, volta a NULL (reaberto) — errar a limpeza devolve o pedido ao caixa, o
-- lado conservador.
-- ============================================================
BEGIN;

ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS encerrado_omie_em timestamptz;

COMMENT ON COLUMN public.purchase_orders_tracking.encerrado_omie_em IS
  'Pedido visto ENCERRADO no Omie pela passada lExibirPedidosEncerrados do omie-sync-pedidos-compra (1ª vez vista; não é a data real do encerramento). 1 writer: reposicao_marcar_encerrados_omie.';

-- Objeto NOVO: CREATE sem OR REPLACE na 1ª vez; re-colar é seguro pelo DROP do mesmo objeto desta
-- migration (nenhuma outra o define — conferido no pré-voo).
DROP FUNCTION IF EXISTS public.reposicao_marcar_encerrados_omie(public.empresa_reposicao, bigint[], date, date);
CREATE FUNCTION public.reposicao_marcar_encerrados_omie(
  p_empresa public.empresa_reposicao,
  p_ids bigint[],
  p_janela_de date,
  p_janela_ate date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ausentes int;
  v_novos int;
  v_limpos int;
  v_marcados int;
BEGIN
  IF p_empresa IS NULL OR p_ids IS NULL OR p_janela_de IS NULL OR p_janela_ate IS NULL
     OR p_janela_de > p_janela_ate THEN
    RAISE EXCEPTION 'reposicao_marcar_encerrados_omie: argumento ausente ou janela invertida'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_ids) AS x(id) WHERE x.id IS NULL OR x.id <= 0) THEN
    RAISE EXCEPTION 'reposicao_marcar_encerrados_omie: nCodPed nulo ou não positivo no conjunto'
      USING ERRCODE = '22023';
  END IF;

  -- 1 passada por empresa por vez: duas concorrentes não se limpam no meio
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_marcar_encerrados_omie:' || p_empresa::text));

  -- Todo encerrado precisa existir no espelho (o completo do MESMO run o upsertou antes). Ausente =
  -- upsert falhou ou a janela divergiu → aborta tudo (nada marcado, nada limpo).
  SELECT count(*) INTO v_ausentes
  FROM (SELECT DISTINCT x.id FROM unnest(p_ids) AS x(id)) i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.purchase_orders_tracking t
    WHERE t.empresa = p_empresa AND t.omie_codigo_pedido = i.id
  );
  IF v_ausentes > 0 THEN
    RAISE EXCEPTION 'reposicao_marcar_encerrados_omie: % encerrado(s) fora do espelho — passada recusada', v_ausentes
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.purchase_orders_tracking t
     SET encerrado_omie_em = now()
   WHERE t.empresa = p_empresa
     AND t.omie_codigo_pedido = ANY (p_ids)
     AND t.encerrado_omie_em IS NULL;
  GET DIAGNOSTICS v_novos = ROW_COUNT;

  -- Reaberto: marcado, fora do conjunto, com previsão DENTRO da janela da passada (o filtro do Omie
  -- é por dDtPrevisao). Previsão nula ou fora da janela não foi coberta → fica como está.
  UPDATE public.purchase_orders_tracking t
     SET encerrado_omie_em = NULL
   WHERE t.empresa = p_empresa
     AND t.encerrado_omie_em IS NOT NULL
     AND NOT (t.omie_codigo_pedido = ANY (p_ids))
     AND t.data_previsao_original BETWEEN p_janela_de AND p_janela_ate;
  GET DIAGNOSTICS v_limpos = ROW_COUNT;

  SELECT count(*) INTO v_marcados
  FROM public.purchase_orders_tracking t
  WHERE t.empresa = p_empresa AND t.encerrado_omie_em IS NOT NULL;

  RETURN jsonb_build_object('novos', v_novos, 'limpos', v_limpos, 'marcados', v_marcados);
END;
$$;

COMMENT ON FUNCTION public.reposicao_marcar_encerrados_omie(public.empresa_reposicao, bigint[], date, date) IS
  'Único writer de purchase_orders_tracking.encerrado_omie_em: marca o conjunto da passada de encerrados do Omie e limpa o reaberto dentro da janela. service_role-only.';

-- DROP+CREATE reseta o ACL: REVOKE nomeando as roles (PUBLIC E anon E authenticated)
REVOKE ALL ON FUNCTION public.reposicao_marcar_encerrados_omie(public.empresa_reposicao, bigint[], date, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_marcar_encerrados_omie(public.empresa_reposicao, bigint[], date, date)
  TO service_role;

DO $post$
DECLARE
  fn constant text := 'public.reposicao_marcar_encerrados_omie(public.empresa_reposicao,bigint[],date,date)';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders_tracking'
      AND column_name = 'encerrado_omie_em' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: purchase_orders_tracking.encerrado_omie_em ausente ou com tipo errado — a edge não tem onde publicar';
  END IF;
  IF to_regprocedure(fn) IS NULL THEN
    RAISE EXCEPTION 'A2 FALHOU: reposicao_marcar_encerrados_omie ausente — a passada de encerrados falha a cada run';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(fn)) THEN
    RAISE EXCEPTION 'A3 FALHOU: a função virou SECURITY DEFINER — deve ser INVOKER';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: anon/authenticated executam a função — qualquer cliente marcaria pedido como encerrado';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: service_role sem EXECUTE — a edge não consegue publicar';
  END IF;
  RAISE NOTICE 'encerrado_omie_em + reposicao_marcar_encerrados_omie ok (INVOKER, service_role-only)';
END
$post$;

COMMIT;
