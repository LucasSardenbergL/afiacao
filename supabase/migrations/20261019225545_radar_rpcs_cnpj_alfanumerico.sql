-- ============================================================================================
-- Radar: as 3 RPCs de prospecção aceitam CNPJ ALFANUMÉRICO (RFB jul/2026) — follow-up do #3175/#3192
-- ============================================================================================
-- O CHECK de radar_empresas/radar_contatos aceita `^[0-9A-Z]{12}[0-9]{2}$` desde a 20261019110000, mas
-- registrar_contato_radar, radar_atribuir_tarefa e radar_registrar_cadastro_omie ainda barravam o
-- parâmetro por `^[0-9]{14}$` → para um lead alfanumérico, contato/atribuição/registro de cadastro
-- falhavam ALTO ('cnpj inválido'). Aqui só o guard muda: o corpo de cada função é o de PROD
-- (pg_get_functiondef via psql-ro, 2026-10-19) com a regex trocada — SECURITY DEFINER, search_path e
-- volatilidade preservados byte a byte; o REVOKE/GRANT reemite o ACL nomeando as roles.
-- Minúscula e 13 posições seguem RAISE (fail-closed, como o CHECK); o numérico antigo é subconjunto.
-- Envelope BEGIN/COMMIT (SQL Editor/MCP — objetos do `postgres`). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-rpcs-cnpj-alfanumerico.sh (--falsificar).
-- Gate: scripts/like-cru-em-migrations-gate.ts (VIVOS_PERMITIDOS ancora no guard novo de radar_atribuir_tarefa).
-- Diário: docs/historico/radar-cnpj-alfanumerico.md
-- ============================================================================================
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito (volatilidade VIVA = v) em cada função que a PRE guarda e este arquivo recria.
-- A volatilidade é conferida ANTES do ALTER (ele a normalizaria e a PRE não veria a deriva — Codex 2026-10-20).
DO $trava$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, p.provolatile
      FROM (VALUES
        ('registrar_contato_radar(text,text,text)'),
        ('radar_atribuir_tarefa(text,integer)'),
        ('radar_registrar_cadastro_omie(text,text,boolean)')
      ) AS x(alvo)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.alvo)
  LOOP
    IF r.provolatile IS NULL THEN
      RAISE EXCEPTION 'TRAVA FALHOU: % ausente', r.alvo;
    END IF;
    IF r.provolatile <> 'v' THEN
      RAISE EXCEPTION 'TRAVA FALHOU: % não é VOLATILE (%) — alguém mudou a volatilidade; revise antes de recriar', r.alvo, r.provolatile;
    END IF;
  END LOOP;
  ALTER FUNCTION public.registrar_contato_radar(text, text, text) VOLATILE;
  ALTER FUNCTION public.radar_atribuir_tarefa(text, integer) VOLATILE;
  ALTER FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) VOLATILE;
END
$trava$;

-- PRE: md5(prosrc) vivo ∈ {predecessores revisados (PROD 2026-10-19; registrar_contato_radar também o corpo do repo,
-- que difere da PROD só em comentários), este arquivo}. Ausente ou outro ABORTA. E, sob a trava, os ATRIBUTOS e o
-- ACL do predecessor têm de ser os revisados (SECURITY DEFINER, search_path=public, EXECUTE só para
-- authenticated/service_role): o md5 do corpo não vê um ALTER FUNCTION/REVOKE concorrente, e o CREATE OR REPLACE
-- + GRANT abaixo os desfariam em silêncio (Codex ALTO, 2026-10-20).
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessores, x.este, p.prosecdef, p.proconfig, p.oid AS fn
      FROM (VALUES
        ('registrar_contato_radar(text,text,text)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.registrar_contato_radar(text,text,text)')),
         ARRAY['efdd73b69bd3d1ef23d2353ec2de3c3e','41eb0fddbbaa50bb9b0e813779d5e54b'], 'c84e25c9e0926410a08775d8574d6734' /* este:registrar_contato_radar */),
        ('radar_atribuir_tarefa(text,integer)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_atribuir_tarefa(text,integer)')),
         ARRAY['2cec8056bf553b87d6329394c1f30779'], 'bdefeabfc219b8d7e8de8d0315e88c07' /* este:radar_atribuir_tarefa */),
        ('radar_registrar_cadastro_omie(text,text,boolean)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')),
         ARRAY['1ad5c63172e48b51931a910922974f75'], '46717b268a9c44abaf09024de816c72b' /* este:radar_registrar_cadastro_omie */)
      ) AS x(alvo, vivo, predecessores, este)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.alvo)
  LOOP
    IF r.vivo IS NULL OR (r.vivo <> ALL (r.predecessores) AND r.vivo <> r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
    IF NOT r.prosecdef OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo mudou SECURITY/search_path (secdef=%, config=%) — revise antes de recriar', r.alvo, r.prosecdef, r.proconfig;
    END IF;
    IF has_function_privilege('anon', r.fn, 'EXECUTE') OR has_function_privilege('public', r.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.fn, 'EXECUTE') OR NOT has_function_privilege('service_role', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo tem ACL divergente do predecessor revisado — revise antes de recriar', r.alvo;
    END IF;
  END LOOP;
END
$pre$;

-- registrar_contato_radar: corpo de PROD, só o guard de p_cnpj muda.
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(p_cnpj text, p_acao text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_existing uuid;
  v_id uuid;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido';
  END IF;
  IF p_acao NOT IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente') THEN
    RAISE EXCEPTION 'ação inválida: %', p_acao;
  END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':'||p_acao||':radar', 0));
  SELECT id INTO v_existing FROM public.radar_contatos
   WHERE criado_por = v_uid AND cnpj = p_cnpj AND acao = p_acao
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_status_atual)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = now(),
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE NULL END,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$;

