-- Predecessoras do pacote G do Radar: pg_get_functiondef da PROD (psql-ro, 2026-11-08), sem edição.
-- Usada por db/test-radar-acompanhamento-g.sh: o md5(prosrc) destas definições é o 'predecessor' da PRE da
-- migration 20261111100000 (o teste confere). Não editar à mão: regenerar do banco se a PROD mudar.

-- public.registrar_contato_radar(text,text,text)
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(p_cnpj text, p_acao text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_codigo_atual text;
  v_motivo_atual text;
  v_atualizado_atual timestamptz;
  v_dono_atual uuid;
  v_confirmado boolean;
  v_agora timestamptz;
  v_existing uuid;
  v_id uuid;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido';
  END IF;
  IF p_acao IS NULL OR p_acao NOT IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente') THEN
    RAISE EXCEPTION 'ação inválida: %', p_acao;
  END IF;

  SELECT prospeccao_status, NULLIF(btrim(omie_codigo_cliente), ''), descarte_motivo, prospeccao_atualizado_em,
         prospeccao_contato_id
    INTO v_status_atual, v_codigo_atual, v_motivo_atual, v_atualizado_atual, v_dono_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Ausente ≠ confirmado: o vínculo que o cadastro gravou E a linha que o SERVIDOR gravou no ledger (o predicado de
  -- radar_registrar_cadastro_omie; o trigger radar_empresas_status_guard repete-o para todo caminho).
  v_confirmado := v_codigo_atual IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.omie_cliente_confirmacoes c
     WHERE c.account = 'oben' AND c.documento = p_cnpj AND c.codigo_cliente = v_codigo_atual);

  IF p_acao = 'virou_cliente' AND NOT v_confirmado THEN
    RAISE EXCEPTION 'RADAR_VIROU_CLIENTE_SEM_CONFIRMACAO: o CNPJ % não tem cliente confirmado no Omie/Oben — "virou cliente" vem do cadastro pelo Radar', p_cnpj
      USING ERRCODE = 'RD005';
  END IF;
  IF v_status_atual = 'virou_cliente' AND v_confirmado THEN
    -- Já é cliente confirmado: re-marcar não é conversão nova (o KPI do mês conta o carimbo) e tirar daí é do gestor.
    IF p_acao = 'virou_cliente' THEN
      SELECT id INTO v_existing FROM public.radar_contatos
       WHERE cnpj = p_cnpj AND acao = 'virou_cliente' ORDER BY created_at DESC, id DESC LIMIT 1;
      IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('id', v_existing, 'deduped', true);
      END IF;
    ELSIF NOT COALESCE(private.cap_carteira_ler(v_uid), false) THEN
      RAISE EXCEPTION 'RADAR_CLIENTE_CONFIRMADO: o CNPJ % é cliente confirmado no Omie/Oben — só o gestor muda o status', p_cnpj
        USING ERRCODE = 'RD007';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':'||p_acao||':radar', 0));
  -- Instante lido DEPOIS das travas: now() é o início da transação, e quem esperou não pode medir janela nem carimbar
  -- com o relógio de antes da espera.
  v_agora := clock_timestamp();
  -- Clique repetido só é o MESMO registro se ele ainda é o dono do status: alguém (gestor, cadastro, cron) mudou o lead
  -- no meio → é registro novo, não "já feito".
  SELECT id INTO v_existing FROM public.radar_contatos
   WHERE id = v_dono_atual AND criado_por = v_uid AND cnpj = p_cnpj AND acao = p_acao
     AND created_at > v_agora - interval '2 minutes';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, created_at,
                                     status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_agora,
          v_status_atual, v_motivo_atual, v_atualizado_atual, v_dono_atual)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = v_agora,
    prospeccao_contato_id = v_id,
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE NULL END,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$

;

