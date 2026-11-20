-- Corpos VIVOS de prod (pg_get_functiondef via psql-ro, 2026-11-20) — predecessora da 20261120170000_radar_situacao_em_fatias.
-- md5(prosrc): radar_rfb_descricao ec7507207ea2717a3aa07d513ae8b9e5 · radar_aplicar_situacao 3b99d4ddd83b8b49b1a2965439d56002 ·
-- radar_aplicar_situacao_pendente a99fd7dbdd0c8590698546b162f1a68f. db/test-radar-situacao-fatias.sh confere (A0).
CREATE OR REPLACE FUNCTION public.radar_rfb_descricao(p_situacao text, p_data date, p_motivo_codigo text, p_motivo_descricao text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT 'RFB: '
      || CASE p_situacao WHEN '03' THEN 'SUSPENSA' WHEN '04' THEN 'INAPTA' WHEN '08' THEN 'BAIXADA'
                         WHEN '02' THEN 'ATIVA' WHEN '01' THEN 'NULA' ELSE 'situação ' || COALESCE(p_situacao, '?') END
      || ' em ' || COALESCE(to_char(p_data, 'DD/MM/YYYY'), 'data não informada')
      || ' (' || COALESCE(NULLIF(btrim(p_motivo_codigo), '') || ' — ' || NULLIF(btrim(p_motivo_descricao), ''),
                          NULLIF(btrim(p_motivo_codigo), ''), 'motivo não informado') || ')';
$function$

;

CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao(p_lote text, p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_sistema      constant uuid := '00000000-0000-0000-0000-00000000ad0f';  -- Radar · RFB (automático)
  v_fotos        integer := 0;
  v_leads        integer := 0;
  v_leads_upd    integer := 0;
  v_verificados  integer := 0;
  v_irregulares  integer := 0;
  v_novos        integer := 0;
  v_marcados     integer := 0;
  v_alerta_id    bigint;
  v_linhas       text;
  v_omitidos     integer := 0;
  c_teto_linhas  constant integer := 100;  -- o 1º lote traz o BACKLOG (medido: 2.553 clientes irregulares); o e-mail lista os 100 mais recentes
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'lote inválido: %', COALESCE(p_lote, '(null)') USING ERRCODE = '22023';
  END IF;
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  -- Documentos de clientes, uma vez por chamada (pode ser chamada 2× na mesma transação: DROP antes).
  DROP TABLE IF EXISTS tmp_rfb_clientes;
  CREATE TEMP TABLE tmp_rfb_clientes ON COMMIT DROP AS
    SELECT doc, nome FROM public.radar_docs_clientes();
  CREATE INDEX ON tmp_rfb_clientes (doc);

  -- (a) Foto do lote → radar_empresas. Nunca regride para lote mais velho; só grava quando muda.
  UPDATE public.radar_empresas re
     SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao, rfb_situacao_lote = s.lote,
         updated_at = p_agora
    FROM public.radar_situacao_cadastral s
   WHERE s.lote = p_lote AND s.cnpj = re.cnpj
     AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= p_lote)
     AND (re.rfb_situacao IS DISTINCT FROM s.situacao
          OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao
          OR re.rfb_situacao_lote IS DISTINCT FROM s.lote);
  GET DIAGNOSTICS v_fotos = ROW_COUNT;

  -- Irregulares do lote (03/04/08), classificados: cliente = ja_cliente OU documento nas fontes.
  DROP TABLE IF EXISTS tmp_rfb_irreg;
  CREATE TEMP TABLE tmp_rfb_irreg ON COMMIT DROP AS
    SELECT s.cnpj, s.situacao, s.data_situacao, s.motivo_codigo, s.motivo_descricao,
           re.prospeccao_status, re.razao_social,
           (re.cnpj IS NOT NULL) AS no_radar,
           -- vigente: o lote não é mais velho do que a foto já conhecida da empresa (re-rodar um mês
           -- antigo não descarta nem avisa com dado superado; fora do radar não há memória → vigente).
           (re.cnpj IS NULL OR COALESCE(re.rfb_situacao_lote, p_lote) <= p_lote) AS vigente,
           (COALESCE(re.ja_cliente, false) OR c.doc IS NOT NULL) AS cliente,
           c.nome AS nome_cliente,
           public.radar_rfb_descricao(s.situacao, s.data_situacao, s.motivo_codigo, s.motivo_descricao) AS descricao
      FROM public.radar_situacao_cadastral s
      LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
      LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
     WHERE s.lote = p_lote AND s.situacao IN ('03','04','08');

  -- (b) LEAD irregular → descartado (append no histórico + estado). Re-rodar o lote: já descartado → 0.
  -- Contato ⇔ mudança, por CNPJ e por construção: trava a linha (FOR UPDATE), lê o status DELA, muda o estado só
  -- das linhas travadas e insere o contato a partir do que o UPDATE devolveu. O retrato (tmp_rfb_irreg) só aponta
  -- os candidatos: status e ja_cliente valem na linha travada (o vendedor pode ter mexido depois do retrato).
  DECLARE
    v_diverge boolean;
  BEGIN
    WITH alvo AS MATERIALIZED (
      SELECT re.cnpj, re.prospeccao_status AS status_anterior, i.descricao
        FROM public.radar_empresas re
        JOIN tmp_rfb_irreg i ON i.cnpj = re.cnpj
       WHERE i.no_radar AND i.vigente AND NOT i.cliente
         AND NOT COALESCE(re.ja_cliente, false)
         AND re.prospeccao_status NOT IN ('descartado', 'virou_cliente')
         FOR UPDATE OF re
    ), estado AS (
      UPDATE public.radar_empresas re
         SET prospeccao_status = 'descartado', descarte_motivo = a.descricao,
             prospeccao_atualizado_em = p_agora, updated_at = p_agora
        FROM alvo a
       WHERE re.cnpj = a.cnpj
      RETURNING re.cnpj, a.status_anterior, a.descricao
    ), contato AS (
      INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior, created_at)
      SELECT e.cnpj, 'descartado', e.descricao, c_sistema, e.status_anterior, p_agora
        FROM estado e
      RETURNING cnpj, status_anterior
    )
    SELECT (SELECT count(*) FROM contato), (SELECT count(*) FROM estado),
           EXISTS ((SELECT cnpj, status_anterior FROM estado EXCEPT ALL SELECT cnpj, status_anterior FROM contato)
                   UNION ALL
                   (SELECT cnpj, status_anterior FROM contato EXCEPT ALL SELECT cnpj, status_anterior FROM estado))
      INTO v_leads, v_leads_upd, v_diverge;
    -- Postcondição por CNPJ, não pelos totais: dois conjuntos diferentes do mesmo tamanho passavam pela contagem.
    IF v_diverge THEN
      RAISE EXCEPTION 'radar_aplicar_situacao: contato (%) e estado (%) divergiram por CNPJ no descarte do lote %',
        v_leads, v_leads_upd, p_lote USING ERRCODE = '25000';
    END IF;
  END;

  -- (c) CLIENTE irregular NOVO: nunca avisado para o mesmo (cnpj, situacao) — em lote nenhum.
  DROP TABLE IF EXISTS tmp_rfb_novos;
  CREATE TEMP TABLE tmp_rfb_novos ON COMMIT DROP AS
    SELECT i.*
      FROM tmp_rfb_irreg i
     WHERE i.cliente AND i.vigente
       AND NOT EXISTS (SELECT 1 FROM public.radar_situacao_cadastral a
                        WHERE a.cnpj = i.cnpj AND a.situacao = i.situacao AND a.alertado_em IS NOT NULL);

  SELECT count(*) INTO v_irregulares FROM tmp_rfb_irreg WHERE cliente AND vigente;
  SELECT count(*) INTO v_novos FROM tmp_rfb_novos;
  -- Denominador: clientes distintos com linha de situação NESTE lote (dentro e fora do radar).
  SELECT count(DISTINCT s.cnpj) INTO v_verificados
    FROM public.radar_situacao_cadastral s
    LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
    LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
   WHERE s.lote = p_lote AND (COALESCE(re.ja_cliente, false) OR c.doc IS NOT NULL);

  IF v_novos > 0 THEN
    -- Teto de linhas no e-mail (baixas mais recentes primeiro); a lista COMPLETA fica na tabela
    -- (radar_situacao_cadastral.alertado_em do lote) e em metadata.cnpjs — o dedupe marca todos.
    SELECT string_agg(
             COALESCE(NULLIF(btrim(n.razao_social), ''), NULLIF(btrim(n.nome_cliente), ''), 'razão social não informada')
             || ' (' || substr(n.cnpj, 1, 2) || '.' || substr(n.cnpj, 3, 3) || '.' || substr(n.cnpj, 6, 3)
             || '/' || substr(n.cnpj, 9, 4) || '-' || substr(n.cnpj, 13, 2) || '): ' || n.descricao,
             E'\n' ORDER BY n.situacao DESC, n.data_situacao DESC NULLS LAST, n.cnpj)
      INTO v_linhas
      FROM (SELECT * FROM tmp_rfb_novos
             ORDER BY situacao DESC, data_situacao DESC NULLS LAST, cnpj
             LIMIT c_teto_linhas) n;
    v_omitidos := GREATEST(v_novos - c_teto_linhas, 0);
    IF v_omitidos > 0 THEN
      v_linhas := v_linhas || E'\n… e mais ' || v_omitidos || ' cliente(s) — lista completa em radar_situacao_cadastral (lote '
        || p_lote || ', alertado_em preenchido) e no campo metadata deste alerta.';
    END IF;

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES (
      'oben', 'outro', 'atencao',
      '[Radar] ' || v_novos || ' cliente(s) com baixa/inaptidão no lote ' || p_lote,
      'Clientes com situação cadastral irregular na Receita Federal (dump de CNPJ ' || p_lote || '), '
        || 'vistos pela primeira vez nesta situação:' || E'\n\n' || v_linhas || E'\n\n'
        || 'de ' || v_verificados || ' clientes verificados neste lote ('
        || v_irregulares || ' irregular(es) no total, ' || v_novos || ' novo(s)). '
        || 'Fonte: dados abertos de CNPJ da RFB — confira o cartão CNPJ antes de agir; '
        || 'leads na mesma situação foram descartados automaticamente no Radar.',
      'pendente_notificacao',
      jsonb_build_object('origem', 'radar_situacao_cadastral', 'lote', p_lote,
                         'cnpjs', (SELECT jsonb_agg(cnpj ORDER BY cnpj) FROM tmp_rfb_novos))
    )
    RETURNING id INTO v_alerta_id;
    IF v_alerta_id IS NULL THEN
      RAISE EXCEPTION 'radar_aplicar_situacao: fornecedor_alerta não materializou o aviso do lote %', p_lote
        USING ERRCODE = '25000';
    END IF;

    UPDATE public.radar_situacao_cadastral a
       SET alertado_em = p_agora
      FROM tmp_rfb_novos n
     WHERE a.cnpj = n.cnpj AND a.lote = p_lote;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> v_novos THEN
      RAISE EXCEPTION 'radar_aplicar_situacao: alertado_em marcou % de % linhas no lote %', v_marcados, v_novos, p_lote
        USING ERRCODE = '25000';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'lote', p_lote,
    'fotos_atualizadas', v_fotos,
    'leads_descartados', v_leads,
    'clientes_verificados', v_verificados,
    'clientes_irregulares', v_irregulares,
    'clientes_alertados_novos', v_novos,
    'alerta_id', v_alerta_id
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao_pendente(p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini        timestamptz := clock_timestamp();
  r            record;
  v_mais_novo  text;
  v_res        jsonb;
  v_lotes      jsonb := '[]'::jsonb;
  v_aplicados  integer := 0;
  v_marcados   integer;
BEGIN
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'radar_aplicar_situacao_pendente: p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  SELECT max(mes_referencia) INTO v_mais_novo FROM public.radar_ingest_state WHERE status = 'complete';

  FOR r IN
    SELECT mes_referencia, finalizado_em
      FROM public.radar_ingest_state
     WHERE status = 'complete'
       AND finalizado_em IS NOT NULL
       AND situacao_aplicada_fechamento IS DISTINCT FROM finalizado_em
     ORDER BY mes_referencia
     FOR UPDATE SKIP LOCKED
  LOOP
    IF r.mes_referencia = v_mais_novo THEN
      v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);
      v_aplicados := v_aplicados + 1;
    ELSE
      -- Foto superada: aplicar descartaria/alertaria por situação que o lote mais novo já pode ter revertido.
      v_res := jsonb_build_object('lote', r.mes_referencia, 'superado_por', v_mais_novo);
    END IF;

    UPDATE public.radar_ingest_state
       SET situacao_aplicada_fechamento = r.finalizado_em, situacao_aplicada_em = p_agora,
           situacao_resultado = v_res
     WHERE mes_referencia = r.mes_referencia AND status = 'complete' AND finalizado_em = r.finalizado_em;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> 1 THEN
      RAISE EXCEPTION 'radar_aplicar_situacao_pendente: marcou % linha(s) para o lote % (esperado 1)', v_marcados, r.mes_referencia
        USING ERRCODE = '25000';
    END IF;
    v_lotes := v_lotes || v_res;
  END LOOP;

  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.aplicar_situacao', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('lotes', v_lotes, 'aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes)));
  END IF;

  RETURN jsonb_build_object('aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes), 'lotes', v_lotes);
END;
$function$

;

