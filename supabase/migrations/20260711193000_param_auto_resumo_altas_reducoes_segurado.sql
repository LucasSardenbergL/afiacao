-- Reposição — resumo diário: mostrar REDUÇÕES e LISTAR o item segurado pelo nome
-- ============================================================================
-- O e-mail "Parâmetros de reposição — resumo do dia" tinha DOIS pontos cegos (feedback do founder):
--
--   (1) SÓ mostrava acréscimo de capital, nunca redução. A lista única ordenava por
--       `impacto_rs DESC LIMIT 10` → os itens de impacto NEGATIVO (parâmetro que caiu e LIBEROU
--       capital) ficavam no fim e eram cortados quando havia mais de 10 aplicados no dia. O total do
--       run já é líquido (soma os negativos), então "não fechava" com a lista visível — e o founder
--       perdia de vista justamente a economia de capital.
--
--   (2) O rodapé "Segurados pelo fusível (confira): N" dizia "confira" mas NÃO dizia O QUÊ. Para
--       saber qual item o fusível travou, só na tela /admin/reposicao/mudancas-automaticas.
--
-- CORREÇÃO (só apresentação — o cálculo do impacto/segurado e o total do run NÃO mudam):
--   • Duas listas separadas: "Maiores altas" (impacto>0, DESC) e "Maiores reduções" (impacto<0, ASC) —
--     as reduções nunca competem com as altas pelo LIMIT, então SEMPRE aparecem quando existem.
--   • Cada seção só é renderizada quando tem item (sem "Maiores reduções:\n—" órfão).
--   • Sob "Segurados pelo fusível" agora vêm os itens pelo NOME (máx atual + giro), top 5.
--   • Aplicados de impacto exatamente 0 (parâmetro mudou mas não muda a compra de hoje) saem das
--     listas e viram um contador discreto — o cabeçalho já rotula os de custo ausente ("+N sem custo").
--
-- Fallback (money-path: ausente ≠ vazio) PRESERVADO: descrição NULL/só-espaços → cai no código
-- (coalesce + nullif(btrim(...))); demanda/máx ausentes → '?'/'—', nunca rótulo vazio.
--
-- CREATE OR REPLACE: pré-flight pg_get_functiondef da prod em 2026-07-11 — corpo vivo IDÊNTICO à
-- 20260619120000 (sem drift). "A última a recriar vence" → aplicar ESTA por último no SQL Editor.
-- Provado em PostgreSQL 17 local (db/test-param-auto.sh): altas só-positivas · reduções aparecem
-- (cenário M −300) · segurado pelo nome · fallback NULL/espaços · seção vazia omitida · falsificação
-- (voltar ao DESC-LIMIT-10 → a redução some = P-reduções VERMELHO; voltar a só-contador → segurado
-- VERMELHO).
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE
  r record;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_corpo text;
  v_altas text;       -- aplicados com impacto > 0 (capital que SUBIU), top 5 DESC
  v_reducoes text;    -- aplicados com impacto < 0 (capital LIBERADO), top 5 ASC
  v_segurados text;   -- itens travados pelo fusível, pelo NOME, top 5
  v_sem_efeito int;   -- aplicados com impacto EXATAMENTE 0 (mudou o parâmetro, não a compra de hoje)
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_resumo'));  -- serializa ticks concorrentes (anti-duplo-email)
  -- v1 OBEN-only: processa 1 run por tick e o corpo do e-mail rotula "(OBEN)". Se um dia houver multi-empresa, trocar por um loop por empresa (senão a 2ª empresa do dia não recebe digest).
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;  -- nada relevante
    RETURN;
  END IF;

  -- ── Maiores ALTAS (impacto > 0): capital que subiu. Rótulo = descrição; cai no código se faltar. ──
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s (R$ +%s)',
            coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            round(impacto_rs)::text), E'\n' ORDER BY impacto_rs DESC)
    INTO v_altas FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='aplicado' AND impacto_rs > 0
      ORDER BY impacto_rs DESC LIMIT 5) t;

  -- ── Maiores REDUÇÕES (impacto < 0): capital liberado. Lista PRÓPRIA → nunca cortada pelas altas. ──
  -- round(impacto_rs) já traz o sinal '-' (ex.: -300 → "R$ -300").
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s (R$ %s)',
            coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            round(impacto_rs)::text), E'\n' ORDER BY impacto_rs ASC)
    INTO v_reducoes FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='aplicado' AND impacto_rs < 0
      ORDER BY impacto_rs ASC LIMIT 5) t;

  -- ── SEGURADOS pelo fusível, pelo NOME (o "confira" agora diz o quê). Contexto: máx atual + giro. ──
  SELECT string_agg(format('• %s (máx atual %s, giro %s/dia)',
            coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
            coalesce(estoque_maximo_antes::text,'—'),
            coalesce(round(demanda_media_diaria, 2)::text,'?')), E'\n' ORDER BY estoque_maximo_antes DESC NULLS LAST)
    INTO v_segurados FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='segurado'
      ORDER BY estoque_maximo_antes DESC NULLS LAST LIMIT 5) t;

  -- Aplicados de impacto EXATAMENTE 0 (parâmetro mudou, compra de hoje não). NULL já conta em impacto_desconhecido_n.
  SELECT count(*) INTO v_sem_efeito FROM public.reposicao_param_auto_log
    WHERE run_id=r.id AND status='aplicado' AND impacto_rs = 0;

  -- ── Montagem (seções vazias omitidas graciosamente) ──
  v_corpo :=
       format('%s parâmetros mudaram hoje (OBEN).', r.total_aplicados)
    || format(E'\nImpacto estimado total: R$ %s%s', round(COALESCE(r.impacto_total_rs,0)),
         CASE WHEN COALESCE(r.impacto_desconhecido_n,0)>0 THEN ' (+'||r.impacto_desconhecido_n||' sem custo)' ELSE '' END)
    || CASE WHEN v_altas    IS NOT NULL THEN E'\n\nMaiores altas:\n'    || v_altas    ELSE '' END
    || CASE WHEN v_reducoes IS NOT NULL THEN E'\n\nMaiores reduções:\n' || v_reducoes ELSE '' END
    || format(E'\n\nSegurados pelo fusível (confira): %s', COALESCE(r.total_segurados,0))
    || CASE WHEN v_segurados IS NOT NULL THEN E'\n' || v_segurados ELSE '' END
    || CASE WHEN COALESCE(v_sem_efeito,0) > 0
            THEN format(E'\n\n+%s ajuste(s) sem efeito na compra de hoje.', v_sem_efeito) ELSE '' END
    || E'\n\nVeja e reverta em: /admin/reposicao/mudancas-automaticas';

  INSERT INTO public.fornecedor_alerta (tipo, titulo, mensagem, empresa, severidade, status)
    VALUES ('param_auto_resumo', 'Parâmetros de reposição — resumo do dia', v_corpo, r.empresa, 'info', 'pendente_notificacao');
  UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reposicao_param_auto_resumo_tick() FROM anon, authenticated, public;

COMMIT;

SELECT 'param_auto_resumo_altas_reducoes_segurado OK' AS status;