-- public.desfazer_contato_radar(uuid)
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cnpj text;
  v_dono uuid;
  v_agora timestamptz;
  v_acao text;
  v_anterior text;
  v_motivo_anterior text;
  v_atualizado_anterior timestamptz;
  v_dono_anterior uuid;
  v_restaurou boolean := false;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT cnpj INTO v_cnpj FROM public.radar_contatos WHERE id = p_id AND criado_por = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'status_restaurado', false);
  END IF;

  SELECT prospeccao_contato_id INTO v_dono FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  v_agora := clock_timestamp();

  -- Relido SOB a trava, com a janela medida depois da espera.
  SELECT acao, status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id
    INTO v_acao, v_anterior, v_motivo_anterior, v_atualizado_anterior, v_dono_anterior
    FROM public.radar_contatos
   WHERE id = p_id AND criado_por = v_uid AND cnpj = v_cnpj AND created_at > v_agora - interval '5 minutes';
  IF NOT FOUND THEN  -- apagado por um desfazer concorrente, ou fora da janela
    RETURN jsonb_build_object('deleted', false, 'status_restaurado', false);
  END IF;

  -- A conversão confirmada fica no Omie e repetir o cadastro é no-op: apagar o contato só esconderia o cliente.
  IF v_acao = 'virou_cliente' THEN
    RAISE EXCEPTION 'RADAR_CONVERSAO_NAO_SE_DESFAZ: o contato % é a conversão do CNPJ % — o cliente continua no Omie', p_id, v_cnpj
      USING ERRCODE = 'RD006';
  END IF;

  -- Só o DONO restaura: outro contato (de qualquer usuário), o cadastro ou o cron escreveram depois → o status fica.
  IF v_dono IS NOT DISTINCT FROM p_id THEN
    UPDATE public.radar_empresas SET
      prospeccao_status = COALESCE(v_anterior, 'a_contatar'),
      descarte_motivo = v_motivo_anterior,
      prospeccao_atualizado_em = v_atualizado_anterior,
      -- O dono anterior apagado (desfeito fora de ordem) encerra a cadeia: nunca um substituto com a mesma ação.
      prospeccao_contato_id = (SELECT o.id FROM public.radar_contatos o WHERE o.id = v_dono_anterior AND o.cnpj = v_cnpj),
      updated_at = now()
    WHERE cnpj = v_cnpj;
    v_restaurou := true;
  END IF;

  -- Tirar o contato da cadeia: quem o tinha como dono anterior herda o retrato DELE. Sem isto, A desfaz sem ser dono,
  -- B (que veio depois) desfaz e o retrato "antes de B" ressuscita o efeito que A acabou de desfazer.
  UPDATE public.radar_contatos SET
    status_anterior = v_anterior,
    descarte_motivo_anterior = v_motivo_anterior,
    atualizado_anterior = v_atualizado_anterior,
    contato_anterior_id = v_dono_anterior
  WHERE contato_anterior_id = p_id;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true, 'status_restaurado', v_restaurou);
END $function$

;

-- private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)
CREATE OR REPLACE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamp with time zone, p_renovado_em timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inicio timestamptz := GREATEST(p_assumido_em, p_renovado_em);
  v_expira timestamptz := v_inicio + interval '7 days';
  v_toque timestamptz;
BEGIN
  FOR v_toque IN
    SELECT c.created_at FROM public.radar_contatos c
     WHERE c.cnpj = p_cnpj AND c.criado_por = p_dono AND c.created_at > v_inicio
     ORDER BY c.created_at
  LOOP
    EXIT WHEN v_toque >= v_expira;
    v_expira := GREATEST(v_expira, v_toque + interval '7 days');
  END LOOP;
  RETURN v_expira;
END
$function$

;

