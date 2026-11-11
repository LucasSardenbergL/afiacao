-- ============================================================
-- Radar, pacote J: o expurgo horário de privacidade para de reler o heap de radar_empresas (plano v8, R2).
--
-- O PROBLEMA (medido em prod, 2026-11-11): o job 284 (`41 * * * *`, public.radar_privacidade_expurgo) era o maior
-- leitor de disco da instância: 155.652 blocos de heap + 4.697 de índice de radar_empresas fora do shared_buffers
-- por rodada (1,22 GiB; ~29 GiB/dia), 63–83 s cada. O plano v8 atribuía o custo às duas varreduras por regex
-- (backfill e contagem `razoes_cruas_restantes`); os planos de prod desmentem: as duas já usam o índice parcial
-- idx_radar_empresas_razao_crua (backfill = Index Only Scan, 48 blocos lidos; contagem = Index Only Scan).
-- Quem lê o heap inteiro é a HIGIENE DO CRU, `DELETE … WHERE NOT EXISTS (SELECT 1 FROM radar_empresas e …)`:
-- num DELETE, toda relação não-alvo da junção leva rowmark (precisa do ctid para o EvalPlanQual), e isso proíbe o
-- Index Only Scan. O Merge Anti Join percorre radar_empresas_pkey (36 MB ≈ 4.600 blocos: os 4.697 de índice) e
-- busca no heap cada uma das 624 mil linhas, em ordem de CNPJ (os 155 mil de heap; o heap tem 93 mil páginas e
-- não cabe nos 256 MB de shared_buffers). EXPLAIN em prod: custo 121.843 no DELETE contra 14.418 na forma SELECT.
--
-- O QUE MUDA (só a etapa (c) do corpo VIVO, lido em 2026-11-11 por pg_get_functiondef, md5(prosrc)
-- cdb486cec7cf23cd76f709fe0893bccf; o resto é cópia byte a byte):
--   1. Os órfãos são calculados numa CTE MATERIALIZED — um SELECT, sem rowmark — e o DELETE só casa o resultado
--      pela PK do cru. A anti-junção vira Index Only Scan em radar_empresas_pkey (medido em prod, EXPLAIN ANALYZE da
--      forma SELECT: 11.609 blocos lidos, 3 s, 0 órfãos). Mesmo snapshot, mesma semântica: um único comando.
--   2. A higiene do cru roda no máximo uma vez a cada ~24 h (a 1ª rodada sem uma higiene `sucesso` nas últimas
--      23 h 30 min), e não mais a cada hora. Órfão de cru só nasce de carga abortada ou de empresa que saiu do Radar
--      (carga mensal); 24 h de retenção desse resto é a mesma ordem de grandeza da carga que o gerou. Na rodada
--      sem higiene, `cru_orfao_apagado` vai como null (ausente ≠ zero: não rodou, não "apagou 0").
--
-- O QUE NÃO MUDA (a garantia de LGPD): o backfill (a) e a contagem `razoes_cruas_restantes` seguem A CADA HORA, no
-- mesmo predicado ' [0-9]{11}$' do índice parcial; retenção de notas (b), expiração de acessos e exclusões de
-- titular (d) seguem a cada hora, idênticas. Assinatura, SECURITY DEFINER, search_path e ACL ficam (CREATE OR
-- REPLACE preserva o ACL; a PÓS confere que nenhum JWT executa).
--
-- Prova PG17 (executando a função, falsificada): db/test-radar-privacidade-j.sh, fase I* (bash … --falsificar).
-- Molde TRAVA → PRE → CREATE → PÓS. Sem índice novo, sem UPDATE de dado: roda em horário comercial.
-- Ordem de deploy: só esta camada (front e edges não mudam).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261113110000_radar_expurgo_sem_varrer_heap.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

SET LOCAL lock_timeout = '15s';

DO $trava$
BEGIN
  ALTER FUNCTION public.radar_privacidade_expurgo(integer, integer) SET search_path TO 'public', 'pg_temp';
END
$trava$;

DO $pre$
DECLARE
  v_ex text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_privacidade_expurgo(integer, integer)'));
BEGIN
  IF v_ex IS NULL OR v_ex NOT IN ('cdb486cec7cf23cd76f709fe0893bccf', '3f4fd1f23db1c8a2612c649a18db22a2') THEN
    RAISE EXCEPTION 'PRE FALHOU: public.radar_privacidade_expurgo vivo (md5 %) não é o da 20261111150000 nem este — reconcilie antes', v_ex;
  END IF;
  IF to_regprocedure('private.radar_exclusoes_aplicar(text)') IS NULL OR to_regclass('private.radar_razao_receita') IS NULL
     OR to_regclass('public.idx_radar_empresas_razao_crua') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: objetos da 20261111150000 ausentes (exclusões, cru ou índice parcial)';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_privacidade_expurgo(p_lote integer DEFAULT 10000, p_meses integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini timestamptz := clock_timestamp();
  v_masc integer;
  v_notas integer;
  v_orfaos integer;
  v_acessos integer;
  v_exc jsonb;
  v_res jsonb;
  v_status text := 'sucesso';
