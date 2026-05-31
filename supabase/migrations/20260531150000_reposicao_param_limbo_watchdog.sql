-- Reposição — guardrail anti-regressão do limbo "habilitado + params NULL"
-- ============================================================================
-- Contexto: o #521 corrigiu a causa-raiz (atualizar_parametros_numericos_skus parou de ZERAR params
-- de SKU não-OK). Há um baseline benigno de ~146 SKUs habilitado+params-NULL (auto-recuperáveis: o cron
-- com COALESCE repreenche quando voltam a status OK; decisão: NÃO desabilitar). Como o baseline é
-- benigno e esperado, um alerta de VALOR ABSOLUTO daria ruído. Este guardrail é de DELTA: alerta só num
-- SALTO súbito (= regressão — alguém removeu o COALESCE / outro caminho voltou a zerar config em massa).
--
-- Watchdog DEDICADO e ISOLADO (NÃO toca o _data_health_compute do Sentinela — arquivo quente multi-sessão,
-- 4 cascatas no §5). Padrão de alerta idêntico ao fin_sync_watchdog (fin_alertas anti-spam + enfileira
-- fornecedor_alerta no IF FOUND + dismiss no else). SQL-local (sem net.http_post → sem armadilha do 5s).

-- 1) Log diário do count (1 linha/empresa/dia)
CREATE TABLE IF NOT EXISTS public.reposicao_param_limbo_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa text NOT NULL,
  medido_em date NOT NULL DEFAULT CURRENT_DATE,
  limbo_count int NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reposicao_param_limbo_log_dia
  ON public.reposicao_param_limbo_log (empresa, medido_em);

-- 2) Watchdog de delta
CREATE OR REPLACE FUNCTION public.reposicao_param_limbo_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_limiar   int := 30;     -- salto que dispara (regressão zeraria dezenas de uma vez)
  v_atual    int;
  v_anterior int;
  v_msg      text;
BEGIN
  -- limbo atual (reposição é OBEN-only; sku_parametros usa 'OBEN' maiúsculo)
  SELECT count(*) INTO v_atual
  FROM sku_parametros
  WHERE empresa = 'OBEN' AND habilitado_reposicao_automatica = true
    AND (ponto_pedido IS NULL OR estoque_maximo IS NULL);

  -- último count registrado ANTES de hoje (baseline pra comparar)
  SELECT limbo_count INTO v_anterior
  FROM reposicao_param_limbo_log
  WHERE empresa = 'OBEN' AND medido_em < CURRENT_DATE
  ORDER BY medido_em DESC
  LIMIT 1;

  -- alerta só no SALTO (regressão); fin_alertas usa company minúsculo (CHECK)
  IF v_anterior IS NOT NULL AND (v_atual - v_anterior) > v_limiar THEN
    v_msg := 'SKUs habilitados SEM parâmetro saltaram de ' || v_anterior || ' para ' || v_atual ||
             ' (+' || (v_atual - v_anterior) || ') em 1 dia — possível regressão: o cron voltou a ZERAR ' ||
             'config (verificar se atualizar_parametros_numericos_skus ainda usa COALESCE — fix #521).';
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, valor, threshold, contexto)
    VALUES ('oben', 'reposicao_param_limbo_salto', 'critico', v_msg, v_atual, (v_anterior + v_limiar),
            jsonb_build_object('atual', v_atual, 'anterior', v_anterior, 'delta', (v_atual - v_anterior), 'limiar', v_limiar))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES ('OBEN', 'outro', 'urgente', '[Reposição] Salto de SKUs sem parâmetro', v_msg, 'pendente_notificacao');
    END IF;
  ELSE
    UPDATE fin_alertas SET dismissed_at = now()
    WHERE company = 'oben' AND tipo = 'reposicao_param_limbo_salto' AND dismissed_at IS NULL;
  END IF;

  -- grava o snapshot do dia (idempotente — rerun no mesmo dia atualiza)
  INSERT INTO reposicao_param_limbo_log (empresa, medido_em, limbo_count)
  VALUES ('OBEN', CURRENT_DATE, v_atual)
  ON CONFLICT (empresa, medido_em) DO UPDATE SET limbo_count = EXCLUDED.limbo_count, criado_em = now();
END;
$$;

-- 3) Cron diário (após o omie-cron-diario que roda atualizar_parametros_numericos_skus). SQL-local.
SELECT cron.schedule('reposicao-param-limbo-watchdog', '30 11 * * *',
  $cron$ SELECT public.reposicao_param_limbo_watchdog(); $cron$);