-- private.radar_leads_do_vendedor(uuid,integer,timestamptz)
CREATE OR REPLACE FUNCTION private.radar_leads_do_vendedor(p_vendedor uuid, p_n integer, p_agora timestamp with time zone DEFAULT now())
 RETURNS TABLE(posicao integer, cnpj text, razao_social text, nome_fantasia text, municipio_codigo text, municipio_nome text, uf text, score smallint, score_motivos text[], elegiveis integer, atribuido boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH par AS (
    SELECT date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
           p_agora - interval '90 days' AS desde,
           -- E1: a foto vigente é o maior lote COMPLETO (running/error no meio não é foto). Sem lote completo não
           -- recorta, como a fila (src/lib/radar/lote-vigente.ts: null é "não sei", nunca "zero").
           (SELECT s.mes_referencia FROM public.radar_ingest_state s
             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote
  ),
  terr AS (
    SELECT t.municipio_codigo, t.clientes, t.compartilhado FROM private.radar_territorio_do_vendedor(p_vendedor, 3) t
  ),
  -- E4: lead que o gestor passou a este vendedor e cuja posse segue ativa no relógio de p_agora.
  atrib AS (
    SELECT a.cnpj FROM public.radar_atendimentos a
     WHERE a.dono_user_id = p_vendedor
       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
  ),
  -- Os filtros estáticos ficam DENTRO de cada ramo (o do território casa com o índice parcial idx_radar_muni).
  -- São os mesmos nos dois ramos: ja_cliente, status, score, RFB, foto vigente (E1) e contato (E1).
  alvo AS (
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false AS atribuido
      FROM terr t
      JOIN public.radar_empresas re ON re.municipio_codigo = t.municipio_codigo
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, 0, false, true
      FROM atrib ab
      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
  ),
  -- Atribuído no território aparece uma vez só, como atribuído.
  um_por_cnpj AS (
    SELECT DISTINCT ON (a.cnpj) a.*, left(a.cnpj, 8) AS raiz
      FROM alvo a
     ORDER BY a.cnpj, a.atribuido DESC, a.compartilhado, a.clientes DESC
  ),
  universo AS (
    SELECT u.*
      FROM um_por_cnpj u
      CROSS JOIN par
     WHERE NOT EXISTS (
             -- posse ativa: de OUTRO vendedor com acesso (como antes) ou do PRÓPRIO quando ele mesmo assumiu (E3);
             -- a do próprio que veio do gestor é justamente o E4 e fica.
             SELECT 1 FROM public.radar_atendimentos a
              WHERE a.cnpj = u.cnpj
                AND a.encerrado_em IS NULL
                AND ((a.dono_user_id <> p_vendedor AND private.cap_radar_prospectar(a.dono_user_id))
                     OR (a.dono_user_id = p_vendedor AND a.atribuido_por IS NULL))
                AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora)
       AND NOT EXISTS (
             -- E2: só e-mail ENTREGUE queima, e só os de semana ANTERIOR (os desta semana seguem no card).
             -- E6: no município COMPARTILHADO, o de OUTRO vendedor (na fila ou entregue) também tira o lead: o
             -- fallback não repete o dono. No território próprio, não: o dono nunca perde lead para o fallback.
             -- O atribuído pelo gestor vem com compartilhado = false. Envio de teste nunca conta.
             SELECT 1 FROM public.radar_email_vendedor_leads l
               JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id
               JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE left(l.cnpj, 8) = u.raiz
                AND e.eh_teste = false
                AND e.criado_em >= par.desde
                AND ((e.vendedor_user_id = p_vendedor AND fa.status = 'notificado' AND e.semana < par.semana)
                     OR (e.vendedor_user_id <> p_vendedor AND u.compartilhado
                         AND fa.status IN ('notificado', 'pendente_notificacao'))))
  ),
  -- Uma empresa por raiz de CNPJ (a filial de maior score): em prod o top-5 da Regina trazia a mesma metalúrgica 4 vezes.
  por_raiz AS (
    SELECT DISTINCT ON (u.raiz) u.*
      FROM universo u
     ORDER BY u.raiz, u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
  )
  SELECT (row_number() OVER (ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj))::integer,
         u.cnpj, u.razao_social, u.nome_fantasia, u.municipio_codigo, u.municipio_nome, u.uf,
         u.score, u.score_motivos, (count(*) OVER ())::integer, u.atribuido
    FROM por_raiz u
   ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_n, 5), 5));
$function$

;

