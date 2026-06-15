-- =============================================================================
-- RADAR DE CLIENTES — Fatia 3: contagem por município + ações (tarefa + Omie)
-- Spec: docs/superpowers/specs/2026-06-13-radar-clientes-fatia3-acoes-mapa-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate de todas as RPCs: gestor/master via pode_ver_carteira_completa (helper já
-- em prod; mesmo gate da RLS de SELECT das tabelas radar_*).
-- Nota RLS: as RPCs são SECURITY DEFINER (rodam como owner → bypassam a RLS de
-- radar_empresas), então o gate `pode_ver_carteira_completa` no IF do topo é a
-- ÚNICA fronteira de leitura — e é avaliado 1× (não por-linha como na RLS #792).
-- =============================================================================

-- 1) Persistência do cadastro no Omie (Oben) por lead.
ALTER TABLE public.radar_empresas
  ADD COLUMN IF NOT EXISTS omie_codigo_cliente text,
  ADD COLUMN IF NOT EXISTS omie_cadastrado_em  timestamptz;

-- 2) Contagem por município — serve ranking ("onde caçar") + totalizador + mapa.
--    Aplica os MESMOS filtros ESTRUTURAIS da lista (NÃO a busca textual livre —
--    busca por nome é p/ achar 1 empresa, não p/ ranking geográfico; omitir evita
--    o ILIKE '%%' full-scan). Agrupa por municipio_codigo+UF (nome repete entre UFs).
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(
  p_uf                   text    DEFAULT NULL,
  p_cnae_prefix          text    DEFAULT NULL,
  p_cnae_exato           text    DEFAULT NULL,
  p_status               text    DEFAULT NULL,
  p_incluir_ja_clientes  boolean DEFAULT false,
  p_data_abertura_min    date    DEFAULT NULL,
  p_data_abertura_max    date    DEFAULT NULL,
  p_limit                integer DEFAULT 500
) RETURNS TABLE(
  municipio_codigo text, municipio_nome text, uf text,
  lat double precision, lng double precision,
  total bigint, com_telefone bigint, a_contatar bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  -- só-dígitos defensivo (o cnae já vem normalizado do front, mas a RPC é pública a authenticated)
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;

  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix || '%')
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $$;

-- 3) Atribuir Tarefa de prospecção (sempre pro caller; lead não tem cliente).
--    tarefas: modo='data' EXIGE due_date NOT NULL + interacao_tipo NULL (constraint
--    tarefas_modo_coerencia_chk). auto_satisfy_mode='off' (matcher casa por cliente,
--    que o lead não tem — sem auto-baixa, honesto). customer_user_id NULL (nullable
--    desde a fase 2 de tarefas). categoria='ligar'.
CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(
  p_cnpj text, p_dias_retomada integer DEFAULT 7
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_razao text; v_fantasia text; v_municipio text; v_uf text; v_tel text;
  v_existing uuid; v_id uuid; v_desc text;
  v_dias integer := GREATEST(1, LEAST(COALESCE(p_dias_retomada, 7), 90));
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT razao_social, nome_fantasia, municipio_nome, uf, telefone1
    INTO v_razao, v_fantasia, v_municipio, v_uf, v_tel
    FROM public.radar_empresas WHERE cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- dedupe anti duplo-clique (advisory lock + busca curta por tarefa aberta do mesmo cnpj)
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
    'data', (current_date + v_dias), NULL, 'off', 'aberta'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- 4) Persistir o cadastro no Omie (chamada pelo front DEPOIS da edge omie-vendas-sync).
--    Idempotente: re-clicar sobrescreve o código e re-loga (a edge reconcilia o CNPJ).
CREATE OR REPLACE FUNCTION public.radar_registrar_cadastro_omie(
  p_cnpj text, p_codigo_cliente text, p_ja_existia boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status_atual text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

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
END $$;

-- 5) Travas: só authenticated invoca; o gate interno confere gestor/master.
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_atribuir_tarefa(text,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO authenticated;

-- 6) Validação pós-apply (colar junto; esperar colunas_2=2, funcoes_3=3)
SELECT 'RADAR FATIA3 OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_empresas'
      AND column_name IN ('omie_codigo_cliente','omie_cadastrado_em')) AS colunas_2,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('radar_contagem_por_municipio','radar_atribuir_tarefa','radar_registrar_cadastro_omie')) AS funcoes_3;