-- radar_atribuir_tarefa: corpo de PROD, só o guard de p_cnpj muda.
CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(p_cnpj text, p_dias_retomada integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_razao text; v_fantasia text; v_municipio text; v_uf text; v_tel text;
  v_existing uuid; v_id uuid; v_desc text;
  v_dias integer := GREATEST(1, LEAST(COALESCE(p_dias_retomada, 7), 90));
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT razao_social, nome_fantasia, municipio_nome, uf, telefone1
    INTO v_razao, v_fantasia, v_municipio, v_uf, v_tel
    FROM public.radar_empresas WHERE cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':tarefa:radar', 0));
  SELECT id INTO v_existing FROM public.tarefas
   WHERE created_by = v_uid AND empresa = 'oben' AND customer_user_id IS NULL
     AND status = 'aberta' AND descricao LIKE '%CNPJ '||p_cnpj||'%'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  v_desc := 'Prospecção: ' || COALESCE(NULLIF(v_fantasia,''), NULLIF(v_razao,''), p_cnpj)
            || ' · ' || COALESCE(v_municipio,'?') || '/' || COALESCE(v_uf,'?')
            || COALESCE(' · tel ' || NULLIF(v_tel,''), '')
            || ' · CNPJ ' || p_cnpj;

  INSERT INTO public.tarefas (
    descricao, categoria, customer_user_id, assigned_to, created_by, empresa,
    modo, due_date, interacao_tipo, auto_satisfy_mode, status
  ) VALUES (
    v_desc, 'ligar', NULL, v_uid, v_uid, 'oben',
    'data', ((now() AT TIME ZONE 'America/Sao_Paulo')::date + v_dias), NULL, 'off', 'aberta'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$;

-- radar_registrar_cadastro_omie: corpo de PROD, só o guard de p_cnpj muda.
CREATE OR REPLACE FUNCTION public.radar_registrar_cadastro_omie(p_cnpj text, p_codigo_cliente text, p_ja_existia boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status_atual text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  UPDATE public.radar_empresas SET
    omie_codigo_cliente = COALESCE(NULLIF(p_codigo_cliente,''), omie_codigo_cliente),
    omie_cadastrado_em = now(),
    prospeccao_status = 'virou_cliente',
    prospeccao_atualizado_em = now(),
    ja_cliente = true,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, 'virou_cliente',
    CASE WHEN p_ja_existia
      THEN 'Já cadastrado no Omie/Oben (cód. ' || COALESCE(NULLIF(p_codigo_cliente,''),'?') || ')'
      ELSE 'Cadastrado no Omie/Oben (cód. ' || COALESCE(NULLIF(p_codigo_cliente,''),'?') || ')' END,
    v_uid, v_status_atual);

  RETURN jsonb_build_object('ok', true);
END $function$;

-- ACL: CREATE OR REPLACE preserva, mas o REVOKE/GRANT fica explícito nomeando as roles (DROP+CREATE resetaria).
REVOKE ALL ON FUNCTION public.registrar_contato_radar(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_atribuir_tarefa(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) TO authenticated, service_role;

-- PÓS: o corpo vivo é ESTE (mesma régua da PRE), com SECURITY DEFINER, search_path=public e VOLATILE
-- preservados, e o guard novo presente no texto (a PÓS não aprova um corpo que perdeu a validação).
DO $pos$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.este, p.prosrc, p.prosecdef, p.proconfig, p.provolatile
      FROM (VALUES
        ('registrar_contato_radar(text,text,text)', 'c84e25c9e0926410a08775d8574d6734' /* este:registrar_contato_radar */),
        ('radar_atribuir_tarefa(text,integer)', 'bdefeabfc219b8d7e8de8d0315e88c07' /* este:radar_atribuir_tarefa */),
        ('radar_registrar_cadastro_omie(text,text,boolean)', '46717b268a9c44abaf09024de816c72b' /* este:radar_registrar_cadastro_omie */)
      ) AS x(alvo, este)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.alvo)
  LOOP
    IF r.prosrc IS NULL OR md5(r.prosrc) IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS FALHOU: % não é este arquivo (md5 %)', r.alvo, md5(r.prosrc);
    END IF;
    IF NOT r.prosecdef OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR r.provolatile <> 'v' THEN
      RAISE EXCEPTION 'POS FALHOU: % perdeu SECURITY DEFINER/search_path=public/VOLATILE (%, %, %)',
        r.alvo, r.prosecdef, r.proconfig, r.provolatile;
    END IF;
    IF position($guard$p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$'$guard$ IN r.prosrc) = 0
       OR position($guard$p_cnpj !~ '^[0-9]{14}$'$guard$ IN r.prosrc) > 0 THEN
      RAISE EXCEPTION 'POS FALHOU: % não valida p_cnpj pelo formato RFB alfanumérico', r.alvo;
    END IF;
  END LOOP;
  RAISE NOTICE 'radar: 3 RPCs aceitam CNPJ alfanumérico (guard ^[0-9A-Z]{12}[0-9]{2}$)';
END
$pos$;

COMMIT;
