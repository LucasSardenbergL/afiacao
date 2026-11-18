-- =====================================================================================================================
-- Calendário de operação — Etapa 1 (Task 4b + onda final): sinal "antecipar antes do recesso" (spec §6.3.4) e a
-- prévia "recebe em" do pedido ainda não disparado (spec §6.3.1). SÓ LEITURA.
-- Prova: db/test-calendario-operacao.sh (blocos AANT*, ARES*, APREV*) · Depende de 20261119100000_calendario_operacao.sql.
--
-- ⚠️ MIGRATION MANUAL (nome custom: o Lovable NÃO aplica). Idempotente (CREATE OR REPLACE + REVOKE/GRANT) e com
--    postcondição embutida (DO $post$). Aplicar DEPOIS da 20261119100000 (usa as funções de data dela).
--
-- 1) calendario_antecipar_avaliacao(p_empresa, p_fim_recesso, p_hoje) — a LÓGICA ÚNICA. Devolve TODO SKU do universo
--    com o motivo da decisão; as duas RPCs públicas abaixo só filtram/contam (o resumo nunca diverge da lista):
--   · universo: sku_parametros da empresa, ativo IS TRUE, cujo fornecedor tem ≥1 dia FECHADO (linha em
--     calendario_operacao_fornecedor, casada por lower(btrim)) em [p_hoje, p_fim_recesso];
--   · cobertura_dias = (estoque_fisico + estoque_pendente_entrada + trânsito do app) / demanda_media_diaria;
--   · trânsito do app = o CTE `em_transito` do MOTOR (gerar_pedidos_sugeridos_ciclo, 20261101090000 — conferido
--     contra pg_get_functiondef da prod em 2026-11-18), com p_data_ciclo → p_hoje: mesmos status, janela de 7 dias,
--     guarda do erro terminal (IS NOT DISTINCT FROM) e ramo do portal sem nº Omie. POR QUÊ: o omie-sync-estoque
--     exclui do estoque_pendente_entrada os pedidos do app com < 7 dias — o motor os conta aqui; sem esta soma a
--     lista recomendaria antecipar mercadoria JÁ comprada. A deduplicação pendente×app é a do motor (mesma janela);
--   · unidade: o motor só soma `qtde_final` (unidade de EMBALAGEM comprada) direto na linha SEM grupo de
--     equivalência; com grupo ele converte por `conv` e consolida o grupo. Aqui não se replica a conversão: SKU com
--     grupo de equivalência ativo SAI da lista com motivo 'grupo_equivalencia' (contado em sem_dado no resumo) —
--     adivinhar a unidade seria fabricar (28 SKUs OBEN em 2026-11-18);
--   · chegada = calendario_proximo_dia_recebimento(empresa,
--                 calendario_somar_dias_uteis_fornecedor(empresa, fornecedor, p_fim_recesso, ceil(lt_medio_dias_uteis)));
--   · listado se cobertura_dias < chegada − p_hoje (dias corridos).
--    Motivos: listado · cobre · grupo_equivalencia · sem_demanda · sem_lt · sem_estoque · sem_chegada · sem_dado.
--
-- 2) calendario_itens_antecipar(...)          → só os 'listado' (contrato da tela, inalterado).
-- 3) calendario_itens_antecipar_resumo(...)   → avaliados / listados / sem_dado (tudo que não é listado nem cobre).
-- 4) calendario_previsao_pedido(p_empresa, p_fornecedor, p_portal_data, p_lt, p_hoje) → (promessa, recebimento) com a
--    MESMA regra da edge disparar-pedidos-aprovados v1.17 (previsao.ts): portal + 2 úteis do fornecedor; sem portal,
--    hoje + p_lt úteis do fornecedor; recebimento = 1º dia aberto da empresa ≥ promessa. Sempre UMA linha; qualquer
--    NULL no caminho (inclusive p_lt NULL sem portal — a edge usaria `?? 7`, a prévia não inventa) ⇒ (NULL, NULL).
--
-- Money-path (ausente ≠ zero): demanda NULL ou ≤ 0, LT NULL, sem linha de estoque, pendente NULL, chegada NULL ⇒
-- motivo próprio, NUNCA listado e NUNCA tratado como 0. Trânsito do app AUSENTE é 0 legítimo (nenhum pedido = nada a
-- caminho), exatamente como no motor. É informativo: o motor de compra NÃO muda.
--
-- Autorização: SECURITY INVOKER (a RLS vale para quem chama) + gate na fronteira (JWT com sub não-staff → 42501).
-- O trânsito vem de pedido_compra_item, cuja RLS só deixa ler quem tem private.cap_compras_ler (hoje: master). Sem
-- ela o trânsito seria 0 EM SILÊNCIO e a lista recomendaria recomprar — então quem não lê compras recebe 42501
-- [CALENDARIO-ANTECIPAR-SEM-COMPRAS] (a tela mostra "não foi possível carregar"), nunca a lista inflada. JWT sem sub
-- (service_role / SQL Editor) segue. EXECUTE revogado de PUBLIC e anon, concedido a authenticated e service_role.
-- =====================================================================================================================
BEGIN;

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
    -- = em_transito do motor (gerar_pedidos_sugeridos_ciclo), p_data_ciclo → p_hoje. Mudou lá ⇒ muda aqui.
    WITH em_transito AS (
      SELECT pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND (
          (pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (p_hoje - INTERVAL '7 days')
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
  'Estoque = físico + pendente Omie + trânsito do app (CTE em_transito do motor). Spec 2026-11-18 §6.3.4.';

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
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT a.sku_codigo_omie, a.sku_descricao, a.fornecedor_nome, a.cobertura_dias, a.dias_ate_chegada_pos_recesso
    FROM public.calendario_antecipar_avaliacao(p_empresa, p_fim_recesso, p_hoje) a
   WHERE a.motivo = 'listado'
   ORDER BY a.cobertura_dias, a.sku_codigo_omie;
$$;

COMMENT ON FUNCTION public.calendario_itens_antecipar(text, date, date) IS
  'SKUs cujo estoque (fisico+pendente+trânsito do app)/demanda não alcança a 1ª chegada possível pós-recesso do '
  'fornecedor. Informativo (não altera o motor). Qualquer NULL no caminho exclui o SKU. Spec 2026-11-18 §6.3.4.';

CREATE OR REPLACE FUNCTION public.calendario_itens_antecipar_resumo(
  p_empresa     text,
  p_fim_recesso date,
  p_hoje        date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date)
)
RETURNS TABLE (avaliados int, listados int, sem_dado int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE a.motivo = 'listado')::int,
         count(*) FILTER (WHERE a.motivo NOT IN ('listado', 'cobre'))::int
    FROM public.calendario_antecipar_avaliacao(p_empresa, p_fim_recesso, p_hoje) a;
$$;

COMMENT ON FUNCTION public.calendario_itens_antecipar_resumo(text, date, date) IS
  'Contagem do sinal antecipar sobre o MESMO universo da lista: avaliados, listados e sem_dado (sem demanda/LT/'
  'estoque/chegada ou grupo de embalagem). Lista vazia com sem_dado > 0 NÃO é "nada a antecipar".';

CREATE OR REPLACE FUNCTION public.calendario_previsao_pedido(
  p_empresa     text,
  p_fornecedor  text,
  p_portal_data date,
  p_lt          int,
  p_hoje        date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date)
)
RETURNS TABLE (promessa date, recebimento date)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_promessa date;
  v_receb date;
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'master'::public.app_role)
                                OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-SEM-PERMISSAO] calendario de operacao e restrito a staff';
  END IF;
  -- = previsaoComCalendario (edge v1.17): portal + 2 úteis; senão hoje + LT úteis — no calendário do FORNECEDOR.
  IF p_portal_data IS NOT NULL THEN
    v_promessa := public.calendario_somar_dias_uteis_fornecedor(p_empresa, p_fornecedor, p_portal_data, 2);
  ELSIF p_lt IS NOT NULL AND p_hoje IS NOT NULL THEN
    v_promessa := public.calendario_somar_dias_uteis_fornecedor(p_empresa, p_fornecedor, p_hoje, p_lt);
  END IF;
  IF v_promessa IS NOT NULL THEN
    v_receb := public.calendario_proximo_dia_recebimento(p_empresa, v_promessa);
  END IF;
  -- Nunca "promessa com recebimento nulo": qualquer NULL ⇒ a linha inteira NULL (a tela diz "previsão indisponível").
  IF v_promessa IS NULL OR v_receb IS NULL THEN
    promessa := NULL; recebimento := NULL;
  ELSE
    promessa := v_promessa; recebimento := v_receb;
  END IF;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.calendario_previsao_pedido(text, text, date, int, date) IS
  'Prévia (pedido sugerido/aprovado, antes do disparo) da promessa do fornecedor e do recebimento da empresa, com a '
  'MESMA regra da edge disparar-pedidos-aprovados v1.17. Sempre 1 linha; qualquer NULL ⇒ (NULL, NULL). Spec §6.3.1.';

