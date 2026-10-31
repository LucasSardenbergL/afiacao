-- ============================================================================================================
-- 20261031190000_radar_situacao_contato_por_cnpj.sql — Radar: o cron da RFB casa contato ↔ status por CNPJ.
-- Diário: docs/historico/radar-situacao-contato-por-cnpj.md.
--
-- Por quê (Codex P1 herdado, follow-up de docs/historico/radar-contato-integridade.md): no trecho (b) de
-- `radar_aplicar_situacao`, o contato `descartado` nascia do RETRATO (tmp_rfb_irreg: status e `status_anterior`
-- lidos antes) e o UPDATE do estado relia o status VIVO, sem trava. A conferência era só `v_leads_upd <> v_leads`.
-- Traço: depois do retrato, o vendedor leva X a virou_cliente e reabre Y (descartado → a_contatar). O contato sai
-- para X (que não muda) e o estado muda Y (sem contato): 1 = 1, a contagem passa. Com o vendedor no meio do UPDATE,
-- o `status_anterior` saía velho.
--
-- O que muda: SÓ o trecho (b). Um statement trava as linhas candidatas (FOR UPDATE OF re), lê o status e o
-- ja_cliente DA LINHA TRAVADA, muda o estado só delas (UPDATE … RETURNING) e insere o contato a partir do que o
-- UPDATE devolveu: contato ⇔ mudança por construção, com `status_anterior` da linha travada. A postcondição compara
-- os dois conjuntos por CNPJ (EXCEPT ALL nos dois sentidos), não pelos totais. (a) e (c), avisos e a regra de
-- negócio (03/04/08, vigente, cliente nunca descartado, virou_cliente/descartado intocados) não mudam: a prova
-- confere que o corpo novo, sem o trecho (b), é byte a byte o predecessor sem o trecho (b).
--
-- TRAVA → PRE (md5(prosrc) ∈ {predecessor de prod, este}) → CREATE OR REPLACE → ACL → PÓS (corpo, atributos, ACL).
-- Predecessor medido em prod (psql-ro, 2026-10-31): md5(prosrc) 73e049de2f5ec345daf0c8db81099e98,
-- md5(pg_get_functiondef) f00aae84dbd1b60d1473eca17e2e6fe5. Prova: db/test-radar-situacao-contato-por-cnpj.sh (núcleo do CI).
-- ============================================================================================================

SET LOCAL lock_timeout = '5s';

-- ── TRAVA: ALTER sem efeito (a volatilidade VIVA), ANTES de ler o corpo ──────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_aplicar_situacao(text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.radar_aplicar_situacao(text, timestamptz) não existe — o predecessor de prod é obrigatório';
  END IF;
  ALTER FUNCTION public.radar_aplicar_situacao(text, timestamptz) VOLATILE;
END
$trava$;

-- ── PRE: o corpo vivo é o predecessor revisado (psql-ro, 2026-10-31) ou já é este ───────────────────────────
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.radar_aplicar_situacao(text, timestamptz)'::regprocedure;
  IF v_vivo IS DISTINCT FROM '73e049de2f5ec345daf0c8db81099e98' AND v_vivo IS DISTINCT FROM '177667479ac9a1e7825f24ad63c1123b' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.radar_aplicar_situacao vivo tem md5 % (esperado o predecessor 73e049de2f5ec345daf0c8db81099e98 ou este 177667479ac9a1e7825f24ad63c1123b) — reler o corpo de prod antes de reaplicar',
      v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao(p_lote text, p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    WITH alvo AS (
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
$$;
COMMENT ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) IS
  'Finalize do lote do Radar: foto RFB → rfb_* em radar_empresas; lead 03/04/08 → descartado sob a trava da linha, com 1 contato (criado_por de sistema, status_anterior da linha travada) por mudança de estado, conferido por CNPJ; cliente 03/04/08 novo → 1 fornecedor_alerta por lote com denominador; dedupe por (cnpj, situacao) em alertado_em.';

-- ACL: a de prod (service_role e o owner executam; PUBLIC, anon e authenticated não). O REPLACE a preserva; o
-- REVOKE/GRANT só reafirma — a PÓS e a prova a LEEM antes de qualquer reaplicação.
REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) TO service_role;

-- ── PÓS: corpo (md5 exato), atributos e ACL ────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v record;
  f constant text := 'public.radar_aplicar_situacao(text, timestamptz)';
BEGIN
  SELECT md5(p.prosrc) AS md5, p.prosecdef, p.provolatile, p.proconfig,
         (SELECT count(*) FROM pg_catalog.pg_proc o WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) AS sobrecargas
    INTO v FROM pg_catalog.pg_proc p WHERE p.oid = f::regprocedure;
  IF v.md5 IS DISTINCT FROM '177667479ac9a1e7825f24ad63c1123b' THEN
    RAISE EXCEPTION 'PÓS FALHOU: % ficou com md5 % (esperado 177667479ac9a1e7825f24ad63c1123b)', f, v.md5;
  END IF;
  IF NOT v.prosecdef OR v.provolatile <> 'v' OR v.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'PÓS FALHOU: % perdeu atributos (secdef %, vol %, config %)', f, v.prosecdef, v.provolatile, v.proconfig;
  END IF;
  IF v.sobrecargas <> 1 THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.radar_aplicar_situacao tem % sobrecargas (esperado 1)', v.sobrecargas;
  END IF;
  IF has_function_privilege('public', f, 'EXECUTE')
     OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: ACL de % (PUBLIC/anon/authenticated não executam; service_role executa)', f;
  END IF;

  RAISE NOTICE 'VALIDADO 20261031190000: radar_aplicar_situacao casa contato e estado por CNPJ sob a trava da linha';
END
$post$;
