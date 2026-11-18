-- =====================================================================================================================
-- Calendário de operação — Etapa 1 (Task 4b): sinal "antecipar antes do recesso" (spec §6.3.4). SÓ LEITURA.
-- Prova: db/test-calendario-operacao.sh (bloco AANT*) · Depende de 20261119100000_calendario_operacao.sql.
--
-- ⚠️ MIGRATION MANUAL (nome custom: o Lovable NÃO aplica). Idempotente (CREATE OR REPLACE + REVOKE/GRANT) e com
--    postcondição embutida (DO $post$). Aplicar DEPOIS da 20261119100000 (usa as funções de data dela).
--
-- calendario_itens_antecipar(p_empresa, p_fim_recesso, p_hoje DEFAULT hoje em SP) lista os SKUs cujo estoque não
-- alcança a 1ª chegada possível depois do recesso do fornecedor:
--   · universo: sku_parametros da empresa, ativo IS TRUE, cujo fornecedor tem ≥1 dia FECHADO (linha em
--     calendario_operacao_fornecedor, casada por lower(btrim)) em [p_hoje, p_fim_recesso];
--   · cobertura_dias = (estoque_fisico + estoque_pendente_entrada) / demanda_media_diaria   (dias corridos);
--   · chegada = calendario_proximo_dia_recebimento(empresa,
--                 calendario_somar_dias_uteis_fornecedor(empresa, fornecedor, p_fim_recesso, ceil(lt_medio_dias_uteis)));
--   · dias_ate_chegada_pos_recesso = chegada − p_hoje (dias corridos);
--   · entra na lista se cobertura_dias < dias_ate_chegada_pos_recesso.
--
-- Money-path (ausente ≠ zero): qualquer NULL no caminho TIRA o SKU da lista — demanda NULL ou ≤ 0 (nunca divisão
-- fabricada), LT NULL, sem linha de estoque, estoque_pendente_entrada NULL, chegada NULL (sem dia de recebimento em
-- 60 dias ou fornecedor fechado > 1 ano). Nada é tratado como 0. É informativo: o motor de compra NÃO muda.
--
-- Autorização: mesmo padrão da 20261119100000 — SECURITY INVOKER (RLS staff de sku_parametros/sku_estoque_atual/
-- calendário vale para quem chama) + gate na fronteira (JWT com sub não-staff → 42501); EXECUTE revogado de PUBLIC e
-- anon, concedido a authenticated e service_role.
-- =====================================================================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.calendario_itens_antecipar(
  p_empresa     text,
  p_fim_recesso date,
  p_hoje        date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date)
)
RETURNS TABLE (
  sku_codigo_omie              bigint,
  sku_descricao                text,
  fornecedor_nome              text,
  cobertura_dias               numeric,
  dias_ate_chegada_pos_recesso int
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'master'::public.app_role)
                                OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-SEM-PERMISSAO] calendario de operacao e restrito a staff';
  END IF;
  IF p_empresa IS NULL OR p_fim_recesso IS NULL OR p_hoje IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    WITH base AS (
      SELECT sp.sku_codigo_omie AS sku,
             sp.sku_descricao   AS descricao,
             sp.fornecedor_nome AS fornecedor,
             (sea.estoque_fisico + sea.estoque_pendente_entrada) / sp.demanda_media_diaria AS cobertura,
             public.calendario_proximo_dia_recebimento(
               p_empresa,
               public.calendario_somar_dias_uteis_fornecedor(
                 p_empresa, sp.fornecedor_nome, p_fim_recesso, ceil(sp.lt_medio_dias_uteis)::int)) AS chegada
        FROM public.sku_parametros sp
        JOIN public.sku_estoque_atual sea
          ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
       WHERE sp.empresa = p_empresa
         AND sp.ativo IS TRUE
         AND sp.fornecedor_nome IS NOT NULL
         AND sp.demanda_media_diaria > 0          -- NULL ou ≤ 0 → fora (nunca divisão fabricada)
         AND sp.lt_medio_dias_uteis IS NOT NULL
         AND sea.estoque_fisico IS NOT NULL
         AND sea.estoque_pendente_entrada IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.calendario_operacao_fornecedor f
                      WHERE f.empresa = p_empresa
                        AND lower(btrim(f.fornecedor_nome)) = lower(btrim(sp.fornecedor_nome))
                        AND f.data BETWEEN p_hoje AND p_fim_recesso)
    )
    SELECT b.sku, b.descricao, b.fornecedor, b.cobertura, (b.chegada - p_hoje)::int
      FROM base b
     WHERE b.chegada IS NOT NULL                  -- sem data de chegada → fora (nunca data inventada)
       AND b.cobertura < (b.chegada - p_hoje)
     ORDER BY b.cobertura, b.sku;
END;
$$;

COMMENT ON FUNCTION public.calendario_itens_antecipar(text, date, date) IS
  'SKUs cujo estoque (fisico+pendente)/demanda não alcança a 1ª chegada possível pós-recesso do fornecedor. '
  'Informativo (não altera o motor). Qualquer NULL no caminho exclui o SKU. Spec 2026-11-18 §6.3.4.';

-- ACL: REVOKE nas DUAS pontas (PUBLIC e anon) — o default privileges do Supabase concede EXECUTE a anon.
REVOKE ALL ON FUNCTION public.calendario_itens_antecipar(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_itens_antecipar(text, date, date) TO authenticated, service_role;

-- ── Postcondição embutida ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_fn regprocedure := to_regprocedure('public.calendario_itens_antecipar(text,date,date)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] funcao ausente';
  END IF;
  IF to_regprocedure('public.calendario_proximo_dia_recebimento(text,date)') IS NULL
     OR to_regprocedure('public.calendario_somar_dias_uteis_fornecedor(text,text,date,integer)') IS NULL THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] funcoes de data da 20261119100000 ausentes';
  END IF;
  -- PUBLIC antes de anon: anon herda de PUBLIC, então PUBLIC aberto acusaria "anon" e esconderia a causa.
  IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] PUBLIC executa a RPC de antecipar';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] anon executa a RPC de antecipar';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] authenticated sem EXECUTE em calendario_itens_antecipar';
  END IF;
END
$post$;

COMMIT;