BEGIN
  IF p_lote IS NULL OR p_lote < 1 OR p_lote > 50000 OR p_meses IS NULL OR p_meses < 6 THEN
    RAISE EXCEPTION 'parâmetro inválido (lote 1..50000, meses ≥ 6)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    -- (a) backfill: razão ainda crua → o trigger mascara e guarda o cru. Linha em edição fica para a próxima.
    UPDATE public.radar_empresas e SET razao_social = e.razao_social
     WHERE e.cnpj IN (SELECT c.cnpj FROM public.radar_empresas c WHERE c.razao_social ~ ' [0-9]{11}$'
                       ORDER BY c.cnpj LIMIT p_lote FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_masc = ROW_COUNT;
    -- (b) retenção: texto livre de lead descartado há mais de p_meses. A nota automática (autor = usuário de
    --     sistema, a da situação RFB) fica.
    UPDATE public.radar_contatos c SET nota = NULL
      FROM public.radar_empresas e
     WHERE e.cnpj = c.cnpj AND e.prospeccao_status = 'descartado'
       AND COALESCE(e.prospeccao_atualizado_em, c.created_at) < now() - make_interval(months => p_meses)
       AND c.nota IS NOT NULL
       AND c.criado_por IS DISTINCT FROM '00000000-0000-0000-0000-00000000ad0f'::uuid;
    GET DIAGNOSTICS v_notas = ROW_COUNT;
    -- (c) higiene: o cru de CNPJ que não está no Radar nem no staging (carga abortada, empresa que saiu). Uma vez a
    --     cada ~24 h. Os órfãos saem de um SELECT (CTE MATERIALIZED): num DELETE com junção, radar_empresas levaria
    --     rowmark e o planner perderia o Index Only Scan — releria o heap inteiro (1,2 GiB por rodada, medido).
    IF NOT EXISTS (SELECT 1 FROM public.acoes_execucoes a
                    WHERE a.acao = 'radar.privacidade_expurgo' AND a.status = 'sucesso'
                      AND a.iniciado_em > now() - interval '23 hours 30 minutes'
                      AND a.detalhes ->> 'cru_orfao_apagado' IS NOT NULL) THEN
      WITH orfaos AS MATERIALIZED (
        SELECT r.cnpj FROM private.radar_razao_receita r
         WHERE NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = r.cnpj)
           AND NOT EXISTS (SELECT 1 FROM public.radar_empresas_carga k WHERE k.cnpj = r.cnpj))
      DELETE FROM private.radar_razao_receita r USING orfaos o WHERE r.cnpj = o.cnpj;
      GET DIAGNOSTICS v_orfaos = ROW_COUNT;
    END IF;
    DELETE FROM private.radar_razao_receita_acessos WHERE lido_em < now() - make_interval(months => p_meses);
    GET DIAGNOSTICS v_acessos = ROW_COUNT;
    -- (d) exclusões: o que a carga do mês trouxe de volta sai de novo.
    v_exc := private.radar_exclusoes_aplicar(NULL);
    v_res := jsonb_build_object('razoes_mascaradas', v_masc,
                                'razoes_cruas_restantes', (SELECT count(*) FROM public.radar_empresas WHERE razao_social ~ ' [0-9]{11}$'),
                                'notas_expurgadas', v_notas, 'cru_orfao_apagado', v_orfaos, 'acessos_expirados', v_acessos) || v_exc;
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      v_status := 'erro';
      v_res := jsonb_build_object('adiado', SQLSTATE, 'motivo', left(SQLERRM, 300));
    WHEN OTHERS THEN
      v_status := 'erro';
      v_res := jsonb_build_object('falhou', left(SQLSTATE || ': ' || SQLERRM, 500));
  END;
  INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('radar.privacidade_expurgo', 'automatica', v_ini, clock_timestamp(), v_status, v_res);
  RETURN v_res || jsonb_build_object('status', v_status);
END
$function$;

DO $pos$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_privacidade_expurgo(integer, integer)'))
       IS DISTINCT FROM '3f4fd1f23db1c8a2612c649a18db22a2' THEN
    RAISE EXCEPTION 'PÓS FALHOU: corpo vivo de public.radar_privacidade_expurgo não é o desta migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_privacidade_expurgo(integer, integer)')
                    AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PÓS FALHOU: radar_privacidade_expurgo perdeu SECURITY DEFINER ou o search_path fixo';
  END IF;
  IF has_function_privilege('authenticated', 'public.radar_privacidade_expurgo(integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.radar_privacidade_expurgo(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: radar_privacidade_expurgo executável por JWT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_razao_crua')
                    AND i.indisvalid AND pg_get_expr(i.indpred, i.indrelid) LIKE '%[0-9]{11}$%') THEN
    RAISE EXCEPTION 'PÓS FALHOU: idx_radar_empresas_razao_crua ausente ou inválido — backfill e contagem voltariam a varrer o heap';
  END IF;
END
$pos$;

