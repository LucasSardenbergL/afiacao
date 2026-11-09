-- Definições VIVAS da PROD (pg_get_functiondef via psql-ro, 2026-11-08): predecessoras do pacote L do Radar.
-- Usadas por db/test-radar-posse-l.sh por cima da cadeia do pacote G.
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

CREATE OR REPLACE FUNCTION public.radar_definir_atendimento(p_cnpj text, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_agora timestamptz;
  v_ja_cliente boolean;
  v_aberto public.radar_atendimentos;
  v_ativo boolean := false;
  v_expira timestamptz;
  v_nome text;
  v_meus integer;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_acao IS NULL OR p_acao NOT IN ('assumir', 'liberar') THEN
    RAISE EXCEPTION 'radar_definir_atendimento: ação inválida (%)', COALESCE(p_acao, 'NULL') USING ERRCODE = '22023';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || p_cnpj, 0));
  IF p_acao = 'assumir' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento_dono:' || v_uid::text, 0));
  END IF;
  v_agora := clock_timestamp();

  SELECT e.ja_cliente INTO v_ja_cliente FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_aberto FROM public.radar_atendimentos a WHERE a.cnpj = p_cnpj AND a.encerrado_em IS NULL;
  IF FOUND THEN
    v_expira := private.radar_atendimento_expira_em(v_aberto.cnpj, v_aberto.dono_user_id, v_aberto.assumido_em, v_aberto.renovado_em);
    IF v_expira <= v_agora THEN
      UPDATE public.radar_atendimentos a
         SET encerrado_em = v_expira, motivo_encerramento = 'expirado'
       WHERE a.id = v_aberto.id;
    ELSIF NOT (COALESCE(private.cap_radar_prospectar(v_aberto.dono_user_id), false)) THEN
      UPDATE public.radar_atendimentos a
         SET encerrado_em = v_agora, motivo_encerramento = 'dono_sem_acesso'
       WHERE a.id = v_aberto.id;
    ELSE
      v_ativo := true;
    END IF;
  END IF;

  IF p_acao = 'assumir' THEN
    -- Já cliente não se assume nem se renova: não há o que prospectar.
    IF COALESCE(v_ja_cliente, false) THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'ja_cliente');
    END IF;
    IF v_ativo AND v_aberto.dono_user_id = v_uid THEN
      UPDATE public.radar_atendimentos a SET renovado_em = v_agora WHERE a.id = v_aberto.id;
      RETURN jsonb_build_object('ok', true, 'renovado', true, 'expira_em',
        private.radar_atendimento_expira_em(v_aberto.cnpj, v_aberto.dono_user_id, v_aberto.assumido_em, v_agora));
    ELSIF v_ativo THEN
      SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_aberto.dono_user_id;
      RETURN jsonb_build_object('ok', false, 'motivo', 'em_atendimento',
        'dono_user_id', v_aberto.dono_user_id, 'dono_nome', v_nome, 'expira_em', v_expira);
    END IF;
    -- Teto por dono: ninguém "trabalha" mais de 100 leads ao mesmo tempo, e o teto mantém a leitura dos ativos
    -- longe do corte de 1.000 linhas do PostgREST.
    SELECT count(*) INTO v_meus FROM public.radar_atendimentos a
     WHERE a.dono_user_id = v_uid AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > v_agora;
    IF v_meus >= 100 THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'limite', 'limite', 100);
    END IF;
    INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES (p_cnpj, v_uid, v_agora);
    RETURN jsonb_build_object('ok', true, 'renovado', false, 'expira_em',
      private.radar_atendimento_expira_em(p_cnpj, v_uid, v_agora, NULL));
  END IF;

  -- liberar
  IF NOT v_ativo THEN
    RETURN jsonb_build_object('ok', true, 'ja_livre', true);
  END IF;
  IF v_aberto.dono_user_id = v_uid THEN
    UPDATE public.radar_atendimentos a
       SET encerrado_em = v_agora, encerrado_por = v_uid, motivo_encerramento = 'liberado'
     WHERE a.id = v_aberto.id;
  ELSIF COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    UPDATE public.radar_atendimentos a
       SET encerrado_em = v_agora, encerrado_por = v_uid, motivo_encerramento = 'gestor_liberou'
     WHERE a.id = v_aberto.id;
  ELSE
    SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_aberto.dono_user_id;
    RETURN jsonb_build_object('ok', false, 'motivo', 'nao_e_dono',
      'dono_user_id', v_aberto.dono_user_id, 'dono_nome', v_nome, 'expira_em', v_expira);
  END IF;
  RETURN jsonb_build_object('ok', true, 'ja_livre', false);
END
$function$
;
