-- Corpo VIVO de public.data_health_watchdog() em PRODUÇÃO, capturado por pg_get_functiondef
-- via psql-ro em 2026-08-14. md5 = 3ca71a9df5faa9bbb6781fe2d8707fe9 (o pin do guard anti-drift
-- da migration 20260814222000). Serve ao harness PG17: sem esta base o guard aborta, e é
-- justamente ela que prova que o md5 pinado é o de prod. NÃO editar — é um retrato datado.
CREATE OR REPLACE FUNCTION public.data_health_watchdog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    -- ⚠️ estoque_reposicao: 18º check, adicionado DIRETO EM PROD (migration fora do repo, drift §5),
    --    promovido ao push (watchdog+heartbeat) lá. Descoberto no apply (total_checks=18 vs 17 do teste;
    --    o heartbeat, não-tocado, ainda o tinha). PRESERVADO aqui pra não revertê-lo do e-mail.
    WHERE source IN ('vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
                     'custos_produtos','vendas_cadastros',
                     'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
                     'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente',
                     'tint_cobertura_bases',
                     'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync')  -- [VIGIA tint 2026-06-15] só o Check A faz push; tint_vinculo_omie é dashboard-only
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
        -- DELTA [2026-07-08]: família-ausente E tint_cobertura_bases anexam a lista dos produtos ao
        -- corpo do e-mail (função dedicada _<check>_lista_email). COALESCE p/ não anexar se vier NULL
        -- (defensivo; o branch só roda com o check degradado, mas a lista pode zerar por corrida).
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source,
                CASE WHEN r.source = 'vendas_familia_ausente'
                     THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
                     WHEN r.source = 'tint_cobertura_bases'
                     THEN r.message || COALESCE(E'\n\n' || public._tint_cobertura_bases_lista_email(50), '')
                     ELSE r.message END,
                'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$function$

;
