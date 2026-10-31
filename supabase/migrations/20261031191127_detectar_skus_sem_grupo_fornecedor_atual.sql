-- ============================================================
-- detectar_skus_sem_grupo — o alerta segue o cadastro ATUAL do SKU
--
-- Medido em prod (2026-10-31): 12 alertas sku_sem_grupo pendentes há 170 dias, todos com
-- detalhes.fornecedor = 'RENNER SAYERLACK S/A' congelado na criação (maio). Hoje:
--   · 3 são de fornecedor que NÃO tem grupo (Dovac ×2, Francimar) — o INSERT nem os criaria mais;
--   · 8 estão inativos em sku_parametros (bases MixMachine 405 ml, sem nenhuma compra registrada).
-- O self-heal só fechava quando o SKU ganhava grupo ou virava 04, então ficaram pendurados — e a tela
-- (SemGrupoLote) oferecia os grupos da Sayerlack para SKUs da Dovac.
--
-- Regra nova: o alerta fica aberto só enquanto vale a condição que o criou.
--   1. fecha (status 'excluido', robô) quando: tem grupo · é 04 · SKU inativo · fornecedor ATUAL sem
--      grupo cadastrado (inclui SKU sem linha em sku_parametros ou sem fornecedor);
--   2. o que continua pendente tem detalhes.fornecedor reescrito para o fornecedor atual;
--   3. o INSERT não cria alerta para SKU inativo (ativo NULL = ativo; o default da coluna é true).
-- Literal da 1ª justificativa = o de PROD ('…não precisa de grupo.'), aceito em db/deriva-corpo-baseline.json.
--
-- Molde TRAVA → PRE → CREATE → PÓS (lovable-db-operator/references/sql-house-style.md).
-- Caminho: `bun run db:aplicar` (a transação é do executor — sem BEGIN/COMMIT aqui).
-- CREATE OR REPLACE preserva o ACL fechado (postgres/service_role/sandbox_exec) — conferido na PÓS.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade viva é VOLATILE).
DO $trava$
BEGIN
  IF to_regprocedure('public.detectar_skus_sem_grupo(text)') IS NOT NULL THEN
    ALTER FUNCTION public.detectar_skus_sem_grupo(text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: corpo vivo ∈ {predecessor de PROD revisado, este}. Ausente aborta.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.detectar_skus_sem_grupo(text)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('4147eeda24634ae0d5bb97a18452baf5', '66a2054e7be82add28093aec2d2756f9') THEN
    RAISE EXCEPTION 'PRE FALHOU: detectar_skus_sem_grupo vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.detectar_skus_sem_grupo(p_empresa text DEFAULT 'OBEN'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inseridos integer := 0;
BEGIN
  -- 1. Fecha o que não vale mais. A justificativa diz qual condição caiu.
  WITH estado AS (
    SELECT eo.id,
      EXISTS (SELECT 1 FROM sku_grupo_producao sg
               WHERE sg.empresa=eo.empresa AND sg.sku_codigo_omie=eo.sku_codigo_omie) AS tem_grupo,
      COALESCE((SELECT COALESCE(op.tipo_produto, op.metadata->>'tipo_produto') FROM omie_products op
                 WHERE op.omie_codigo_produto::text=eo.sku_codigo_omie AND op.account=lower(eo.empresa) LIMIT 1),'')='04' AS eh_04,
      EXISTS (SELECT 1 FROM sku_parametros sp
               WHERE sp.empresa=eo.empresa AND sp.sku_codigo_omie::text=eo.sku_codigo_omie AND sp.ativo IS FALSE) AS inativo,
      NOT EXISTS (SELECT 1 FROM sku_parametros sp
                    JOIN fornecedor_grupo_producao fg ON fg.empresa=sp.empresa AND fg.fornecedor_nome=sp.fornecedor_nome
                   WHERE sp.empresa=eo.empresa AND sp.sku_codigo_omie::text=eo.sku_codigo_omie) AS fornecedor_sem_grupo
    FROM eventos_outlier eo
    WHERE eo.tipo='sku_sem_grupo' AND eo.status='pendente' AND eo.empresa=p_empresa
  )
  UPDATE eventos_outlier eo
  SET status='excluido', decidido_em=now(),
      decidido_por='sistema (auto-resolve sku_sem_grupo)',
      justificativa_decisao = CASE
        WHEN e.tem_grupo OR e.eh_04 THEN 'SKU já tem grupo ou é Produto Acabado (04) fabricado — não precisa de grupo.'
        WHEN e.inativo THEN 'SKU inativo no cadastro de reposição — não precisa de grupo.'
        ELSE 'O fornecedor atual do SKU não tem grupo de produção cadastrado — o alerta não se aplica mais.'
      END
  FROM estado e
  WHERE e.id=eo.id AND (e.tem_grupo OR e.eh_04 OR e.inativo OR e.fornecedor_sem_grupo);

  -- 2. O que segue pendente mostra o fornecedor de hoje (a tela agrupa e lista os grupos por ele).
  UPDATE eventos_outlier eo
  SET detalhes = jsonb_set(COALESCE(eo.detalhes,'{}'::jsonb), '{fornecedor}', to_jsonb(sp.fornecedor_nome))
  FROM sku_parametros sp
  WHERE eo.tipo='sku_sem_grupo' AND eo.status='pendente' AND eo.empresa=p_empresa
    AND sp.empresa=eo.empresa AND sp.sku_codigo_omie::text=eo.sku_codigo_omie
    AND sp.fornecedor_nome IS DISTINCT FROM eo.detalhes->>'fornecedor';

  -- 3. Cria para SKU ativo de fornecedor com grupo, sem grupo próprio, que não seja 04.
  WITH fornecedores_com_grupos AS (
    SELECT DISTINCT fornecedor_nome FROM fornecedor_grupo_producao WHERE empresa=p_empresa
  ),
  inseridos AS (
    INSERT INTO eventos_outlier (empresa, sku_codigo_omie, sku_descricao, tipo, severidade, data_evento, detalhes)
    SELECT sp.empresa, sp.sku_codigo_omie::text, sp.sku_descricao, 'sku_sem_grupo', 'atencao', CURRENT_DATE,
      jsonb_build_object('fornecedor', sp.fornecedor_nome,
        'mensagem', 'SKU novo detectado. Classifique em um grupo de produção antes do próximo ciclo de reposição.')
    FROM sku_parametros sp
    JOIN fornecedores_com_grupos fcg ON fcg.fornecedor_nome=sp.fornecedor_nome
    WHERE sp.empresa=p_empresa
      AND sp.ativo IS NOT FALSE
      AND NOT EXISTS (SELECT 1 FROM sku_grupo_producao sg WHERE sg.empresa=sp.empresa AND sg.sku_codigo_omie=sp.sku_codigo_omie::text)
      AND NOT EXISTS (SELECT 1 FROM eventos_outlier eo WHERE eo.empresa=sp.empresa AND eo.sku_codigo_omie=sp.sku_codigo_omie::text AND eo.tipo='sku_sem_grupo' AND eo.status='pendente')
      AND COALESCE((SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto') FROM omie_products op04
                    WHERE op04.omie_codigo_produto::text=sp.sku_codigo_omie::text AND op04.account=lower(p_empresa) LIMIT 1),'') <> '04'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inseridos FROM inseridos;
  RETURN v_inseridos;
END;
$function$;

-- Roda uma vez agora (o cron `detectar-outliers-diario` faz o mesmo todo dia) — os 11 pendurados fecham já.
SELECT public.detectar_skus_sem_grupo('OBEN');

-- PÓS: corpo é ESTE, ACL continua fechado, e nenhum pendente viola a regra nova.
DO $pos$
DECLARE
  v_violam integer;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.detectar_skus_sem_grupo(text)')) IS DISTINCT FROM '66a2054e7be82add28093aec2d2756f9' THEN
    RAISE EXCEPTION 'POS FALHOU: detectar_skus_sem_grupo não é o corpo deste arquivo';
  END IF;
  IF has_function_privilege('anon', 'public.detectar_skus_sem_grupo(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.detectar_skus_sem_grupo(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: detectar_skus_sem_grupo ficou executável por anon/authenticated';
  END IF;
  SELECT count(*) INTO v_violam
  FROM eventos_outlier eo
  WHERE eo.tipo='sku_sem_grupo' AND eo.status='pendente' AND eo.empresa='OBEN'
    AND NOT EXISTS (SELECT 1 FROM sku_parametros sp
                      JOIN fornecedor_grupo_producao fg ON fg.empresa=sp.empresa AND fg.fornecedor_nome=sp.fornecedor_nome
                     WHERE sp.empresa=eo.empresa AND sp.sku_codigo_omie::text=eo.sku_codigo_omie
                       AND sp.ativo IS NOT FALSE
                       AND sp.fornecedor_nome = eo.detalhes->>'fornecedor');
  IF v_violam > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % alerta(s) sku_sem_grupo pendente(s) de SKU inativo, sem fornecedor com grupo ou com fornecedor desatualizado', v_violam;
  END IF;
END
$pos$;
