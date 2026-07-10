-- Auto-cadastro dos pares QT+GL dos concentrados WP.3900 na Embalagem econômica.
-- Fonte VERSIONADA → colar no SQL Editor do Lovable (migration custom NÃO auto-aplica).
-- NÃO editar supabase/migrations/. Advisory: nenhum WP passa pelo motor.
-- Prova: db/test-embalagem-auto-cadastro-wp.sql. Spec: docs/superpowers/specs/2026-07-09-embalagem-economica-auto-cadastro-wp-design.md

-- 1) Audit log (staff-only na leitura; escrita só pela função SECURITY DEFINER)
CREATE TABLE IF NOT EXISTS public.reposicao_embalagem_sync_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa          text NOT NULL,
  executado_em     timestamptz NOT NULL DEFAULT now(),
  disparado_por    text NOT NULL,
  cores_elegiveis  int NOT NULL,
  linhas_inseridas int NOT NULL,
  detalhes         jsonb
);
ALTER TABLE public.reposicao_embalagem_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_embalagem_sync_log_staff_read ON public.reposicao_embalagem_sync_log;
CREATE POLICY reposicao_embalagem_sync_log_staff_read ON public.reposicao_embalagem_sync_log
  FOR SELECT USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- 2) Função de sincronização (insert-only, idempotente, gate cron-or-staff)
CREATE OR REPLACE FUNCTION public.reposicao_sincronizar_embalagem_wp(p_empresa text DEFAULT 'oben')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_disparado_por text;
  v_cores int := 0;
  v_linhas int := 0;
  v_ins int;
  r record;
  v_grupo uuid;
BEGIN
  -- Gate cron-or-staff: usuário logado exige staff; cron (auth.uid()=NULL) passa.
  -- NUNCA gatear por auth.role()='service_role' (mata cron SQL-local — reposicao.md §Outras frentes).
  IF v_uid IS NOT NULL
     AND NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'não autorizado' USING ERRCODE = '42501';
  END IF;
  v_disparado_por := CASE WHEN v_uid IS NULL THEN 'cron' ELSE 'manual:'||v_uid::text END;

  FOR r IN
    WITH wp AS (
      SELECT substring(descricao FROM '^(WP[0-9]+\.[0-9]+)') AS cor,
             substring(descricao FROM '^WP[0-9]+\.[0-9]+([A-Z0-9]+)') AS sufixo,
             omie_codigo_produto
      FROM public.omie_products
      WHERE account = p_empresa AND ativo
        AND descricao ~ '^WP[0-9]+\.[0-9]+(QT|GL) '
    )
    SELECT cor,
           max(omie_codigo_produto) FILTER (WHERE sufixo='QT') AS qt,
           max(omie_codigo_produto) FILTER (WHERE sufixo='GL') AS gl
    FROM wp GROUP BY cor
    HAVING count(*) FILTER (WHERE sufixo='QT') = 1
       AND count(*) FILTER (WHERE sufixo='GL') = 1
  LOOP
    v_cores := v_cores + 1;
    -- Reusa o grupo da cor se já cadastrada; senão gera novo.
    SELECT grupo_id INTO v_grupo
    FROM public.sku_embalagem_equivalencia
    WHERE empresa = p_empresa AND ativo AND sku_codigo_omie IN (r.qt::text, r.gl::text)
    LIMIT 1;
    IF v_grupo IS NULL THEN v_grupo := gen_random_uuid(); END IF;

    -- Insere só as embalagens faltantes (idempotente; NOT EXISTS protege colisão).
    INSERT INTO public.sku_embalagem_equivalencia
      (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base, fornecedor_nome, ativo, criado_por)
    SELECT p_empresa, v_grupo, x.sku::text, 'QT', x.fator, 'Sayerlack', true, 'auto:embalagem-wp'
    FROM (VALUES (r.qt, 1::numeric), (r.gl, 4::numeric)) AS x(sku, fator)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sku_embalagem_equivalencia s
      WHERE s.empresa = p_empresa AND s.ativo AND s.sku_codigo_omie = x.sku::text
    );
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    v_linhas := v_linhas + v_ins;
  END LOOP;

  INSERT INTO public.reposicao_embalagem_sync_log (empresa, disparado_por, cores_elegiveis, linhas_inseridas)
  VALUES (p_empresa, v_disparado_por, v_cores, v_linhas);

  RETURN jsonb_build_object('empresa', p_empresa, 'cores_elegiveis', v_cores, 'linhas_inseridas', v_linhas);
END $$;

REVOKE ALL ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) TO authenticated, service_role;

-- 3) Cron diário — 09:00 UTC (06:00 BRT), logo após o sync de catálogo (08:30 UTC).
-- cron.schedule por NOME é upsert (rodar de novo não duplica).
SELECT cron.schedule(
  'reposicao-embalagem-cadastro-wp-daily',
  '0 9 * * *',
  $$SELECT public.reposicao_sincronizar_embalagem_wp('oben')$$
);

-- 4) Backfill no apply — destrava imediatamente os pares faltantes (cadastra os 11).
SELECT public.reposicao_sincronizar_embalagem_wp('oben');