-- ACL: REVOKE nas DUAS pontas (PUBLIC e anon) — o default privileges do Supabase concede EXECUTE a anon.
REVOKE ALL ON FUNCTION public.calendario_antecipar_avaliacao(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_antecipar_avaliacao(text, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calendario_itens_antecipar(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_itens_antecipar(text, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calendario_itens_antecipar_resumo(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_itens_antecipar_resumo(text, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calendario_previsao_pedido(text, text, date, int, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_previsao_pedido(text, text, date, int, date) TO authenticated, service_role;

-- ── Postcondição embutida ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_nome text;
  v_fn regprocedure;
BEGIN
  IF to_regprocedure('public.calendario_proximo_dia_recebimento(text,date)') IS NULL
     OR to_regprocedure('public.calendario_somar_dias_uteis_fornecedor(text,text,date,integer)') IS NULL THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] funcoes de data da 20261119100000 ausentes';
  END IF;
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] private.cap_compras_ler(uuid) ausente';
  END IF;
  FOREACH v_nome IN ARRAY ARRAY[
    'public.calendario_antecipar_avaliacao(text,date,date)',
    'public.calendario_itens_antecipar(text,date,date)',
    'public.calendario_itens_antecipar_resumo(text,date,date)',
    'public.calendario_previsao_pedido(text,text,date,integer,date)']
  LOOP
    v_fn := to_regprocedure(v_nome);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] funcao ausente: %', v_nome;
    END IF;
    -- PUBLIC antes de anon: anon herda de PUBLIC, então PUBLIC aberto acusaria "anon" e esconderia a causa.
    IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] PUBLIC executa a RPC de antecipar: %', v_nome;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] anon executa a RPC de antecipar: %', v_nome;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] authenticated sem EXECUTE: %', v_nome;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-ANTECIPAR-POST] EXECUTE ausente para service_role: %', v_nome;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