-- public.radar_prospectar_hoje(uuid,integer)
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL::uuid, p_n integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_alvo   uuid;
  v_n      integer := GREATEST(1, LEAST(COALESCE(p_n, 3), 5));
  v_terr   jsonb;
  v_motivo text;
  v_leads  jsonb;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: leads de outro vendedor exigem gestor' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                               'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                            ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb)
    INTO v_terr
    FROM private.radar_territorio_do_vendedor(v_alvo, 3) t;
  IF jsonb_array_length(v_terr) = 0 THEN
    v_motivo := private.radar_territorio_motivo(v_alvo);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('posicao', x.posicao, 'cnpj', x.cnpj, 'razao_social', x.razao_social,
                                               'nome_fantasia', x.nome_fantasia, 'municipio_nome', x.municipio_nome,
                                               'uf', x.uf, 'score', x.score, 'score_motivos', to_jsonb(x.score_motivos),
                                               'elegiveis', x.elegiveis, 'atribuido', x.atribuido,
                                               -- "visitar": todo contato com indício de contabilidade → o card não oferece ligar.
                                               'visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                            ORDER BY x.posicao), '[]'::jsonb)
    INTO v_leads
    FROM private.radar_leads_do_vendedor(v_alvo, v_n, now()) x
    LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

  RETURN jsonb_build_object('territorio', v_terr, 'territorio_motivo', v_motivo, 'leads', v_leads);
END
$function$

;

-- public.radar_avisar_vendedores(timestamptz)
CREATE OR REPLACE FUNCTION public.radar_avisar_vendedores(p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c_n           constant integer := 5;
  c_app_padrao  constant text    := 'https://steu.lovable.app';
  c_url_ok      constant text    := '^https://[A-Za-z0-9.-]+(:[0-9]+)?$';
  c_email_ok    constant text    := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_ini         timestamptz := clock_timestamp();
  v_semana      date := date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_app         text;
  r             record;
  l             record;
  v_teste       boolean;
  v_tentativa   integer;
  v_email       text;
  v_nome        text;
  v_terr        jsonb;
  v_terr_txt    text;
  v_terr_nomes  text;
  v_leads       jsonb;
  v_qtd         integer;
  v_elegiveis   integer;
  v_atrib       integer;
  v_visitar     integer;
  v_lista       text;
  v_envio       uuid;
  v_alerta      bigint;
  v_titulo      text;
  v_corpo       text;
  v_estado      text;
  v_msg         text;
  v_avisados    jsonb := '[]'::jsonb;
  v_pulados     jsonb := '[]'::jsonb;
  v_erros       jsonb := '[]'::jsonb;
BEGIN
  -- Uma distribuição por vez (parecer Codex): o SKIP LOCKED sozinho deixava duas execuções simultâneas pegarem
  -- vendedores diferentes sem enxergar os envios uma da outra (dono numa, fallback na outra → mesmo lead aos dois).
  -- A 2ª espera a 1ª terminar e então vê os envios dela (ja_enviado_na_semana).
  PERFORM pg_advisory_xact_lock(hashtext('radar.avisar_vendedores'));

  -- E7: a URL do link vem de company_config.app_url_publica (ausente = a de sempre). Valor fora do formato não
  -- manda link quebrado a ninguém: ledger 'erro' e nenhum e-mail.
  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';
  v_app := rtrim(COALESCE(v_app, c_app_padrao), '/');
  IF v_app !~ c_url_ok THEN
    IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_config c WHERE c.ativo) THEN
      INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(), 'erro',
              jsonb_build_object('semana', v_semana, 'erro', 'company_config.app_url_publica fora do formato https://host',
                                 'app_url_publica', left(v_app, 200)));
    END IF;
    RETURN jsonb_build_object('semana', v_semana, 'erro', 'app_url_publica_invalida', 'avisados', '[]'::jsonb,
                              'pulados', '[]'::jsonb, 'erros', '[]'::jsonb);
  END IF;

  FOR r IN
    SELECT c.vendedor_user_id AS vendedor, c.email_teste
      FROM public.radar_email_vendedor_config c
     WHERE c.ativo
     -- E6: quem é dono de município vai antes, para o território compartilhado não levar os leads do dono.
     ORDER BY NOT EXISTS (SELECT 1 FROM private.radar_territorio_do_vendedor(c.vendedor_user_id, 3) t
                           WHERE NOT t.compartilhado),
              c.vendedor_user_id
       FOR UPDATE OF c SKIP LOCKED
  LOOP
    -- E5: cada vendedor numa subtransação. O erro de um desfaz só o envio dele, vai para `erros` e os outros seguem.
    BEGIN
      v_teste := r.email_teste IS NOT NULL;

      -- E2: e-mail que falhou (falha_notificacao) não consome a semana; na fila ou entregue, sim. Alerta sumido
      -- também bloqueia (fail-closed: na dúvida, não manda duas vezes).
      IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_envios e
                   LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
                  WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste
                    AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'ja_enviado_na_semana');
        CONTINUE;
      END IF;

      IF NOT COALESCE(private.cap_radar_prospectar(r.vendedor), false) THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_acesso_ao_radar');
        CONTINUE;
      END IF;

      SELECT p.email, p.name INTO v_email, v_nome
        FROM public.profiles p WHERE p.user_id = r.vendedor
       ORDER BY p.created_at LIMIT 1;
      v_email := COALESCE(r.email_teste, btrim(v_email));
      IF v_email IS NULL OR v_email !~ c_email_ok THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_email');
        CONTINUE;
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                                   'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                                ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb),
             string_agg(t.municipio_nome || ' (' || t.clientes || ' clientes seus)', ' · ' ORDER BY t.clientes DESC, t.municipio_codigo),
             string_agg(t.municipio_nome, ', ' ORDER BY t.clientes DESC, t.municipio_codigo)
        INTO v_terr, v_terr_txt, v_terr_nomes
        FROM private.radar_territorio_do_vendedor(r.vendedor, 3) t;

      -- A elegibilidade é a do pacote E (sem mudança); o contato de contabilidade só MARCA o lead como "visitar".
      SELECT COALESCE(jsonb_agg(to_jsonb(x) || jsonb_build_object('visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                                ORDER BY x.posicao), '[]'::jsonb), count(*), max(x.elegiveis),
             count(*) FILTER (WHERE x.atribuido), count(*) FILTER (WHERE ct.visitar)
        INTO v_leads, v_qtd, v_elegiveis, v_atrib, v_visitar
        FROM private.radar_leads_do_vendedor(r.vendedor, c_n, p_agora) x
        LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

      -- Sem território o e-mail ainda sai se o gestor passou leads (E4); sem os dois, o motivo diz por quê (E6).
      IF v_qtd = 0 AND jsonb_array_length(v_terr) = 0 THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_territorio',
                                                     'causa', private.radar_territorio_motivo(r.vendedor));
        CONTINUE;
      END IF;
      IF v_qtd = 0 THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_leads', 'territorio', v_terr);
        CONTINUE;
      END IF;

      SELECT COALESCE(max(e.tentativa), 0) + 1 INTO v_tentativa
        FROM public.radar_email_vendedor_envios e
       WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste;

      v_envio := gen_random_uuid();
      v_lista := '';
      FOR l IN
        SELECT * FROM jsonb_to_recordset(v_leads) AS x(posicao integer, cnpj text, razao_social text, nome_fantasia text,
                                                      municipio_codigo text, municipio_nome text, uf text, score smallint,
                                                      score_motivos text[], elegiveis integer, atribuido boolean,
                                                      visitar boolean, endereco text)
         ORDER BY x.posicao
      LOOP
        v_lista := v_lista
          || l.posicao || '. ' || COALESCE(NULLIF(btrim(l.nome_fantasia), ''), l.razao_social, l.cnpj)
          || CASE WHEN NULLIF(btrim(l.nome_fantasia), '') IS NOT NULL AND l.razao_social IS NOT NULL
                  THEN ' (' || l.razao_social || ')' ELSE '' END || E'\n'
          || '   ' || COALESCE(l.municipio_nome, '?') || '/' || COALESCE(l.uf, '?') || ' · score ' || l.score
          || CASE WHEN l.atribuido THEN ' · passada a você pelo gestor' ELSE '' END
          || COALESCE(' · ' || NULLIF(array_to_string(l.score_motivos[1:2], '; '), ''), '') || E'\n'
          -- Sem telefone a prometer: o contato que a Receita tem é, provavelmente, da contabilidade.
          || CASE WHEN l.visitar THEN '   VISITAR: o telefone e o e-mail da Receita parecem ser da contabilidade da empresa. Vá ao endereço: '
                                      || COALESCE(l.endereco, 'veja na ficha') || E'\n'
                  ELSE '' END
          || '   Abrir no Radar: ' || v_app || '/radar/abrir/' || v_envio || '/' || l.cnpj || E'\n\n';
      END LOOP;

      v_titulo := 'Radar: ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
               || ' para prospectar esta semana' || COALESCE(' (' || v_terr_nomes || ')', '');
      v_corpo := 'Olá' || COALESCE(', ' || NULLIF(split_part(btrim(v_nome), ' ', 1), ''), '') || '!' || E'\n\n'
        || 'Separei ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
        || ' para você prospectar esta semana'
        || COALESCE(', perto de onde você já tem clientes: ' || v_terr_txt, '') || '.'
        || CASE WHEN v_atrib = 1 THEN ' 1 delas foi passada a você pelo gestor.'
                WHEN v_atrib > 1 THEN ' ' || v_atrib || ' delas foram passadas a você pelo gestor.'
                ELSE '' END
        || E'\n\n'
        || v_lista
        || CASE WHEN v_visitar = v_qtd
                THEN 'O link abre a ficha no Radar, com o endereço, sócios e o botão para registrar o contato. Nestas empresas '
                     || 'o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço em vez de ligar.'
                WHEN v_visitar > 0
                THEN 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato. '
                     || 'Nas marcadas VISITAR, o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço.'
                ELSE 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato.' END
        || E'\n\n'
        || 'Como escolhi: '
        || CASE WHEN v_atrib > 0 THEN 'primeiro as que o gestor passou a você; depois, ' ELSE '' END
        || 'maior score do Radar entre ' || v_elegiveis || ' empresas a contatar. Ficam de fora '
        || 'quem já é cliente, descartados, empresas baixadas ou inaptas na Receita, empresas que não vieram na foto '
        || 'mais recente da Receita, empresas sem telefone nem e-mail, empresas sem score, leads que você já assumiu e '
        || 'leads em atendimento por outro vendedor. Nenhuma empresa desta lista volta a aparecer para você nos próximos 90 dias.'
        || CASE WHEN v_teste THEN E'\n\n[TESTE] Este e-mail era para ' || COALESCE(v_nome, r.vendedor::text)
                                || ' e foi desviado para ' || v_email || '. Não entra na contagem de envios.'
                ELSE '' END;

      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
      VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
              jsonb_build_object('origem', 'radar.avisar_vendedores', 'envio_id', v_envio, 'semana', v_semana,
                                 'n_leads', v_qtd, 'teste', v_teste, 'tentativa', v_tentativa))
      RETURNING id INTO v_alerta;

      INSERT INTO public.radar_email_vendedor_envios
        (id, vendedor_user_id, semana, tentativa, destinatario_email, eh_teste, alerta_id, territorio, n_leads, elegiveis, criado_em)
      VALUES (v_envio, r.vendedor, v_semana, v_tentativa, v_email, v_teste, v_alerta, v_terr, v_qtd, v_elegiveis, p_agora);

      INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo, atribuido, visitar)
        SELECT v_envio, x.posicao, x.cnpj, x.score, x.municipio_codigo, x.atribuido, x.visitar
          FROM jsonb_to_recordset(v_leads) AS x(posicao smallint, cnpj text, score smallint, municipio_codigo text,
                                                atribuido boolean, visitar boolean);

      v_avisados := v_avisados || jsonb_build_object('vendedor', r.vendedor, 'envio_id', v_envio, 'alerta_id', v_alerta,
                                                     'n_leads', v_qtd, 'elegiveis', v_elegiveis, 'atribuidos', v_atrib,
                                                     'visitar', v_visitar,
                                                     'tentativa', v_tentativa, 'teste', v_teste);
    EXCEPTION WHEN OTHERS THEN
      -- Não é engolir: o erro vai inteiro (SQLSTATE + mensagem) para o ledger, que sai com status 'erro'.
      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_erros := v_erros || jsonb_build_object('vendedor', r.vendedor, 'sqlstate', v_estado, 'erro', left(v_msg, 300));
    END;
  END LOOP;

  -- Ledger só quando havia vendedor ligado: semana sem config ativa não suja acoes_execucoes
  -- (cron.job_run_details é a fonte do "rodou"). Pulado e erro também entram.
  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) + jsonb_array_length(v_erros) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(),
            CASE WHEN jsonb_array_length(v_erros) = 0 THEN 'sucesso' ELSE 'erro' END,
            jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros));
  END IF;

  RETURN jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros);
END
$function$

;
