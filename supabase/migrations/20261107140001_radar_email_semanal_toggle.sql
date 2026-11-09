-- Radar D1: ligar e desligar o e-mail semanal de leads pela tela (Governança → Usuários), sem SQL Editor.
-- Pedido do founder em 2026-11-07: "quero ter um toggle em algum lugar para ligar essa função para qualquer usuário".
-- Depende de 20261106181000_radar_leads_ao_vendedor (tabelas, território, cron). Três funções, todas só para MASTER:
--   1. public.radar_email_semanal_painel(): leitura PURA (STABLE, cabe na allowlist da lente). Estado do cron e, por
--      usuário da equipe (employee/master, mais quem já tem config): modo (desligado/teste/ligado), acesso ao Radar,
--      território (os 3 municípios que o e-mail usaria) e o último envio.
--   2. public.radar_email_semanal_definir(p_usuario, p_modo): grava a config. 'teste' desvia o e-mail para o e-mail do
--      PRÓPRIO master (lido do perfil dele, nunca de parâmetro: a função não vira relay para endereço livre).
--      'ligado' manda para a pessoa. 'desligado' vale também para quem saiu da equipe (desligar nunca é bloqueado).
--   3. public.radar_email_semanal_cron(p_ativo): liga/desliga o job radar-avisar-vendedores-semanal.
-- Cada escrita deixa 1 linha em acoes_execucoes (quem, quando, o quê) e a config guarda atualizado_por.
-- Nada aqui envia e-mail: o envio continua sendo o cron (segunda 08:00 BRT) chamando radar_avisar_vendedores.

ALTER TABLE public.radar_email_vendedor_config ADD COLUMN IF NOT EXISTS atualizado_por uuid;
COMMENT ON TABLE public.radar_email_vendedor_config IS
  'Radar D1: liga/desliga o e-mail semanal de leads por vendedor. Escrita: public.radar_email_semanal_definir (só master, tela Governança → Usuários). email_teste preenchido desvia o e-mail para um destinatário de teste; esse envio não conta no denominador e não queima lead.';

-- ── 1. Painel (leitura pura) ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_email_semanal_painel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_cron     jsonb;
  v_usuarios jsonb;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'forbidden: so master liga o e-mail semanal do Radar' USING ERRCODE = '42501';
  END IF;

  -- Job ausente = NULL (≠ desligado): a tela diz "cron não encontrado", nunca "desligado".
  SELECT jsonb_build_object('ativo', j.active, 'agenda', j.schedule) INTO v_cron
    FROM cron.job j WHERE j.jobname = 'radar-avisar-vendedores-semanal';

  WITH alvo AS (
    SELECT ur.user_id FROM public.user_roles ur
     WHERE ur.role IN ('employee'::public.app_role, 'master'::public.app_role)
    UNION
    SELECT c.vendedor_user_id FROM public.radar_email_vendedor_config c
  ), linhas AS (
    SELECT a.user_id,
           p.name  AS nome,
           p.email AS email,
           (SELECT string_agg(ur.role::text, ',' ORDER BY ur.role::text) FROM public.user_roles ur
             WHERE ur.user_id = a.user_id) AS papel,
           (SELECT cr.commercial_role::text FROM public.commercial_roles cr WHERE cr.user_id = a.user_id) AS papel_comercial,
           COALESCE(private.cap_radar_prospectar(a.user_id), false) AS acesso_radar,
           CASE WHEN c.ativo IS NOT TRUE THEN 'desligado'
                WHEN c.email_teste IS NOT NULL THEN 'teste'
                ELSE 'ligado' END AS modo,
           c.email_teste,
           c.atualizado_em,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('municipio', t.municipio_nome, 'uf', t.uf, 'clientes', t.clientes)
                                      ORDER BY t.clientes DESC, t.municipio_codigo)
                       FROM private.radar_territorio_do_vendedor(a.user_id, 3) t), '[]'::jsonb) AS territorio,
           (SELECT jsonb_build_object('semana', e.semana, 'eh_teste', e.eh_teste, 'n_leads', e.n_leads,
                                      'elegiveis', e.elegiveis, 'destinatario', e.destinatario_email, 'status', fa.status)
              FROM public.radar_email_vendedor_envios e
              LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
             WHERE e.vendedor_user_id = a.user_id
             ORDER BY e.semana DESC, e.criado_em DESC LIMIT 1) AS ultimo_envio
      FROM alvo a
      LEFT JOIN public.radar_email_vendedor_config c ON c.vendedor_user_id = a.user_id
      LEFT JOIN LATERAL (SELECT pr.name, btrim(pr.email) AS email FROM public.profiles pr
                          WHERE pr.user_id = a.user_id ORDER BY pr.created_at LIMIT 1) p ON true
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', l.user_id, 'nome', l.nome, 'email', l.email, 'papel', l.papel,
           'papel_comercial', l.papel_comercial, 'acesso_radar', l.acesso_radar, 'modo', l.modo,
           'email_teste', l.email_teste, 'atualizado_em', l.atualizado_em, 'territorio', l.territorio,
           'ultimo_envio', l.ultimo_envio)
         ORDER BY (l.modo = 'desligado'), l.nome NULLS LAST, l.user_id), '[]'::jsonb)
    INTO v_usuarios
    FROM linhas l;

  RETURN jsonb_build_object('cron', v_cron, 'usuarios', v_usuarios);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_email_semanal_painel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_email_semanal_painel() TO authenticated;

