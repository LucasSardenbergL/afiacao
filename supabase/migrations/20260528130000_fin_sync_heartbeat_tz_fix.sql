-- ============================================================
-- Fix do heartbeat do watchdog: fuso horário + título honesto
-- ============================================================
-- Bug observado no email "[Watchdog OK]": a lista "Último sync OK por
-- empresa/recurso" mostrava horários À FRENTE do horário do rodapé do email
-- (ex.: rodapé 08:00 BRT, corpo "colacor/movimentacoes: 10:50") — parecendo
-- timestamps no futuro.
--
-- CAUSA: fin_sync_log.completed_at é timestamptz; o corpo era montado com
-- to_char(mx, ...) SEM "AT TIME ZONE", então renderizava no fuso da SESSÃO do
-- Postgres (= UTC no Supabase). Já o rodapé é escrito pelo dispatch-notifications
-- (Deno) em America/Sao_Paulo (BRT, UTC-3). Corpo em UTC + rodapé em BRT = +3h
-- aparente. (Confirmado com codex: AT TIME ZONE 'America/Sao_Paulo' sobre um
-- timestamptz devolve o relógio-de-parede local, robusto independente do fuso
-- da sessão.)
--
-- 2º cheiro: título fixo "[Watchdog OK]" mesmo com "Alertas de sync ativos: 1",
-- sem listar QUAL alerta → falsa tranquilidade. Agora:
--   - todo horário exibido (corpo + data do título) passa por AT TIME ZONE BRT;
--   - o título deixa de dizer "OK" quando há QUALQUER alerta ativo (sync + saúde
--     de dados) e mostra a contagem;
--   - o corpo lista os alertas de sync ativos (empresa/tipo + desde quando).
-- O heartbeat continua dead-man-switch informativo (severidade 'info'); o alerta
-- de incidente real segue sendo enviado por fin_sync_watchdog_check /
-- data_health_watchdog na transição ok->problema.

CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_resumo text;
  v_ativos int;
  v_lista_ativos text;
  v_dh_ativos int;
  v_dh_resumo text;
  v_titulo text;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  -- quais alertas de sync estão ativos (empresa/tipo + desde quando), em BRT
  SELECT string_agg(
           format('%s/%s (desde %s)', company, tipo,
                  to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')),
           E'\n' ORDER BY company, tipo)
    INTO v_lista_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: %s', co, re,
                  COALESCE(to_char(m.mx AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'NUNCA')) AS linha
    FROM unnest(ARRAY['oben','colacor','colacor_sc']) AS co
    CROSS JOIN unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS re
    CROSS JOIN LATERAL (
      SELECT max(l.completed_at) AS mx FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||re AND co = ANY(l.companies)
    ) m
  ) s;

  SELECT count(*) INTO v_dh_ativos
  FROM fin_alertas WHERE tipo LIKE 'data_health_%' AND dismissed_at IS NULL;

  SELECT string_agg(format('%s: %s', source, status), E'\n' ORDER BY source) INTO v_dh_resumo
  FROM public._data_health_compute()
  WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores','alert_channel');

  -- título deixa de dizer "OK" quando há QUALQUER alerta ativo (sync + saúde de dados)
  v_titulo := '[Watchdog'
              || CASE WHEN (v_ativos + v_dh_ativos) > 0
                   THEN ': '||(v_ativos + v_dh_ativos)||' alerta(s) ativo(s)'
                   ELSE ' OK' END
              || '] '||to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM');

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          v_titulo,
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||'.'||
          CASE WHEN v_ativos > 0 THEN E'\n'||COALESCE(v_lista_ativos,'') ELSE '' END||
          E'\n\nÚltimo sync OK por empresa/recurso (horário de Brasília):\n'||COALESCE(v_resumo,'(sem dados)')||
          E'\n\nSaúde de dados — alertas ativos: '||v_dh_ativos||
          E'.\nChecks (vendas/estoque/reposição/carteira/canal):\n'||COALESCE(v_dh_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$$;
