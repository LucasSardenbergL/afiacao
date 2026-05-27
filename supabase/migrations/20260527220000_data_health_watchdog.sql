-- Sentinela Ativo (2/2): cron que alerta na transição ok→degradado pros 4 domínios não-financeiros
-- (vendas/estoque/reposição/carteira). Espelha o padrão provado do fin_sync_watchdog: INSERT em
-- fin_alertas com UNIQUE parcial (company,tipo) WHERE dismissed_at IS NULL (anti-spam) + IF FOUND
-- enfileira email em fornecedor_alerta (drenado por dispatch-notifications); dismiss no ok.
-- Financeiro fica com o fin_sync_watchdog (donos por domínio; tipos data_health_* vs sync_* não colidem).
-- company='oben' é carrier (CHECK não aceita 'global'; o heartbeat já usa 'oben'); o tipo único por
-- source faz o dedup. Severidade: critical→critico/urgente, warning→aviso/atencao.

CREATE OR REPLACE FUNCTION public.data_health_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores')
  LOOP
    v_sev_fin  := CASE WHEN r.severity = 'critical' THEN 'critico' ELSE 'aviso' END;
    v_sev_forn := CASE WHEN r.severity = 'critical' THEN 'urgente' ELSE 'atencao' END;
    IF r.status <> 'ok' THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES ('oben', 'data_health_' || r.source, v_sev_fin, r.message,
              jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                                 'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source, r.message, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;

-- Heartbeat: estende o existente com a seção de saúde de dados (1 email diário consolidado).
CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_resumo text;
  v_ativos int;
  v_dh_ativos int;
  v_dh_resumo text;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: %s', co, re, COALESCE(to_char(m.mx, 'DD/MM HH24:MI'), 'NUNCA')) AS linha
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
  WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores');

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          '[Watchdog OK] '||to_char(now(),'DD/MM'),
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||
          E'.\n\nÚltimo sync OK por empresa/recurso:\n'||COALESCE(v_resumo,'(sem dados)')||
          E'\n\nSaúde de dados — alertas ativos: '||v_dh_ativos||
          E'.\nChecks (vendas/estoque/reposição/carteira):\n'||COALESCE(v_dh_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$$;

-- Cron: função SQL local (roda como postgres, dono) — sem net.http_post, logo sem a armadilha
-- do timeout de 5s. Upsert por nome (idempotente).
SELECT cron.schedule('data-health-watchdog', '*/30 * * * *',
  $$SELECT public.data_health_watchdog()$$);