-- ── 2. Liga/desliga por usuário ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_email_semanal_definir(p_usuario uuid, p_modo text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_email text;
  v_nome  text;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'forbidden: so master liga o e-mail semanal do Radar' USING ERRCODE = '42501';
  END IF;
  IF p_modo IS NULL OR p_modo NOT IN ('desligado', 'teste', 'ligado') THEN
    RAISE EXCEPTION 'modo invalido: use desligado, teste ou ligado' USING ERRCODE = '22023';
  END IF;
  IF p_usuario IS NULL THEN
    RAISE EXCEPTION 'usuario obrigatorio' USING ERRCODE = '22023';
  END IF;
  -- Ligar exige alguém da equipe; desligar, nunca (quem saiu da equipe com o e-mail ligado tem de poder ser desligado).
  IF p_modo <> 'desligado' AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_usuario AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'usuario nao e da equipe' USING ERRCODE = '22023';
  END IF;

  SELECT btrim(p.email), p.name INTO v_email, v_nome
    FROM public.profiles p WHERE p.user_id = v_uid ORDER BY p.created_at LIMIT 1;
  IF p_modo = 'teste' AND (v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'seu perfil nao tem e-mail valido para receber o teste' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo, email_teste, atualizado_em, atualizado_por)
  VALUES (p_usuario, p_modo <> 'desligado', CASE WHEN p_modo = 'teste' THEN v_email END, now(), v_uid)
  ON CONFLICT (vendedor_user_id) DO UPDATE
    SET ativo = EXCLUDED.ativo, email_teste = EXCLUDED.email_teste,
        atualizado_em = EXCLUDED.atualizado_em, atualizado_por = EXCLUDED.atualizado_por;

  INSERT INTO public.acoes_execucoes (acao, origem, executado_por, executado_por_nome, finalizado_em, status, detalhes)
  VALUES ('radar.email_semanal_definir', 'manual', v_uid, v_nome, now(), 'sucesso',
          jsonb_build_object('usuario', p_usuario, 'modo', p_modo));

  RETURN jsonb_build_object('ok', true, 'usuario', p_usuario, 'modo', p_modo,
                            'email_teste', CASE WHEN p_modo = 'teste' THEN v_email END);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_email_semanal_definir(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_email_semanal_definir(uuid, text) TO authenticated;

-- ── 3. Liga/desliga o cron semanal ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_email_semanal_cron(p_ativo boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_job   bigint;
  v_ativo boolean;
  v_nome  text;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'forbidden: so master liga o e-mail semanal do Radar' USING ERRCODE = '42501';
  END IF;
  IF p_ativo IS NULL THEN
    RAISE EXCEPTION 'p_ativo obrigatorio' USING ERRCODE = '22023';
  END IF;
  SELECT j.jobid INTO v_job FROM cron.job j WHERE j.jobname = 'radar-avisar-vendedores-semanal';
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'cron radar-avisar-vendedores-semanal nao existe' USING ERRCODE = 'P0002';
  END IF;

  PERFORM cron.alter_job(job_id := v_job, active := p_ativo);
  SELECT j.active INTO v_ativo FROM cron.job j WHERE j.jobid = v_job;
  IF v_ativo IS DISTINCT FROM p_ativo THEN
    RAISE EXCEPTION 'cron nao mudou: pedido %, ficou %', p_ativo, v_ativo USING ERRCODE = 'P0001';
  END IF;

  SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_uid ORDER BY p.created_at LIMIT 1;
  INSERT INTO public.acoes_execucoes (acao, origem, executado_por, executado_por_nome, finalizado_em, status, detalhes)
  VALUES ('radar.email_semanal_cron', 'manual', v_uid, v_nome, now(), 'sucesso', jsonb_build_object('ativo', v_ativo));

  RETURN jsonb_build_object('ok', true, 'ativo', v_ativo);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_email_semanal_cron(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_email_semanal_cron(boolean) TO authenticated;

-- ── Postcondição ──────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'radar_email_vendedor_config' AND column_name = 'atualizado_por') THEN
    RAISE EXCEPTION 'T0 FALHOU: coluna atualizado_por ausente — a tela não registra quem ligou';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.radar_email_semanal_painel()', 'public.radar_email_semanal_definir(uuid,text)',
                           'public.radar_email_semanal_cron(boolean)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure AND p.prosecdef
                    AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'T1 FALHOU: % sem SECURITY DEFINER com search_path vazio', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'T2 FALHOU: ACL de % errada (anon executa ou authenticated não executa)', f;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.radar_email_semanal_painel()'::regprocedure) IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'T3 FALHOU: painel não é STABLE — sairia da allowlist de leitura da lente';
  END IF;
  RAISE NOTICE 'RADAR_EMAIL_TOGGLE_OK';
END
$post$;
