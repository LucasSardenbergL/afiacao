-- =====================================================================================================================
-- Calendário de operação — alinhamento ao relógio do sync: o trânsito do app que o sinal "antecipar" soma volta a ser
-- IDÊNTICO ao CTE `em_transito` do motor (gerar_pedidos_sugeridos_ciclo), agora na versão 20261118120000 (#3969).
-- SÓ LEITURA (informativa) · Prova: db/test-calendario-operacao.sh (bloco ARELOGIO*) · Depende de 20261119120000.
--
-- ⚠️ MIGRATION MANUAL (nome custom: o Lovable NÃO aplica). Vai pelo `bun run db:aplicar`, que fornece a transação e
--    recusa envelope — por isso SEM BEGIN/COMMIT no corpo. Idempotente: TRAVA → PRE → CREATE OR REPLACE → PÓS.
--
-- Defeito: a 20261119120000 copiou o em_transito da 20261101090000 (janela data_ciclo >= p_hoje − 7 dias). O motor
--   passou a cortar os pedidos do app POR SKU pelo retrato que o omie-sync-estoque publicou:
--   LEAST(p_data_ciclo, dia SP de (sku_estoque_atual.ultima_sincronizacao − 1 h)) − 7, NULL = o corte de antes.
--   Com o sync atrasado (retrato de S < D), o pedido com data_ciclo em [S−7, D−8] não está no pendente do retrato
--   e o motor o conta; a lista não o contava → recomendava ANTECIPAR um SKU que o motor considera coberto.
-- Conserto: o MESMO corte do motor (mesmo LEAST, mesma folga de 1 h, mesmo NULL, mesmo LEFT JOIN por SKU), com
--   p_data_ciclo → p_hoje. Todo o resto do corpo é byte a byte o da 20261119120000.
--
-- Só calendario_antecipar_avaliacao muda: calendario_itens_antecipar e calendario_itens_antecipar_resumo são
-- wrappers SQL que só filtram/contam a avaliação (herdam o conserto sem recriar). CREATE OR REPLACE preserva a ACL
-- (EXECUTE: authenticated + service_role; PUBLIC e anon revogados) — a PÓS confere, nunca DROP.
-- Predecessor (md5 do prosrc na PROD, psql-ro 2026-11-18): aed4c41f86f6c2c1795a6619f7bd480c (= corpo da 20261119120000).
-- =====================================================================================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA, 's') na função que a PRE guarda e este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('public.calendario_antecipar_avaliacao(text, date, date)') IS NOT NULL THEN
    ALTER FUNCTION public.calendario_antecipar_avaliacao(text, date, date) STABLE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ou outro ABORTA (apply manual diverge do repo).
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.calendario_antecipar_avaliacao(text, date, date)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('aed4c41f86f6c2c1795a6619f7bd480c', '3034f3fc57c3850da61ef89c904b10a2') THEN
    RAISE EXCEPTION 'PRE FALHOU: calendario_antecipar_avaliacao vivo (md5 %) nao e o predecessor revisado nem este — reconcilie antes de aplicar', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.calendario_antecipar_avaliacao(
  p_empresa     text,
  p_fim_recesso date,
  p_hoje        date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date)
)
RETURNS TABLE (
  sku_codigo_omie              bigint,
  sku_descricao                text,
  fornecedor_nome              text,
  cobertura_dias               numeric,
  dias_ate_chegada_pos_recesso int,
  motivo                       text
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
  -- Sem leitura de compras a RLS de pedido_compra_item zeraria o trânsito em silêncio (lista inflada) → falha alta.
  IF v_uid IS NOT NULL AND NOT private.cap_compras_ler(v_uid) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-ANTECIPAR-SEM-COMPRAS] a lista de antecipar le pedidos de compra: exige acesso a compras';
  END IF;
  IF p_empresa IS NULL OR p_fim_recesso IS NULL OR p_hoje IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    -- = em_transito do motor (gerar_pedidos_sugeridos_ciclo, 20261118120000), p_data_ciclo → p_hoje. Mudou lá ⇒ muda aqui.
    -- [RELÓGIO ÚNICO] corte POR SKU = o do retrato que publicou o pendente (dia SP de ultima_sincronizacao − 1 h),
    -- nunca depois do corte de antes (LEAST); retrato sem data (NULL) = o corte de antes.
    WITH em_transito AS (
      SELECT pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      LEFT JOIN public.sku_estoque_atual sea_c ON sea_c.empresa = pcs2.empresa AND sea_c.sku_codigo_omie = pci.sku_codigo_omie::text
      WHERE pcs2.empresa = p_empresa
        AND (
          (pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (LEAST(p_hoje, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date) - 7)
           AND NOT (
             pcs2.status = 'aprovado_aguardando_disparo'
             AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
             AND pcs2.portal_protocolo IS NULL
             AND pcs2.omie_pedido_compra_numero IS NULL
           ))
          OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
        )
      GROUP BY pci.sku_codigo_omie
    ),
    -- Membros de grupo de equivalência (mesmo filtro do CTE `equiv` do motor): unidade da embalagem ≠ do estoque.
    em_grupo AS (
      SELECT DISTINCT e.sku_codigo_omie::text AS sku
        FROM public.sku_embalagem_equivalencia e
       WHERE e.empresa = lower(p_empresa) AND e.ativo = TRUE AND e.fator_para_base > 0
    ),
    base AS MATERIALIZED (
      SELECT sp.sku_codigo_omie AS sku,
             sp.sku_descricao   AS descricao,
             sp.fornecedor_nome AS fornecedor,
             sp.demanda_media_diaria AS demanda,
             sp.lt_medio_dias_uteis  AS lt,
             sea.estoque_fisico      AS fisico,
             sea.estoque_pendente_entrada AS pendente,
             (eg.sku IS NOT NULL)    AS tem_grupo,
             CASE WHEN sp.demanda_media_diaria > 0 THEN
               (sea.estoque_fisico + sea.estoque_pendente_entrada + COALESCE(et.qtde, 0)) / sp.demanda_media_diaria
             END AS cobertura,
             CASE WHEN sp.lt_medio_dias_uteis IS NOT NULL THEN
               public.calendario_proximo_dia_recebimento(
                 p_empresa,
                 public.calendario_somar_dias_uteis_fornecedor(
                   p_empresa, sp.fornecedor_nome, p_fim_recesso, ceil(sp.lt_medio_dias_uteis)::int))
             END AS chegada
        FROM public.sku_parametros sp
        LEFT JOIN public.sku_estoque_atual sea
          ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
        LEFT JOIN em_transito et ON et.sku_codigo_omie = sp.sku_codigo_omie::text
        LEFT JOIN em_grupo eg    ON eg.sku = sp.sku_codigo_omie::text
       WHERE sp.empresa = p_empresa
         AND sp.ativo IS TRUE
         AND sp.fornecedor_nome IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.calendario_operacao_fornecedor f
                      WHERE f.empresa = p_empresa
                        AND lower(btrim(f.fornecedor_nome)) = lower(btrim(sp.fornecedor_nome))
                        AND f.data BETWEEN p_hoje AND p_fim_recesso)
    )
    SELECT b.sku, b.descricao, b.fornecedor, b.cobertura, (b.chegada - p_hoje)::int,
           CASE
             WHEN b.tem_grupo THEN 'grupo_equivalencia'
             WHEN b.demanda IS NULL OR b.demanda <= 0 THEN 'sem_demanda'      -- nunca divisão fabricada
             WHEN b.lt IS NULL THEN 'sem_lt'
             WHEN b.fisico IS NULL OR b.pendente IS NULL THEN 'sem_estoque'   -- sem linha / pendente NULL ≠ 0
             WHEN b.chegada IS NULL THEN 'sem_chegada'                        -- nunca data inventada
             WHEN b.cobertura < (b.chegada - p_hoje) THEN 'listado'
             WHEN b.cobertura >= (b.chegada - p_hoje) THEN 'cobre'
             ELSE 'sem_dado'                                                  -- indeterminado: nunca listado
           END
      FROM base b
     ORDER BY b.cobertura, b.sku;
END;
$$;

COMMENT ON FUNCTION public.calendario_antecipar_avaliacao(text, date, date) IS
  'Lógica única do sinal antecipar: todo SKU do universo com o motivo (listado/cobre/grupo_equivalencia/sem_*). '
  'Estoque = físico + pendente Omie + trânsito do app (CTE em_transito do motor 20261118120000, corte pelo relógio '
  'do retrato). Spec 2026-11-18 §6.3.4.';

-- PÓS: o corte novo no CÓDIGO (comentário limpo antes), o velho fora; corpo = ESTE; atributos e ACL preservados.
DO $pos$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.calendario_antecipar_avaliacao(text, date, date)');
  v_src text;
  v_estranho text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: calendario_antecipar_avaliacao ausente';
  END IF;
  v_src := regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = v_fn), '--[^\n]*', '', 'g');
  IF position($c$pcs2.data_ciclo >= (LEAST(p_hoje, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date) - 7)$c$ IN v_src) = 0
     OR position($c$LEFT JOIN public.sku_estoque_atual sea_c ON sea_c.empresa = pcs2.empresa AND sea_c.sku_codigo_omie = pci.sku_codigo_omie::text$c$ IN v_src) = 0
     OR position($c$pcs2.data_ciclo >= (p_hoje - INTERVAL '7 days')$c$ IN v_src) > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: antecipar nao corta pelo relogio do retrato (sea_c.ultima_sincronizacao) como o motor';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM '3034f3fc57c3850da61ef89c904b10a2' THEN
    RAISE EXCEPTION 'POS FALHOU: corpo vivo de calendario_antecipar_avaliacao nao e o deste arquivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_fn AND p.provolatile = 's' AND NOT p.prosecdef
                    AND array_to_string(p.proconfig, ';') = 'search_path=public, pg_temp') THEN
    RAISE EXCEPTION 'POS FALHOU: atributo mudou — esperado STABLE, INVOKER, search_path=public, pg_temp';
  END IF;
  -- ACL (REPLACE preserva; conferir mesmo assim). PUBLIC antes de anon: anon herda de PUBLIC.
  IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: PUBLIC executa a avaliacao de antecipar';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: anon executa a avaliacao de antecipar';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: EXECUTE ausente para authenticated ou service_role';
  END IF;
  -- Ninguém além do dono, authenticated, service_role e o executor de sandbox do Lovable (sandbox_exec_<ref>, que já
  -- está no ACL de prod de todas as funções de antecipar — psql-ro 2026-11-18).
  SELECT string_agg(COALESCE(r.rolname, 'PUBLIC'), ',') INTO v_estranho
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
   WHERE p.oid = v_fn AND a.privilege_type = 'EXECUTE'
     AND (r.rolname IS NULL OR (r.rolname NOT IN ('postgres', 'authenticated', 'service_role')
                                AND r.rolname NOT LIKE 'sandbox\_exec\_%'));
  IF v_estranho IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: EXECUTE concedido fora de authenticated e service_role: %', v_estranho;
  END IF;
  RAISE NOTICE 'CALENDARIO-ANTECIPAR-RELOGIO-OK';
END
$pos$;
