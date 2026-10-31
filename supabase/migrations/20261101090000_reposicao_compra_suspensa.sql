-- Migration: "SEGURAR COMPRA" escreve no motor — suspensão de recompra por SKU, com autor, motivo, revisão e
-- reativação em 1 clique; o motor (gerar_pedidos_sugeridos_ciclo) RESPEITA a suspensão e loga a compra evitada.
-- Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md (pós-Codex desenho, 11 P1 absorvidos).
-- Money-path. ⚠️ NÃO auto-aplica (nome custom) — aplicar via lovable-db-operator no SQL Editor, que executa a colagem
-- inteira numa transação implícita (sem BEGIN/COMMIT no corpo: o guard de paridade exige que o arquivo TERMINE na cauda
-- do motor — mesmo molde das 20260730130000 e 20261010210000).
-- Provada em PG17: db/test-compra-suspensa-motor.sh (falsificada). Fonte viva do corpo do motor:
-- db/embalagem-motor-rpc.sql (guard src/lib/reposicao/__tests__/embalagem-motor-paridade.test.ts — por isso o
-- CREATE OR REPLACE do motor e a cauda autocontida que ele exige são o FIM deste arquivo, byte-idênticos à fixture).
--
-- O que muda:
--   1. RPCs (SECURITY DEFINER, gate cap_compras_ler / cap_compras_escrever; sessão direta sem JWT = SQL Editor,
--      db:aplicar, cron — passa; PostgREST sem JWT — 42501):
--        _reposicao_compra_fonte_ok · _reposicao_compra_foto (internas, sem GRANT); gate INLINE em cada RPC
--        reposicao_compra_suspensa_candidatos(empresa, min_dias=180, incluir_corante=false)
--        reposicao_compra_suspender(empresa, skus[], motivo, revisar_em, origem, lote_id)
--        reposicao_compra_reativar(empresa, skus[], motivo) · reposicao_compra_suspensa_listar(empresa)
--        reposicao_compra_suspensa_runs(empresa, dias=30)
--   2. Cauda (depois do motor): tabela reposicao_compra_suspensa (1 writer = as RPCs; RLS SELECT cap_compras_ler),
--      reposicao_compra_suspensa_log (SELECT+INSERT cap_compras_ler, padrão do teto), reposicao_motor_run.suspensas_compra_n.
--   3. gerar_pedidos_sugeridos_ciclo: CTE suspensas_ativas (reativado_em IS NULL) → linha com SKU final OU âncora
--      suspensa sai de skus_inseriveis e vai para o log com a MESMA qtde_final que iria ao pedido (pós-teto/pós-portal).
--      Suspensão NÃO vence sozinha: revisar_em é data de revisão (Codex P1: vencimento silencioso recompraria excesso).
--
-- Pré-flight 2026-10-31 (psql-ro): pg_get_functiondef do motor em prod byte-idêntico à fonte viva (só o ';' final).
-- Rollback: reposicao_compra_reativar em massa (dado) — a função fica; sem linha ativa o motor é o de antes.


-- ── 1) Gate: INLINE em cada RPC (scripts/authz-manifest.ts exige `NOT private.cap_compras_*(…)` + RAISE no mesmo IF).
-- auth.uid() NULL: sessão DIRETA (SQL Editor / db:aplicar / pg_cron) passa — é o caminho do envelope do apply em
-- massa; PostgREST sem JWT (session_user authenticator/anon/authenticated) NÃO passa. Padrão da 20261010120000.

-- ── 2) Fonte de consumo (mesma régua da fin_ciclo_giro_sku §5.4-1: ≥330d de histórico e atualizada há ≤7d) ───────
CREATE OR REPLACE FUNCTION public._reposicao_compra_fonte_ok(p_empresa text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_min date; v_max date;
BEGIN
  SELECT min(v.data_emissao), max(v.data_emissao) INTO v_min, v_max
    FROM public.venda_items_history v WHERE v.empresa = upper(trim(p_empresa));
  RETURN v_max IS NOT NULL AND v_min <= v_hoje - 330 AND v_max >= v_hoje - 7;
END $$;

-- ── 3) Foto por SKU (saldo/cmc/cobertura 365d e 90d/no_motor/venda 90d/substituído/corante) ──────────────────────
-- p_skus NULL = todos os SKUs com saldo > 0 da account. Ausente ≠ zero: valor NULL sem custo, dias NULL sem consumo
-- ou sem fonte confiável. Join omie_products por (código, account) — a mesma chave do motor.
CREATE OR REPLACE FUNCTION public._reposicao_compra_foto(p_empresa text, p_skus bigint[])
RETURNS TABLE(sku_codigo_omie bigint, descricao text, familia text, fornecedor_nome text, saldo numeric, cmc numeric,
              valor numeric, consumo_365 numeric, dias_365 numeric, consumo_90 numeric, dias_90 numeric,
              no_motor boolean, valor_vendido_90d numeric, substituido boolean, corante boolean, classe text, fonte_ok boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_emp text := upper(trim(p_empresa));
  v_account text := public._fin_estoque_account(lower(trim(p_empresa)));   -- P0001 se empresa inválida
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_fonte boolean := public._reposicao_compra_fonte_ok(p_empresa);
BEGIN
  RETURN QUERY
  -- Universo: p_skus NULL → todo SKU com saldo > 0 da account; lista → TODOS os SKUs pedidos, inclusive quem ZEROU
  -- (saldo 0: é a ruptura que a suspensão pode ter causado — Codex código P1-1) e quem não tem linha de estoque
  -- (saldo NULL = desconhecido, nunca 0 fabricado).
  WITH alvo AS MATERIALIZED (
    SELECT DISTINCT a.sku AS cod FROM unnest(p_skus) AS a(sku) WHERE a.sku IS NOT NULL
    UNION
    SELECT ip0.omie_codigo_produto FROM public.inventory_position ip0
     WHERE p_skus IS NULL AND ip0.account = v_account AND ip0.saldo > 0
  ),
  base AS MATERIALIZED (
    SELECT k.cod, op.descricao, op.familia, ip.saldo, ip.cmc,
           public._fin_estoque_classe(op.tipo_produto, op.familia) AS classe
      FROM alvo k
      LEFT JOIN public.inventory_position ip ON ip.account = v_account AND ip.omie_codigo_produto = k.cod
      LEFT JOIN public.omie_products op ON op.omie_codigo_produto = k.cod AND op.account = lower(v_emp)
  ),
  dem AS MATERIALIZED (
    SELECT d.sku_codigo_omie AS cod,
           sum(d.quantidade) AS q365,
           sum(d.quantidade) FILTER (WHERE d.data_emissao >= v_hoje - 90) AS q90
      FROM public.v_sku_demanda_efetiva d
     WHERE v_fonte AND d.empresa = v_emp AND d.data_emissao >= v_hoje - 365
       AND (p_skus IS NULL OR d.sku_codigo_omie = ANY (p_skus))
     GROUP BY d.sku_codigo_omie
  )
  SELECT b.cod, b.descricao, b.familia, sp.fornecedor_nome, b.saldo, b.cmc,
         CASE WHEN b.saldo IS NOT NULL AND b.cmc > 0 THEN round(b.saldo * b.cmc, 2) END,
         CASE WHEN v_fonte THEN coalesce(dm.q365, 0) END,
         CASE WHEN v_fonte AND b.saldo IS NOT NULL AND dm.q365 > 0 THEN round(b.saldo / (dm.q365 / 365.0), 1) END,
         CASE WHEN v_fonte THEN coalesce(dm.q90, 0) END,
         CASE WHEN v_fonte AND b.saldo IS NOT NULL AND dm.q90 > 0 THEN round(b.saldo / (dm.q90 / 90.0), 1) END,
         (coalesce(sp.habilitado_reposicao_automatica, false) AND coalesce(sp.tipo_reposicao, 'automatica') = 'automatica'),
         sp.valor_vendido_90d,
         EXISTS (SELECT 1 FROM public.sku_substituicao ss
                  WHERE ss.empresa = v_emp AND ss.sku_codigo_antigo = b.cod::text
                    AND ss.status = 'aplicada' AND ss.acao_parametros = 'consolidar_demanda'),
         (coalesce(b.familia, '') ILIKE 'Concentrados LC%'),
         b.classe, v_fonte
    FROM base b
    LEFT JOIN dem dm ON dm.cod = b.cod
    LEFT JOIN public.sku_parametros sp ON sp.empresa = v_emp AND sp.sku_codigo_omie = b.cod;
END $$;

-- ── 4) Candidatos ao lote "cobertura ≥ N dias" ───────────────────────────────────────────────────────────────────
-- Dupla janela (365d E 90d ≥ N): corta quem ACELEROU (prod 2026-10-31: 30 SKUs / R$19k dos 190). Corante
-- (Concentrados LC) fora por padrão — consumo dosado não registrado infla a cobertura. Substituído fora (demanda
-- foi para o destino). Sem fonte de consumo confiável → P0001 (fail-closed: não se calcula coorte às cegas).
CREATE OR REPLACE FUNCTION public.reposicao_compra_suspensa_candidatos(
  p_empresa text, p_min_dias integer DEFAULT 180, p_incluir_corante boolean DEFAULT false)
RETURNS TABLE(sku_codigo_omie bigint, descricao text, familia text, fornecedor_nome text, saldo numeric, cmc numeric,
              valor numeric, consumo_365 numeric, dias_365 numeric, dias_90 numeric, no_motor boolean,
              valor_vendido_90d numeric, corante boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_emp text := upper(trim(p_empresa)); v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND session_user IN ('authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_SESSAO' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND NOT private.cap_compras_ler(v_uid) THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_CAP_LER' USING ERRCODE = '42501';
  END IF;
  IF p_min_dias IS NULL OR p_min_dias < 30 OR p_min_dias > 3650 THEN
    RAISE EXCEPTION 'p_min_dias invalido: %', p_min_dias USING ERRCODE = 'P0001';
  END IF;
  IF NOT public._reposicao_compra_fonte_ok(v_emp) THEN
    RAISE EXCEPTION 'FONTE_CONSUMO_INDISPONIVEL' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT f.sku_codigo_omie, f.descricao, f.familia, f.fornecedor_nome, f.saldo, f.cmc, f.valor,
           f.consumo_365, f.dias_365, f.dias_90, f.no_motor, f.valor_vendido_90d, f.corante
      FROM public._reposicao_compra_foto(v_emp, NULL) f
     WHERE f.classe = 'giro'
       AND NOT f.substituido
       AND (p_incluir_corante OR NOT f.corante)
       AND f.dias_365 >= p_min_dias
       AND coalesce(f.dias_90, 1e9) >= p_min_dias
       AND NOT EXISTS (SELECT 1 FROM public.reposicao_compra_suspensa cs
                        WHERE cs.empresa = v_emp AND cs.sku_codigo_omie = f.sku_codigo_omie AND cs.reativado_em IS NULL)
     ORDER BY f.valor DESC NULLS LAST, f.sku_codigo_omie;
END $$;

-- ── 5) Suspender (o ÚNICO writer de INSERT) ──────────────────────────────────────────────────────────────────────
-- Idempotente pelo índice único parcial (2ª chamada → inserido=false). Substituído é RECUSADO (recusa='substituido'),
-- não inserido. pendentes_n = itens do SKU em pedido NORMAL pendente hoje: a suspensão vale no PRÓXIMO run do motor
-- (≤2h, ou "Recalcular"); o pendente de agora continua aprovável até lá — a UI avisa.
CREATE OR REPLACE FUNCTION public.reposicao_compra_suspender(
  p_empresa text, p_skus bigint[], p_motivo text, p_revisar_em date DEFAULT NULL,
  p_origem text DEFAULT 'ciclo_ui', p_lote_id uuid DEFAULT NULL)
RETURNS TABLE(sku_codigo_omie bigint, inserido boolean, recusa text, pendentes_n integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_emp text := upper(trim(p_empresa));
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_revisar date := coalesce(p_revisar_em, (now() AT TIME ZONE 'America/Sao_Paulo')::date + 90);
  v_uid uuid := auth.uid();
  v_texto text;
BEGIN
  IF v_uid IS NULL AND session_user IN ('authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_SESSAO' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND NOT private.cap_compras_escrever(v_uid) THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_CAP_ESCREVER' USING ERRCODE = '42501';
  END IF;
  PERFORM public._fin_estoque_account(lower(trim(p_empresa)));
  IF p_skus IS NULL OR cardinality(p_skus) = 0 THEN
    RAISE EXCEPTION 'p_skus vazio' USING ERRCODE = 'P0001';
  END IF;
  IF nullif(btrim(coalesce(p_motivo, '')), '') IS NULL THEN
    RAISE EXCEPTION 'motivo obrigatorio' USING ERRCODE = 'P0001';
  END IF;
  IF p_origem IS NULL OR p_origem NOT IN ('ciclo_ui', 'lote_cobertura', 'envelope') THEN
    RAISE EXCEPTION 'origem invalida: %', p_origem USING ERRCODE = 'P0001';
  END IF;
  IF v_revisar <= v_hoje OR v_revisar > v_hoje + 365 THEN
    RAISE EXCEPTION 'revisar_em fora de [hoje+1, hoje+365]: %', v_revisar USING ERRCODE = 'P0001';
  END IF;
  v_texto := CASE WHEN v_uid IS NULL THEN p_origem || ':' || session_user::text || ':' || v_hoje::text END;

  RETURN QUERY
  WITH alvo AS (SELECT DISTINCT a.sku FROM unnest(p_skus) AS a(sku) WHERE a.sku IS NOT NULL),
  foto AS (SELECT * FROM public._reposicao_compra_foto(v_emp, p_skus)),
  ins AS (
    INSERT INTO public.reposicao_compra_suspensa
      (empresa, sku_codigo_omie, motivo, origem, lote_id, suspenso_por, suspenso_por_texto, revisar_em,
       foto_saldo, foto_cmc, foto_valor, foto_cobertura_dias, foto_cobertura_90d_dias, foto_no_motor, foto_valor_vendido_90d)
    SELECT v_emp, a.sku, btrim(p_motivo), p_origem, p_lote_id, v_uid, v_texto, v_revisar,
           f.saldo, f.cmc, f.valor, f.dias_365, f.dias_90, f.no_motor, f.valor_vendido_90d
      FROM alvo a
      LEFT JOIN foto f ON f.sku_codigo_omie = a.sku
     WHERE NOT coalesce(f.substituido, false)
    ON CONFLICT (empresa, sku_codigo_omie) WHERE reativado_em IS NULL DO NOTHING
    RETURNING sku_codigo_omie
  )
  SELECT a.sku,
         (i.sku_codigo_omie IS NOT NULL),
         CASE WHEN coalesce(f.substituido, false) THEN 'substituido'
              WHEN i.sku_codigo_omie IS NULL THEN 'ja_suspensa' END,
         (SELECT count(*)::integer
            FROM public.pedido_compra_item pci
            JOIN public.pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
           WHERE pcs.empresa = v_emp
             AND pcs.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
             AND coalesce(pcs.tipo_ciclo, 'normal') = 'normal'
             AND (pci.sku_codigo_omie = a.sku::text
                  OR pci.sku_codigo_omie IN (SELECT m2.sku_codigo_omie
                                               FROM public.sku_embalagem_equivalencia m1
                                               JOIN public.sku_embalagem_equivalencia m2 ON m2.grupo_id = m1.grupo_id AND m2.ativo
                                              WHERE m1.empresa = lower(v_emp) AND m1.ativo AND m1.sku_codigo_omie = a.sku::text)))
    FROM alvo a
    LEFT JOIN foto f ON f.sku_codigo_omie = a.sku
    LEFT JOIN ins i ON i.sku_codigo_omie = a.sku
   ORDER BY a.sku;
END $$;

-- ── 6) Reativar (o ÚNICO writer de UPDATE) ───────────────────────────────────────────────────────────────────────
-- Encerra a suspensão ATIVA. impedimento diz o que AINDA segura o SKU fora da compra depois do clique (Codex P2-12):
-- fora_do_motor (flag/tipo), substituido, ancora_suspensa (membro de grupo cuja âncora segue suspensa). NULL = elegível.
CREATE OR REPLACE FUNCTION public.reposicao_compra_reativar(p_empresa text, p_skus bigint[], p_motivo text DEFAULT NULL)
RETURNS TABLE(sku_codigo_omie bigint, reativado boolean, impedimento text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_emp text := upper(trim(p_empresa)); v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND session_user IN ('authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_SESSAO' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND NOT private.cap_compras_escrever(v_uid) THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_CAP_ESCREVER' USING ERRCODE = '42501';
  END IF;
  PERFORM public._fin_estoque_account(lower(trim(p_empresa)));
  IF p_skus IS NULL OR cardinality(p_skus) = 0 THEN
    RAISE EXCEPTION 'p_skus vazio' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  WITH alvo AS (SELECT DISTINCT a.sku FROM unnest(p_skus) AS a(sku) WHERE a.sku IS NOT NULL),
  upd AS (
    UPDATE public.reposicao_compra_suspensa cs
       SET reativado_em = now(), reativado_por = v_uid, motivo_reativacao = nullif(btrim(coalesce(p_motivo, '')), '')
     WHERE cs.empresa = v_emp AND cs.reativado_em IS NULL AND cs.sku_codigo_omie IN (SELECT sku FROM alvo)
    RETURNING cs.sku_codigo_omie
  ),
  foto AS (SELECT * FROM public._reposicao_compra_foto(v_emp, p_skus))
  SELECT a.sku, (u.sku_codigo_omie IS NOT NULL),
         CASE WHEN coalesce(f.substituido, false) THEN 'substituido'
              -- membro de grupo: a âncora é quem está no motor; se ela segue suspensa, é isso que segura a linha
              WHEN EXISTS (SELECT 1
                             FROM public.sku_embalagem_equivalencia me
                             JOIN public.sku_embalagem_equivalencia anc
                               ON anc.grupo_id = me.grupo_id AND anc.ativo AND anc.fator_para_base = 1
                             JOIN public.reposicao_compra_suspensa cs2
                               ON cs2.empresa = v_emp AND cs2.reativado_em IS NULL AND cs2.sku_codigo_omie::text = anc.sku_codigo_omie
                            WHERE me.empresa = lower(v_emp) AND me.ativo AND me.sku_codigo_omie = a.sku::text
                              AND anc.sku_codigo_omie <> a.sku::text
                              -- a âncora reativada NESTA chamada ainda aparece ativa no snapshot do CTE (Codex P2-5)
                              AND NOT (cs2.sku_codigo_omie IN (SELECT sku FROM alvo))) THEN 'ancora_suspensa'
              -- fora do motor = nem o SKU nem a âncora do seu grupo estão habilitados/automáticos (o galão compra pela âncora)
              WHEN NOT coalesce(f.no_motor, false)
               AND NOT EXISTS (SELECT 1
                                 FROM public.sku_embalagem_equivalencia me
                                 JOIN public.sku_embalagem_equivalencia anc
                                   ON anc.grupo_id = me.grupo_id AND anc.ativo AND anc.fator_para_base = 1
                                 JOIN public.sku_parametros sp
                                   ON sp.empresa = v_emp AND sp.sku_codigo_omie::text = anc.sku_codigo_omie
                                  AND coalesce(sp.habilitado_reposicao_automatica, false)
                                  AND coalesce(sp.tipo_reposicao, 'automatica') = 'automatica'
                                WHERE me.empresa = lower(v_emp) AND me.ativo AND me.sku_codigo_omie = a.sku::text) THEN 'fora_do_motor'
         END
    FROM alvo a
    LEFT JOIN upd u ON u.sku_codigo_omie = a.sku
    LEFT JOIN foto f ON f.sku_codigo_omie = a.sku
   ORDER BY a.sku;
END $$;

-- ── 7) Listar ativas (foto + situação AO VIVO + evitado no último run) ───────────────────────────────────────────
-- A foto é o denominador congelado do episódio; saldo/cobertura/valor atuais são relidos agora. cobertura_90d_atual
-- baixa é o sinal PROVISÓRIO de risco de falta enquanto o sensor de ruptura (Frente A) não existe — não é fill-rate.
CREATE OR REPLACE FUNCTION public.reposicao_compra_suspensa_listar(p_empresa text)
RETURNS TABLE(id uuid, sku_codigo_omie bigint, descricao text, fornecedor_nome text, motivo text, origem text, lote_id uuid,
              suspenso_em timestamptz, revisar_em date, suspenso_por uuid, suspenso_por_texto text,
              foto_valor numeric, foto_cobertura_dias numeric, foto_cobertura_90d_dias numeric, foto_no_motor boolean,
              foto_valor_vendido_90d numeric,
              saldo_atual numeric, valor_atual numeric, cobertura_90d_atual numeric, cobertura_365d_atual numeric,
              no_motor_atual boolean, evitado_ultimo_run numeric, qtde_ultimo_run numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_emp text := upper(trim(p_empresa)); v_run uuid; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND session_user IN ('authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_SESSAO' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND NOT private.cap_compras_ler(v_uid) THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_CAP_LER' USING ERRCODE = '42501';
  END IF;
  PERFORM public._fin_estoque_account(lower(trim(p_empresa)));
  SELECT r.run_id INTO v_run FROM public.reposicao_motor_run r WHERE r.empresa = v_emp ORDER BY r.criado_em DESC LIMIT 1;
  RETURN QUERY
  WITH ativas AS (
    SELECT cs.* FROM public.reposicao_compra_suspensa cs WHERE cs.empresa = v_emp AND cs.reativado_em IS NULL
  ),
  foto AS (
    SELECT f.* FROM public._reposicao_compra_foto(v_emp, (SELECT array_agg(a.sku_codigo_omie) FROM ativas a)) f
  ),
  ult AS (
    SELECT l.suspensa_id, sum(l.valor_evitado) AS valor, sum(l.qtde_final) AS qtde
      FROM public.reposicao_compra_suspensa_log l WHERE l.run_id = v_run GROUP BY l.suspensa_id
  )
  SELECT a.id, a.sku_codigo_omie, f.descricao, f.fornecedor_nome, a.motivo, a.origem, a.lote_id,
         a.suspenso_em, a.revisar_em, a.suspenso_por, a.suspenso_por_texto,
         a.foto_valor, a.foto_cobertura_dias, a.foto_cobertura_90d_dias, a.foto_no_motor, a.foto_valor_vendido_90d,
         f.saldo, f.valor, f.dias_90, f.dias_365, f.no_motor, u.valor, u.qtde
    FROM ativas a
    LEFT JOIN foto f ON f.sku_codigo_omie = a.sku_codigo_omie
    LEFT JOIN ult u ON u.suspensa_id = a.id
   ORDER BY a.foto_valor_vendido_90d DESC NULLS LAST, a.foto_valor DESC NULLS LAST, a.sku_codigo_omie;
END $$;

-- ── 8) Runs do motor no período (DENOMINADOR do sensor "compra evitada") ─────────────────────────────────────────
-- Uma linha por run, com ou sem supressão: run sem linha segurada é ZERO medido; run ausente é ausência de dado.
CREATE OR REPLACE FUNCTION public.reposicao_compra_suspensa_runs(p_empresa text, p_dias integer DEFAULT 30)
RETURNS TABLE(run_id uuid, criado_em timestamptz, data_ciclo date, suspensas_compra_n integer, skus_incluidos integer,
              valor_evitado numeric, linhas_sem_preco integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_emp text := upper(trim(p_empresa)); v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND session_user IN ('authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_SESSAO' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND NOT private.cap_compras_ler(v_uid) THEN
    RAISE EXCEPTION 'COMPRA_SUSPENSA_SEM_CAP_LER' USING ERRCODE = '42501';
  END IF;
  PERFORM public._fin_estoque_account(lower(trim(p_empresa)));
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 365 THEN
    RAISE EXCEPTION 'p_dias invalido: %', p_dias USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT r.run_id, r.criado_em, r.data_ciclo, r.suspensas_compra_n, r.skus_incluidos,
         (SELECT sum(l.valor_evitado) FROM public.reposicao_compra_suspensa_log l WHERE l.run_id = r.run_id),
         (SELECT count(*)::integer FROM public.reposicao_compra_suspensa_log l WHERE l.run_id = r.run_id AND l.valor_evitado IS NULL)
    FROM public.reposicao_motor_run r
   WHERE r.empresa = v_emp AND r.criado_em >= now() - make_interval(days => p_dias)
   ORDER BY r.criado_em DESC;
END $$;

-- ── 9) ACL (nasce aberto: REVOKE por nome antes do GRANT; helpers internos sem EXECUTE para app) ─────────────────
REVOKE ALL ON FUNCTION public._reposicao_compra_fonte_ok(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reposicao_compra_foto(text, bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reposicao_compra_suspensa_candidatos(text, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reposicao_compra_suspender(text, bigint[], text, date, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reposicao_compra_reativar(text, bigint[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reposicao_compra_suspensa_listar(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reposicao_compra_suspensa_runs(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_compra_suspensa_candidatos(text, integer, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reposicao_compra_suspender(text, bigint[], text, date, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reposicao_compra_reativar(text, bigint[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reposicao_compra_suspensa_listar(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reposicao_compra_suspensa_runs(text, integer) TO authenticated, service_role;

DO $post_rpc$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.reposicao_compra_suspensa_candidatos(text,integer,boolean)',
                           'public.reposicao_compra_suspender(text,bigint[],text,date,text,uuid)',
                           'public.reposicao_compra_reativar(text,bigint[],text)',
                           'public.reposicao_compra_suspensa_listar(text)',
                           'public.reposicao_compra_suspensa_runs(text,integer)'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: ACL errada em %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public._reposicao_compra_fonte_ok(text)', 'public._reposicao_compra_foto(text,bigint[])'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: helper interno exposto %', f;
    END IF;
  END LOOP;
  RAISE NOTICE 'COMPRA-SUSPENSA-RPC-OK';
END
$post_rpc$;

-- ── 10) O MOTOR + a cauda que ele exige (do CREATE até o FIM = db/embalagem-motor-rpc.sql, guard de paridade) ────
CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date)
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
  v_stale_dias INT := 45;  -- motor confia no preço-app por N dias (painel usa 24h; manual precisa folga). Config abaixo.
  v_run_id uuid := gen_random_uuid();  -- [GATE estoque-não-confirmado] carimba os suprimidos desta execução no log
  -- [TETO cobertura] NULL = classe sem teto (cap desligado). Flag por empresa nasce false; dias só valem com a flag.
  v_teto_ativo boolean := false;
  v_teto_b numeric := NULL;
  v_teto_c numeric := NULL;
  -- [COMPROMETIDO] janela de frescor da RELEITURA do pedido de venda no Omie. CONSTANTE de propósito: 7d seria
  -- outra análise (Codex 2026-10-10), não um ajuste de config. O que a config faz é só DESLIGAR (v_comp_ativo).
  v_comp_horas CONSTANT int := 36;
  v_comp_ativo boolean := false;
BEGIN
  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- Janela de frescor do preço-app que o motor aceita p/ trocar a embalagem (decisão B da spec). Global.
  SELECT COALESCE((SELECT NULLIF(btrim(value), '')::int
                   FROM company_config WHERE key = 'embalagem_preco_motor_stale_dias' LIMIT 1), 45)
    INTO v_stale_dias;

  -- [TETO cobertura] Config POR EMPRESA, fail-off: flag ausente/≠true → cap desligado; dias com parse blindado
  -- (regex antes do cast — valor lixo NUNCA aborta o recálculo, só desliga o teto daquela classe). '0' → NULL.
  SELECT COALESCE((SELECT lower(btrim(value)) = 'true' FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_ativa' LIMIT 1), false)
    INTO v_teto_ativo;
  IF v_teto_ativo THEN
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_b' LIMIT 1), 0)
      INTO v_teto_b;
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_c' LIMIT 1), 0)
      INTO v_teto_c;
  END IF;

  -- [COMPROMETIDO] Desligador POR EMPRESA: 'true' liga, qualquer outro valor desliga (= o motor de antes). Chave
  -- ausente (ou valor NULL) → ligado SÓ na oben, a única empresa onde a unidade e o Omie foram medidos.
  SELECT COALESCE((SELECT lower(btrim(value)) = 'true' FROM company_config
                   WHERE key = 'reposicao_comprometido_' || lower(p_empresa) || '_ativo' LIMIT 1),
                  lower(p_empresa) = 'oben')
    INTO v_comp_ativo;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte).
  UPDATE pedido_compra_sugerido
  SET status = 'expirado_sem_aprovacao', atualizado_em = now()
  WHERE empresa = p_empresa
    AND data_ciclo < p_data_ciclo
    AND status = 'pendente_aprovacao'
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  -- [INTRADAY 3/4] limpeza do dia: só ciclo NORMAL (preserva oportunidade/promoção pendentes) e
  -- INCLUI bloqueado_guardrail do dia (re-avaliado a cada rodada; anti compra dupla).
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        -- [SIMULADO] 'disparado_simulado' É pedido real: o dry_run da edge chama IncluirPedCompra no Omie.
        -- Fora desta lista ele sumia do "a caminho" (o 2º ramo exige nº Omie NULL) → compra dupla.
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
         -- [FANTASMA] Erro TERMINAL do portal NÃO é estoque a caminho. 'erro_nao_retentavel' só é alcançado
         -- com efetivarAttempted=false — o resultado AMBÍGUO tem estado PRÓPRIO (aceito_portal_sem_protocolo
         -- / indeterminado_requer_conciliacao), então este status significa "nada foi colocado no fornecedor".
         -- Contá-lo inflava o estoque efetivo e SUPRIMIA a recompra por 7 dias (pedido #1276: 4 SKUs no ou
         -- abaixo do ponto de pedido ficaram 7 dias sem sugestão, 3 deles classe A).
         -- As 3 guardas são fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou nº do
         -- pedido no Omie) para seguir contando. Subcomprar é recuperável; comprar duas vezes queima caixa.
         -- IS NOT DISTINCT FROM, não "=": negação é NULL-blind. Com "=" e status_envio_portal NULL o
         -- predicado interno vira NULL, NOT(NULL) é NULL, e o pedido SAUDÁVEL some desta CTE — o motor
         -- recompraria TODO SKU em pedido aprovado ainda não disparado (compra dupla em escala, não só no
         -- caso fantasma). Com IS NOT DISTINCT FROM, NULL dá false → NOT(false) → segue contando.
         -- Pego pelo db/test-em-transito-erro-terminal.sh (S7 + falsificação F5).
         AND NOT (
           pcs2.status = 'aprovado_aguardando_disparo'
           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
           AND pcs2.portal_protocolo IS NULL
           AND pcs2.omie_pedido_compra_numero IS NULL
         ))
        OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  -- [COMPROMETIDO] Estoque já VENDIDO em pedido de venda ABERTO no Omie. O Omie da Oben não reserva (disponível =
  -- físico em 500/500 SKUs, 2026-10-10) e só baixa o físico na NF: sem isto o motor via como livre o que já
  -- tem dono e não comprava. Abertos = os 3 status pré-NF (etapa 10 → importado, 20 → enviado, 50 → separacao).
  -- PRECISÃO > RECALL: subcontar é o motor de antes (seguro); supercontar fabrica compra. Por isso só conta:
  --   · a linha CANÔNICA importada do Omie (hash_payload 'omie_…'); o gêmeo push do app fica fora (dupla contagem);
  --   · pedido RELIDO pelo Omie nas últimas 36 h (omie_reconciliado_em). Há ~2.500 pedidos velhos parados em status
  --     aberto sem releitura — lixo que fabricaria compra. A releitura é a ListarPedidos por inclusão OU alteração
  --     (2/2h, janela 7d; 1×/dia, 30d): faturar/cancelar/editar é alteração e volta a ser lido. A janela é "visto
  --     há pouco", não prova de que segue aberto: NF emitida entre a releitura e o sync do físico conta 2× por até
  --     ~2h, e pedido EXCLUÍDO no Omie (não volta na listagem) conta até 36 h — o freio é a aprovação humana, que vê
  --     o desconto no item (estoque_comprometido);
  --   · pedido sem irmão de MESMO número (o faturamento parcial — ver [PARCIAL] abaixo);
  --   · quantidade numérica > 0 (ausente/texto/negativa = item ignorado, nunca 0 fabricado nem soma negativa).
  --     Limite conhecido do PRODUTOR: o sync grava `quantidade || 1` (0/ausente no Omie vira 1) — sem efeito medido.
  -- Unidade: a do Omie do SKU, a MESMA do estoque/ponto/máximo — por isso só o caminho SEM grupo de equivalência
  -- o desconta (sku_base): no concentrado WP a venda vem ora em litro, ora em embalagem (medido), e adivinhar é
  -- fabricar. RLS de sales_orders vale (função INVOKER): staff e o cron veem tudo; customer só o seu → subconta.
  comprometido AS (
    SELECT x.sku, SUM(x.q) AS qtde
    FROM (
      -- O cast só sob o CASE: a ordem de avaliação do WHERE não é garantida (o planner pode castar antes de filtrar).
      SELECT it->>'omie_codigo_produto' AS sku,
             CASE WHEN jsonb_typeof(it->'quantidade') = 'number' THEN (it->>'quantidade')::numeric END AS q
      FROM sales_orders so
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END) it
      WHERE v_comp_ativo
        AND so.account = lower(p_empresa)
        AND so.deleted_at IS NULL
        AND so.hash_payload LIKE 'omie\_%'
        AND so.status IN ('importado', 'separacao', 'enviado')
        AND so.omie_reconciliado_em > now() - make_interval(hours => v_comp_horas)
        -- [PARCIAL] O faturamento parcial do Omie gera OUTRO pedido com o MESMO número, e a origem pode seguir aberta
        -- com a quantidade ORIGINAL (medido: nº 12580 — origem 'importado' e irmão 'faturado' com itens idênticos).
        -- Sem saldo por item não há como separar: número repetido entre os importados da conta → a origem não conta
        -- (1 em 2.323 pedidos em 180 dias). Sem número não dá para conferir → não conta.
        AND so.omie_numero_pedido IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sales_orders s2
                         WHERE s2.account = so.account AND s2.omie_numero_pedido = so.omie_numero_pedido
                           AND s2.hash_payload LIKE 'omie\_%' AND s2.id <> so.id)
    ) x
    WHERE x.q > 0 AND x.q < 1e9   -- ausente/texto/zero/negativa = item ignorado (nunca 0 fabricado nem soma negativa)
    GROUP BY 1
  ),
  -- [DEDUP-NFE] 1 obs por (empresa, NFe, SKU); antes: 1 por LINHA de sku_leadtime_history, o que
  -- ponderava o AVG pela multiplicidade (NFe que fatura N pedidos regravava o item N×).
  -- [2 CONSUMIDORES] O filtro de preço saiu do WHERE e virou FILTER na agregação — de propósito.
  -- Esta CTE serve a DOIS consumidores, que fazem perguntas DIFERENTES:
  --   · preco_unitario → "quanto custou?"  ⇒ agrega só a obs precificável (FILTER). Sem nenhuma
  --     ⇒ NULL, e o COALESCE(cmc, …) decide. Ausente ≠ zero.
  --   · n (lido SÓ como `pm.n IS NULL` ⇒ primeira_compra) → "já foi comprado?" ⇒ conta TODA obs.
  --     COMPRAR ≠ SABER QUANTO CUSTOU. Com o filtro no WHERE, a obs cuja quantidade a view NULLa
  --     (cópias divergem) derrubaria o SKU INTEIRO da CTE ⇒ o badge mentiria "primeira compra"
  --     num SKU já comprado. Não é hipótese: medido ZERO no pré-flight e DOIS poucas horas
  --     depois, na MESMA sessão — o resíduo se move (o sync grava). Com o FILTER, o conjunto de
  --     primeira_compra fica IDÊNTICO ao de hoje (medido nos dois sentidos: nenhum SKU entra,
  --     nenhum sai), enquanto o preço passa a ser o deduplicado. É o único ponto em que esta
  --     migration se afasta do "trocar só o FROM" — e é o que a impede de trocar viés por mentira.
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0))
             FILTER (WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0) AS preco_unitario,
           COUNT(*) AS n
    FROM v_sku_leadtime_efetivo slh
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  -- ── EMBALAGEM (novo) ─────────────────────────────────────────────────────────────────────
  -- Membros ativos dos grupos de equivalência (empresa = lower).
  -- [UNIDADES #2849] conv = unidades Omie (o que o estoque, o ponto e o máximo contam) por embalagem comprada
  -- (o que qtde_final, o em trânsito e o PO contam). Concentrado WP: estoque em L, QT = 0,81 L e GL = 3,24 L.
  -- Vale só com o grupo INTEIRO cadastrado e COERENTE com o fator (u/fator igual em todos os membros: a
  -- escolha QT↔GL compara custo por fator, a quantidade divide por conv — os dois têm de concordar). Senão o
  -- grupo todo volta ao fator relativo, que é a conta de antes (cadastro ausente ≠ 1 L por embalagem).
  equiv AS (
    SELECT q.grupo_id, q.sku, q.fator_para_base,
           CASE WHEN bool_and(q.u IS NOT NULL AND q.u > 0 AND q.u < 1e9) OVER (PARTITION BY q.grupo_id)
                 AND min(q.u / q.fator_para_base) OVER (PARTITION BY q.grupo_id)
                   = max(q.u / q.fator_para_base) OVER (PARTITION BY q.grupo_id)
                THEN q.u ELSE q.fator_para_base END AS conv
    FROM (SELECT grupo_id, sku_codigo_omie::text AS sku, fator_para_base, unidades_omie_por_embalagem AS u
          FROM sku_embalagem_equivalencia
          WHERE empresa = lower(p_empresa) AND ativo = TRUE AND fator_para_base > 0) q
  ),
  -- Só grupos com >= 2 membros têm decisão de embalagem.
  equiv_grupos AS (
    SELECT grupo_id FROM equiv GROUP BY grupo_id HAVING count(*) >= 2
  ),
  -- Preço-app mais recente por SKU (empresa = lower), líquido e > 0.
  preco_app AS (
    SELECT DISTINCT ON (sku_codigo_omie) sku_codigo_omie::text AS sku, preco, capturado_em
    FROM sku_preco_fornecedor_capturado
    WHERE empresa = lower(p_empresa) AND status = 'ok' AND preco > 0
    ORDER BY sku_codigo_omie, capturado_em DESC
  ),
  -- Portal-map ativo por SKU (empresa = upper). Sem map → não dá pra emitir ao portal → inelegível.
  portal_map AS (
    SELECT DISTINCT sku_omie::text AS sku
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE AND sku_portal IS NOT NULL AND btrim(sku_portal) <> ''
  ),
  -- [EMBALAGEM PORTAL] fator_conversao = unidades do PORTAL por unidade do OMIE (0,2 = litro → balde 5 L).
  -- Só fator ATIVO, finito e > 0, DIFERENTE de 1, chaveado por (empresa, fornecedor, sku) — a UNIQUE da tabela.
  -- O join adiante exige fornecedor_nome = o da linha (sp.fornecedor_nome): precisão > recall — de-para de
  -- OUTRO fornecedor nunca decide a embalagem desta compra. Fator ≤ 0/NaN/Infinity é ignorado aqui (status quo em L);
  -- a edge, que tem efeito externo, é quem lança (fail-closed na fronteira).
  portal_fator AS (
    SELECT sku_omie::text AS sku, fornecedor_nome, fator_conversao AS fator
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE
      AND fator_conversao IS NOT NULL AND fator_conversao > 0 AND fator_conversao <> 1
      AND fator_conversao < 1e9   -- UMA guarda de finitude: NaN e Infinity ordenam ACIMA de todo número em numeric (NaN > 0 é TRUE)
  ),
  -- [P0-a] Saldo físico do Omie por SKU (account-aware; 1 linha/SKU, a mais recente). As 2 fontes de estoque
  -- DIVERGEM: inventory_position tem alguns galões (WP87/WP04), sku_estoque_atual tem outros (WP01). GREATEST
  -- (adiante) pega o galão real de onde estiver.
  inv_saldo AS (
    SELECT DISTINCT ON (omie_codigo_produto) omie_codigo_produto::text AS sku, saldo
    FROM inventory_position
    WHERE account = ANY (CASE lower(p_empresa)
            WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
            WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
            WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
            ELSE ARRAY[lower(p_empresa)] END)
    ORDER BY omie_codigo_produto, synced_at DESC NULLS LAST
  ),
  -- [P1-f] Membro ELEGÍVEL p/ a decisão: preço-app FRESCO + portal-map + CATÁLOGO OK (ativo, tipo≠04, família
  -- comprável, ativo_no_omie) — os MESMOS filtros que protegem a âncora, agora também no SKU que pode ser escolhido.
  membro_elegivel AS (
    SELECT e.grupo_id, e.sku, e.fator_para_base, e.conv, pa.preco,
           (pa.preco / e.fator_para_base) AS custo_base
    FROM equiv e
    JOIN equiv_grupos eg ON eg.grupo_id = e.grupo_id
    JOIN preco_app pa ON pa.sku = e.sku AND pa.capturado_em >= now() - make_interval(days => v_stale_dias)
    JOIN portal_map pm ON pm.sku = e.sku
    JOIN omie_products opm ON opm.omie_codigo_produto::text = e.sku AND opm.account = lower(p_empresa)
    LEFT JOIN sku_status_omie ssom ON ssom.empresa = p_empresa AND ssom.sku_codigo_omie = e.sku
    LEFT JOIN familia_nao_comprada fncm ON fncm.empresa = p_empresa AND fncm.familia = opm.familia
    WHERE COALESCE(opm.ativo, TRUE) = TRUE
      AND COALESCE(ssom.ativo_no_omie, TRUE) = TRUE
      AND fncm.id IS NULL
      AND COALESCE(opm.tipo_produto, opm.metadata->>'tipo_produto', '') <> '04'
      AND COALESCE(opm.descricao, '') NOT ILIKE '%450ML'   -- [P1-f] os MESMOS filtros de catálogo da âncora
      AND COALESCE(opm.descricao, '') NOT ILIKE '%405ML'
  ),
  -- Melhor embalagem do grupo (menor custo_base; empate → embalagem maior).
  embalagem_escolhida AS (
    SELECT DISTINCT ON (grupo_id)
           grupo_id, sku AS sku_escolhido, fator_para_base AS fator_escolhido,
           preco AS preco_escolhido, custo_base AS custo_base_escolhido, conv AS conv_escolhido
    FROM membro_elegivel
    ORDER BY grupo_id, custo_base ASC, fator_para_base DESC
  ),
  -- [P0-a/P0-b] Estoque consolidado por grupo (escala unidades-âncora):
  --   físico = Σ GREATEST(inv.saldo, sea.estoque_fisico)   ← pega o galão real de onde estiver
  --   a caminho = Σ [pendente(sea) + em_transito × conv]   ← embalagem em voo conta em unidades Omie (2 GL = 6,48 L no WP; 8 sem cadastro)
  grupo_estoque AS (
    SELECT e.grupo_id,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0)))                              AS fisico_grupo,
           SUM(COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.conv)           AS acaminho_grupo,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0))
               + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.conv)         AS estoque_grupo,
           -- [GATE estoque-não-confirmado] grupo NÃO-CONFIRMADO se QUALQUER membro ATIVO tem seed (cold_start_seed)
           -- sem inventory_position — pode ter saldo real que mudaria a decisão. NÃO conta "sem linha de sea" (galão
           -- legitimamente vive sem sea próprio; o estoque vem de outro membro — só a LINHA isolada gateia sea ausente).
           -- inv por PRESENÇA da linha (não saldo, que pode ser NULL — Codex P1, casa a LINHA); membro INATIVO no Omie
           -- NÃO vota — senão um galão descontinuado seed-only envenenaria o grupo ativo p/ sempre (Codex P1).
           bool_or(COALESCE(sea.fonte_sync, '') = 'cold_start_seed'
                   AND inv.sku IS NULL
                   AND COALESCE(ssg.ativo_no_omie, true) = true)                                               AS grupo_nao_confirmado
    FROM equiv e
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = p_empresa AND sea.sku_codigo_omie = e.sku
    LEFT JOIN inv_saldo inv        ON inv.sku = e.sku
    LEFT JOIN em_transito et       ON et.sku_codigo_omie = e.sku
    LEFT JOIN sku_status_omie ssg  ON ssg.empresa = p_empresa AND ssg.sku_codigo_omie = e.sku  -- [GATE] inativo não vota
    GROUP BY e.grupo_id
  ),
  -- ── BASE: 1 linha por ÂNCORA (SKU com sku_parametros, i.e. o quartinho) que dispara ──────────
  sku_base AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS ancora_sku, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo, sp.minimo_forcado_manual,
           -- [TETO cobertura] demanda + teto da classe EFETIVA (forcada→abc; hoje forcada é 100% NULL em prod).
           -- teto NULL = linha sem cap (classe A, classe ausente, ou flag/config desligada).
           sp.demanda_media_diaria AS demanda_diaria_linha,
           substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1) AS classe_abc_efetiva,
           CASE substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1)
             WHEN 'B' THEN v_teto_b WHEN 'C' THEN v_teto_c ELSE NULL END AS teto_dias_linha,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico_proprio,
           (COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS acaminho_proprio,
           ea.grupo_id AS equiv_grupo,
           ge.estoque_grupo, ge.fisico_grupo, ge.acaminho_grupo,
           -- estoque efetivo: do GRUPO quando a âncora pertence a um grupo; senão o próprio (no-op p/ a maioria).
           -- [COMPROMETIDO] só na linha SEM grupo (cp casa só ea.grupo_id IS NULL): − o vendido em aberto. Pode ficar
           -- NEGATIVO (vendido > físico): a compra cobre o pedido E repõe o máximo.
           COALESCE(ge.estoque_grupo,
                    COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)
                    - COALESCE(cp.qtde, 0)) AS estoque_efetivo,
           -- rastro: NULL = desconto não se aplica (SKU de grupo ou desligado); 0 = aplicado, nada em aberto.
           CASE WHEN ea.grupo_id IS NULL AND v_comp_ativo THEN COALESCE(cp.qtde, 0) END AS estoque_comprometido,
           ee.sku_escolhido, ee.fator_escolhido, ee.preco_escolhido, ee.custo_base_escolhido,
           ee.conv_escolhido, ea.conv AS conv_ancora,   -- [UNIDADES #2849] NULL p/ SKU sem grupo
           me_anc.custo_base AS ancora_custo_base,  -- NULL = âncora não-elegível → estrito (não troca)
           -- custo da linha p/ a ÂNCORA: cmc account-aware, senão preço médio histórico, senão NULL.
           -- [PRECO-AUSENTE] ausente≠zero — NÃO fabrica R$0 (o gate de auto-aprovação e o disparo já barram custo desconhecido).
           COALESCE(
             ( SELECT ipc.cmc FROM inventory_position ipc
               WHERE ipc.omie_codigo_produto::text = sp.sku_codigo_omie::text
                 AND ipc.account = ANY (CASE lower(p_empresa)
                       WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
                       WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
                       WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
                       ELSE ARRAY[lower(p_empresa)] END)
                 AND ipc.cmc > 0
               ORDER BY ipc.synced_at DESC NULLS LAST
               LIMIT 1 ),
             pm.preco_unitario) AS preco_unitario_ancora,   -- [PRECO-AUSENTE] sem fallback 0
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc,
           -- [GATE estoque-não-confirmado] confirmação por LINHA (SKU isolado): seed-only OU sem linha de estoque
           -- (Codex P1: sea AUSENTE é estoque desconhecido, não zero confirmado), sem inventory_position.
           -- inv via isl = inv_saldo (account-aware ['vendas','oben']), NÃO o ip órfão (account=lower(empresa) só):
           -- o estoque da OBEN vive em 'vendas'; PRESENÇA da linha de inv (isl.sku), p/ casar o gate de grupo.
           ((sea.sku_codigo_omie IS NULL OR COALESCE(sea.fonte_sync, '') = 'cold_start_seed') AND isl.sku IS NULL) AS linha_nao_confirmada,
           ge.grupo_nao_confirmado,
           sea.fonte_sync AS linha_fonte_sync,
           pf.fator AS fator_portal   -- [EMBALAGEM PORTAL] NULL = sem de-para com fator ≠ 1 p/ este fornecedor
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN inv_saldo isl ON isl.sku = sp.sku_codigo_omie::text   -- [GATE] confirmação por inventory_position (account-aware)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    -- equivalência da âncora + estoque consolidado + escolha de embalagem (NULL p/ SKU sem grupo).
    LEFT JOIN equiv ea ON ea.sku = sp.sku_codigo_omie::text
    LEFT JOIN grupo_estoque ge ON ge.grupo_id = ea.grupo_id
    LEFT JOIN embalagem_escolhida ee ON ee.grupo_id = ea.grupo_id
    LEFT JOIN membro_elegivel me_anc ON me_anc.grupo_id = ea.grupo_id AND me_anc.sku = sp.sku_codigo_omie::text
    LEFT JOIN portal_fator pf ON pf.sku = sp.sku_codigo_omie::text AND pf.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN comprometido cp ON cp.sku = sp.sku_codigo_omie::text AND ea.grupo_id IS NULL   -- [COMPROMETIDO] só sem grupo
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      AND COALESCE((
            SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
            FROM omie_products op04
            WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
              AND op04.account = lower(p_empresa)
            LIMIT 1
          ), '') <> '04'
      -- [P1-c] A âncora NÃO pode ser um galão (membro fator>1 de um grupo): senão um GL com ponto/max viraria
      -- âncora E seria escolhido por outro membro → 2 linhas do mesmo GL (uma com custo CMC/0). A âncora é
      -- sempre a unidade-base (fator 1). (Hoje no-op: galões têm ponto/max NULL; isto blinda o futuro.)
      AND NOT EXISTS (
            SELECT 1 FROM equiv eg2
            WHERE eg2.sku = sp.sku_codigo_omie::text AND eg2.fator_para_base > 1
          )
      -- [INTRADAY 4/4] o anti-dup de oportunidade foi MOVIDO p/ depois da decisão (skus_necessitando), porque
      -- precisa olhar o SKU FINAL (âncora OU galão escolhido), não o candidato — senão bloquearia o quartinho
      -- mantido por causa de uma oportunidade do galão que nem vai ser comprado. [P1-d, refinado pós-re-Codex]
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      -- GATILHO consolidado: estoque do GRUPO (ou próprio, − comprometido) <= ponto_pedido da âncora.
      AND COALESCE(ge.estoque_grupo,
                   COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)
                   - COALESCE(cp.qtde, 0)) <= sp.ponto_pedido
  ),
  -- ── DECISÃO: troca p/ galão só se ESTRITAMENTE mais barato/base e a âncora também é elegível ──
  -- [EMBALAGEM PORTAL] esta CTE decide em unidades-Omie (L) ou em embalagens do grupo; o múltiplo do portal
  -- entra na CTE seguinte (skus_necessitando), que é a que os INSERTs leem.
  skus_decididos AS (
    SELECT b.empresa,
           CASE WHEN trocou THEN b.sku_escolhido ELSE b.ancora_sku END AS sku_codigo_omie,
           b.ancora_sku, b.equiv_grupo,   -- [COMPRA SUSPENSA] a suspensão casa pelo SKU final OU pela âncora do grupo
           CASE WHEN trocou
                THEN COALESCE((SELECT op2.descricao FROM omie_products op2
                               WHERE op2.omie_codigo_produto::text = b.sku_escolhido
                                 AND op2.account = lower(p_empresa) LIMIT 1), b.sku_descricao)
                ELSE b.sku_descricao END AS sku_descricao,
           b.fornecedor_nome, b.grupo_codigo, b.ponto_pedido, b.estoque_maximo,
           COALESCE(b.fisico_grupo, b.estoque_fisico_proprio)  AS estoque_fisico,
           COALESCE(b.acaminho_grupo, b.acaminho_proprio)      AS estoque_a_caminho,
           b.estoque_efetivo, b.estoque_comprometido,
           ceil((b.estoque_maximo - b.estoque_efetivo) / COALESCE(b.conv_ancora, 1)) AS qtde_sugerida,  -- gate >0; EMBALAGENS da âncora [UNIDADES #2849]
           -- nº de embalagens do SKU escolhido: ceil(necessidade em unidades Omie / conv) [UNIDADES #2849];
           -- SKU sem grupo divide por 1 (idêntico ao de antes).
           -- [P1-e] minimo_forcado_manual (unidades-âncora) aplicado como piso ANTES de dividir pelo fator.
           -- [TETO cobertura] só o ramo ELSE recebe o cap (trocou ⇒ tem grupo ⇒ cap NULL; min_forcado ⇒ cap NULL).
           -- LEAST na necessidade-âncora ANTES do ceil; cap 0 zera a linha (sai do pedido via skus_inseriveis + log).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.conv_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual) / COALESCE(b.conv_ancora, 1))
             ELSE ceil(LEAST(b.estoque_maximo - b.estoque_efetivo,
                             COALESCE(b.cap_teto_ancora, b.estoque_maximo - b.estoque_efetivo)) / COALESCE(b.conv_ancora, 1))
           END AS qtde_final,
           -- [TETO cobertura] o que a linha compraria SEM o cap (mesma unidade de qtde_final — embalagens no galão):
           -- rastro p/ item/log; capada ⇔ qtde_final < qtde_sem_teto (comparação nos consumidores).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.conv_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual) / COALESCE(b.conv_ancora, 1))
             ELSE ceil((b.estoque_maximo - b.estoque_efetivo) / COALESCE(b.conv_ancora, 1))
           END AS qtde_sem_teto,
           b.cap_teto_ancora, b.teto_dias_linha, b.demanda_diaria_linha, b.classe_abc_efetiva,
           -- custo da linha: galão → preço-app (R$/embalagem, nunca 0); quartinho → cmc (R$/unidade Omie) × conv
           -- = R$/embalagem [UNIDADES #2849]; SKU sem grupo × 1.
           CASE WHEN trocou THEN b.preco_escolhido ELSE b.preco_unitario_ancora * COALESCE(b.conv_ancora, 1) END AS preco_unitario,
           b.primeira_compra, b.horario_corte_pedido, b.valor_maximo_mensal, b.delta_max_perc,
           -- [GATE estoque-não-confirmado] espelha estoque_efetivo=COALESCE(grupo,linha): decisão pelo grupo usa a
           -- confirmação do grupo; pela linha, a da linha. Suprime quando a fonte é só seed (ausente≠zero, precisão>recall).
           COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido,
           CASE WHEN b.grupo_nao_confirmado THEN 'grupo_membro_seed_only'
                WHEN b.linha_nao_confirmada THEN 'linha_seed_only'
                ELSE NULL END AS motivo,
           b.linha_fonte_sync,
           b.fator_embalagem
    FROM (
      SELECT b0.*,
             -- [EMBALAGEM PORTAL] só SKU SEM grupo de equivalência: no grupo, qtde_final já é nº de embalagens
             -- (QT↔GL) e o de-para dos concentrados tem fator 1 — aplicar aqui compraria N× a mais.
             CASE WHEN b0.equiv_grupo IS NULL THEN b0.fator_portal ELSE NULL END AS fator_embalagem,
             ( b0.sku_escolhido IS NOT NULL
               AND b0.sku_escolhido <> b0.ancora_sku
               AND b0.ancora_custo_base IS NOT NULL                 -- âncora elegível (comparável)
               AND b0.custo_base_escolhido < b0.ancora_custo_base   -- galão estritamente mais barato/base
             ) AS trocou,
             -- [TETO cobertura] cap em unidades-âncora; NULL = sem cap. Elegível só SEM grupo de embalagem
             -- (estoque consolidado QT+GL ÷ demanda só da âncora subcontaria → subcompra; Codex P1) e SEM
             -- minimo_forcado_manual (decisão humana vence). Piso de SERVIÇO ceil(pp − estoque): o cap corta o
             -- lote ACIMA do ponto de pedido, nunca a proteção — pp=1/estoque=1 compra 0 (mata o dente 1↔2),
             -- pp alto segue reposto até o pp (sem ruptura). Nunca negativo: no gatilho, estoque ≤ pp.
             CASE
               WHEN b0.teto_dias_linha IS NOT NULL
                AND b0.equiv_grupo IS NULL
                AND COALESCE(b0.minimo_forcado_manual, 0) <= 0
                AND COALESCE(b0.demanda_diaria_linha, 0) > 0
               THEN GREATEST(
                      floor(b0.teto_dias_linha * b0.demanda_diaria_linha - b0.estoque_efetivo),
                      GREATEST(0, ceil(b0.ponto_pedido - b0.estoque_efetivo))
                    )
               ELSE NULL
             END AS cap_teto_ancora
      FROM sku_base b0
    ) b
    -- [P1-d] [INTRADAY 4/4] anti-dup de oportunidade sobre o SKU FINAL (o que SERÁ gravado: âncora ou galão).
    -- Aqui já se sabe "trocou", então não bloqueia o quartinho mantido por uma oportunidade do galão não-usado.
    WHERE NOT EXISTS (
      SELECT 1
      FROM pedido_compra_item pci9
      JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
      WHERE pcs9.empresa = b.empresa
        AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
        AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
        AND pci9.sku_codigo_omie = CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END
    )
  ),
  -- ── [EMBALAGEM PORTAL] múltiplo da embalagem do fornecedor, ANTES da aprovação ──────────────────
  -- SKU em LITRO no Omie comprado em BALDE (fator 0,2): 36 L → ceil(7,2) = 8 BB → 40 L. É o número que a
  -- edge enviar-pedido-portal-sayerlack gravaria de qualquer forma no envio (qtdeFisicaOmie(qtdePortal()));
  -- antecipar faz o comprador aprovar o que será comprado. Fórmula espelho do helper qtde-portal.ts:
  --   trim_scale(round(GREATEST(1, ceil(round(q × fator, 6))) / fator, 6))   -- trim_scale: grava 40, não 40.000000
  -- GREATEST(1, …) = o max(1, …) de qtdePortal: necessidade > 0 nunca vira ZERO embalagens (fator minúsculo faria
  -- round(q×f,6)=0 → ceil 0 → a linha sumiria do pedido em silêncio — Codex P1-5). Domínio: 1/fator tem de ser
  -- inteiro em unidades Omie (0,2 → 5 L); com 1/3,6 o resultado 3,6 L seria integerizado depois e a edge leria
  -- 4 L como 2 galões (7,2 L) — só cadastre fator cujo inverso é inteiro.
  -- round6 ANTES do ceil: 36 × (1/3,6) em numeric = 10,000000000000000000008 → ceil 11 = um galão a mais,
  -- sem desfazer. round6 DEPOIS: 3 ÷ 0,3333333333333333 = 9,0000000000000009 → 9 (paridade com o TS).
  -- qtde_sem_teto recebe a MESMA conversão: capada ⇔ qtde_final < qtde_sem_teto compara na MESMA unidade
  -- (cap 27 L→30 L vs 36 L→40 L segue capada; cap 36→40 vs 38→40 deixa de sê-lo porque FISICAMENTE são os
  -- mesmos 8 baldes — o cap não mudou a compra). Linha capada a ZERO fica 0 (o CASE exige > 0).
  -- qtde_sugerida NÃO muda (rastro em embalagens da âncora; a tela mostra "36 → 40" com a causa certa via fator_embalagem_portal).
  -- [COMPRA SUSPENSA] decisão humana registrada em reposicao_compra_suspensa (spec 2026-10-31-reposicao-compra-suspensa):
  -- ATIVA = reativado_em IS NULL (não vence sozinha; revisar_em é data de REVISÃO, não de liberação — Codex P1).
  -- Lida UMA vez por run; a linha é segurada quando o SKU FINAL (âncora ou galão escolhido) OU a ÂNCORA do grupo
  -- está suspensa — COALESCE(âncora, final) dá UM id por linha (sem duplicar o log). Fica em skus_necessitando para
  -- que o log da compra evitada receba a MESMA qtde_final que iria ao pedido (pós-teto, pós-embalagem do portal).
  suspensas_ativas AS (
    SELECT cs.id, cs.sku_codigo_omie::text AS sku
    FROM public.reposicao_compra_suspensa cs
    WHERE cs.empresa = p_empresa AND cs.reativado_em IS NULL
  ),
  skus_necessitando AS (
    SELECT sd.empresa, sd.sku_codigo_omie, sd.sku_descricao, sd.fornecedor_nome, sd.grupo_codigo,
           sd.ponto_pedido, sd.estoque_maximo, sd.estoque_fisico, sd.estoque_a_caminho, sd.estoque_efetivo, sd.estoque_comprometido,
           sd.qtde_sugerida,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_final * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_final END AS qtde_final,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_sem_teto > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_sem_teto * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_sem_teto END AS qtde_sem_teto,
           sd.cap_teto_ancora, sd.teto_dias_linha, sd.demanda_diaria_linha, sd.classe_abc_efetiva,
           sd.preco_unitario, sd.primeira_compra, sd.horario_corte_pedido, sd.valor_maximo_mensal, sd.delta_max_perc,
           sd.suprimido, sd.motivo, sd.linha_fonte_sync,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0 THEN sd.fator_embalagem ELSE NULL END
             AS fator_embalagem_portal,
           sd.ancora_sku, sd.equiv_grupo,
           COALESCE(sa_anc.id, sa_fin.id) AS compra_suspensa_id   -- [COMPRA SUSPENSA] NULL = linha livre
    FROM skus_decididos sd
    LEFT JOIN suspensas_ativas sa_anc ON sa_anc.sku = sd.ancora_sku
    LEFT JOIN suspensas_ativas sa_fin ON sa_fin.sku = sd.sku_codigo_omie
  ),
  -- [GATE estoque-não-confirmado] LOG dos suprimidos ANTES de inserir o pedido — senão vira subcompra silenciosa.
  log_ins AS (
    INSERT INTO public.reposicao_estoque_nao_confirmado_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, motivo, estoque_efetivo, ponto_pedido, fonte_sync)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.motivo,
           sn.estoque_efetivo, sn.ponto_pedido, sn.linha_fonte_sync
    FROM skus_necessitando sn
    WHERE sn.suprimido AND sn.qtde_sugerida > 0
    RETURNING 1
  ),
  -- [TETO cobertura] LOG de toda linha REDUZIDA pelo cap (parcial ou a zero) — capado_zero sai do pedido, e sem
  -- este rastro seria subcompra silenciosa (mesma lição do gate acima). Suprimido NÃO loga aqui (o gate de
  -- estoque já cobre; estoque declarado não-confiável não sustenta um 2º diagnóstico — Codex P2).
  log_teto_ins AS (
    INSERT INTO public.reposicao_teto_cobertura_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, classe_abc, teto_dias, demanda_diaria,
       estoque_efetivo, ponto_pedido, estoque_maximo, cap_teto_ancora, qtde_sem_teto, qtde_final, motivo)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.classe_abc_efetiva,
           sn.teto_dias_linha, sn.demanda_diaria_linha, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
           sn.cap_teto_ancora, sn.qtde_sem_teto, sn.qtde_final,
           CASE WHEN sn.qtde_final <= 0 THEN 'capado_zero' ELSE 'capado_parcial' END
    FROM skus_necessitando sn
    WHERE NOT sn.suprimido AND sn.qtde_sugerida > 0 AND sn.qtde_final < sn.qtde_sem_teto
    RETURNING 1
  ),
  -- [COMPRA SUSPENSA] LOG da compra EVITADA: só a linha que SERIA inserida (passou gate, teto>0, qtde>0) e está
  -- suspensa — bloqueio anterior (gate/teto zero) NÃO conta como evitado pela suspensão (Codex P1). valor NULL
  -- quando o preço é NULL (ausente ≠ zero). É R$ de SUGESTÃO suprimida POR RUN, não caixa economizado.
  log_suspensa_ins AS (
    INSERT INTO public.reposicao_compra_suspensa_log
      (run_id, empresa, suspensa_id, sku_codigo_omie, ancora_sku, grupo_id, sku_descricao, fornecedor_nome,
       qtde_final, preco_unitario, valor_evitado)
    SELECT v_run_id, sn.empresa, sn.compra_suspensa_id, sn.sku_codigo_omie, sn.ancora_sku, sn.equiv_grupo,
           sn.sku_descricao, sn.fornecedor_nome, sn.qtde_final, sn.preco_unitario,
           CASE WHEN sn.preco_unitario IS NOT NULL THEN sn.qtde_final * sn.preco_unitario END
    FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0 AND sn.qtde_final > 0 AND NOT sn.suprimido AND sn.compra_suspensa_id IS NOT NULL
    RETURNING 1
  ),
  -- [TETO cobertura] Filtro ÚNICO dos dois INSERTs (Codex P0: divergência entre cabeçalho e item geraria pedido
  -- vazio ou item qtde 0). qtde_final>0 é novo: linha capada a zero fica só no log.
  -- [COMPRA SUSPENSA] compra_suspensa_id IS NULL: a linha suspensa fica só no log acima (mesmo filtro p/ cabeçalho e item).
  skus_inseriveis AS (
    SELECT * FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0 AND sn.qtde_final > 0 AND NOT sn.suprimido AND sn.compra_suspensa_id IS NULL
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           ((p_data_ciclo + MAX(sn.horario_corte_pedido)) AT TIME ZONE 'America/Sao_Paulo'),
           COALESCE(SUM(sn.qtde_final * sn.preco_unitario), 0), COUNT(*),   -- [PRECO-AUSENTE] valor_total é NOT NULL; item.valor_linha segue NULL (honesto)
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_inseriveis sn
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    estoque_fisico, estoque_a_caminho, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal,
    estoque_comprometido
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra,
         sn.estoque_fisico, sn.estoque_a_caminho, sn.qtde_sem_teto, (sn.qtde_final < sn.qtde_sem_teto),
         sn.fator_embalagem_portal, sn.estoque_comprometido
  FROM skus_inseriveis sn
  JOIN pedidos_por_fornecedor_grupo pfg
    -- [GRUPO-NULL] a MESMA partição do GROUP BY acima (que separa NULL de ''). COALESCE(...,'') fundia os
    -- dois: com um SKU de grupo NULL e outro de grupo '' no mesmo fornecedor, cada item casava com os 2
    -- cabeçalhos (4 itens / 16 un em vez de 2 / 8).
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  -- [FILA estoque-não-confirmado] carimba ESTE run (limpo OU com supressão) em reposicao_motor_run, p/ a fila da
  -- tela ancorar no ÚLTIMO recálculo — não no último recálculo QUE TEVE supressão. Um run limpo não grava no log de
  -- suprimidos → sem este marcador a mensagem "N fora da compra" grudava por até 24h após o sync já ter confirmado o
  -- estoque (Codex 2026-07-08: é bug de FONTE-DE-VERDADE, não de render). Aditivo, FORA dos CTEs de decisão; mesmo
  -- role/caminho do INSERT no log acima (authenticated já escreve lá, RLS INSERT WITH CHECK true) → NÃO aborta a compra.
  INSERT INTO public.reposicao_motor_run (run_id, empresa, data_ciclo, pedidos_gerados, skus_incluidos, suprimidos_n, capados_n,
                                          suspensas_compra_n)
  VALUES (v_run_id, p_empresa, p_data_ciclo, v_pedidos, v_skus,
          (SELECT count(*) FROM public.reposicao_estoque_nao_confirmado_log WHERE run_id = v_run_id),
          (SELECT count(*) FROM public.reposicao_teto_cobertura_log WHERE run_id = v_run_id),
          (SELECT count(*) FROM public.reposicao_compra_suspensa_log WHERE run_id = v_run_id));

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- ── [COMPRA SUSPENSA] o que o motor acima LÊ e ESCREVE — na cauda (depois do CREATE) porque a fonte viva
-- db/embalagem-motor-rpc.sql copia esta migration do CREATE do motor até o FIM (guard embalagem-motor-paridade) e
-- as provas irmãs a carregam como fixture: a cauda tem de ser autocontida (IF NOT EXISTS, idempotente).
-- Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md (§3). 1 writer: as RPCs
-- reposicao_compra_suspender/_reativar (SECURITY DEFINER, gate cap_compras_escrever) — a tabela NÃO tem policy de escrita.
CREATE TABLE IF NOT EXISTS public.reposicao_compra_suspensa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  motivo text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('ciclo_ui', 'lote_cobertura', 'envelope')),
  lote_id uuid,
  suspenso_por uuid,
  suspenso_por_texto text,
  suspenso_em timestamptz NOT NULL DEFAULT now(),
  revisar_em date NOT NULL,
  reativado_em timestamptz,
  reativado_por uuid,
  motivo_reativacao text,
  foto_saldo numeric,
  foto_cmc numeric,
  foto_valor numeric,
  foto_cobertura_dias numeric,
  foto_cobertura_90d_dias numeric,
  foto_no_motor boolean,
  foto_valor_vendido_90d numeric,
  criado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.reposicao_compra_suspensa IS
  'Decisão humana "segurar compra" por SKU. ATIVA = reativado_em IS NULL (não vence sozinha; revisar_em é data de revisão). O motor (gerar_pedidos_sugeridos_ciclo) segura a linha e loga a compra evitada. Escrita só pelas RPCs reposicao_compra_suspender/_reativar.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_reposicao_compra_suspensa_ativa
  ON public.reposicao_compra_suspensa (empresa, sku_codigo_omie) WHERE reativado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_reposicao_compra_suspensa_emp_lote ON public.reposicao_compra_suspensa (empresa, lote_id);
ALTER TABLE public.reposicao_compra_suspensa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reposicao_compra_suspensa FROM PUBLIC;
REVOKE ALL ON public.reposicao_compra_suspensa FROM anon;
REVOKE ALL ON public.reposicao_compra_suspensa FROM authenticated;
-- SELECT explícito: policy sem GRANT deixaria o motor INVOKER (botão "Recalcular" como staff) abortar em 42501 (Codex P1-8).
GRANT SELECT ON public.reposicao_compra_suspensa TO authenticated;
GRANT ALL ON public.reposicao_compra_suspensa TO service_role;
DROP POLICY IF EXISTS reposicao_compra_suspensa_sel ON public.reposicao_compra_suspensa;
CREATE POLICY reposicao_compra_suspensa_sel ON public.reposicao_compra_suspensa
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

-- Log da compra EVITADA por run (R$ de sugestão suprimida; NÃO é caixa economizado — a mesma necessidade reaparece a
-- cada run enquanto suspensa). Mesmo padrão de ACL do reposicao_teto_cobertura_log: SELECT e INSERT via cap_compras_ler
-- (quem completa a RPC já o tem; WITH CHECK true permitiria falsificar o audit).
CREATE TABLE IF NOT EXISTS public.reposicao_compra_suspensa_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL,
  suspensa_id uuid NOT NULL,
  sku_codigo_omie text NOT NULL,
  ancora_sku text,
  grupo_id uuid,
  sku_descricao text,
  fornecedor_nome text,
  qtde_final numeric NOT NULL,
  preco_unitario numeric,
  valor_evitado numeric
);
COMMENT ON TABLE public.reposicao_compra_suspensa_log IS
  'Linha do ciclo normal que SERIA comprada (passou gate e teto) e foi segurada por reposicao_compra_suspensa. valor_evitado NULL = preço ausente. Soma entre runs mede R$·run de sugestão suprimida, não caixa.';
CREATE INDEX IF NOT EXISTS idx_compra_suspensa_log_run ON public.reposicao_compra_suspensa_log (run_id);
CREATE INDEX IF NOT EXISTS idx_compra_suspensa_log_emp_data ON public.reposicao_compra_suspensa_log (empresa, criado_em DESC);
ALTER TABLE public.reposicao_compra_suspensa_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reposicao_compra_suspensa_log FROM PUBLIC;
REVOKE ALL ON public.reposicao_compra_suspensa_log FROM anon;
REVOKE ALL ON public.reposicao_compra_suspensa_log FROM authenticated;
GRANT SELECT, INSERT ON public.reposicao_compra_suspensa_log TO authenticated;
GRANT ALL ON public.reposicao_compra_suspensa_log TO service_role;
DROP POLICY IF EXISTS compra_suspensa_log_sel ON public.reposicao_compra_suspensa_log;
CREATE POLICY compra_suspensa_log_sel ON public.reposicao_compra_suspensa_log
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
DROP POLICY IF EXISTS compra_suspensa_log_ins ON public.reposicao_compra_suspensa_log;
CREATE POLICY compra_suspensa_log_ins ON public.reposicao_compra_suspensa_log
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

-- O que o motor já exigia nas caudas anteriores e continua exigindo (20261010210000: rastro do desconto do vendido em
-- pedido aberto e a coluna de sales_orders que o INVOKER lê como staff). Idempotente; fica aqui porque a cauda é a
-- ÚNICA fonte das provas irmãs (sem isto, test-embalagem/gate/teto/em-transito quebram no INSERT do item).
ALTER TABLE public.pedido_compra_item ADD COLUMN IF NOT EXISTS estoque_comprometido numeric;
GRANT SELECT (omie_reconciliado_em) ON public.sales_orders TO authenticated;
ALTER TABLE public.reposicao_motor_run ADD COLUMN IF NOT EXISTS suspensas_compra_n integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.reposicao_motor_run.suspensas_compra_n IS
  'Linhas do run seguradas por reposicao_compra_suspensa (= count em reposicao_compra_suspensa_log do run).';

-- PÓS, autocontida (vale na migration inteira e na fixture carregada pelas provas): o motor instalado é ESTE
-- (lê a suspensão e escreve o log), os atributos não mudaram, e o que ele lê/escreve existe com RLS.
DO $pos$
DECLARE
  v_oid oid := to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)');
  v_src text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS-M1 FALHOU: gerar_pedidos_sugeridos_ciclo não existe — o motor e o Cockpit quebrariam';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  -- (o marker suspensas_compra_n NÃO entra aqui: a prova irmã do gate sabota o INSERT do marker e recarrega a fixture)
  IF position('compra_suspensa_id IS NULL' IN v_src) = 0
     OR position('reposicao_compra_suspensa_log' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS-CS1 FALHOU: o motor instalado não lê a suspensão de compra (corpo sem compra_suspensa_id / log)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_oid AND p.provolatile = 'v' AND NOT p.prosecdef
                    AND array_to_string(p.proconfig, ';') = 'search_path=public, pg_temp;statement_timeout=120s'
                    AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
    RAISE EXCEPTION 'POS-M4 FALHOU: o motor mudou de atributo — esperado VOLATILE, INVOKER, config [search_path=public, pg_temp;statement_timeout=120s], dono postgres';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.reposicao_compra_suspensa'::regclass)
     OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.reposicao_compra_suspensa_log'::regclass) THEN
    RAISE EXCEPTION 'POS-CS2 FALHOU: tabela da suspensão sem RLS';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.reposicao_compra_suspensa'::regclass) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.reposicao_compra_suspensa_log'::regclass) <> 2 THEN
    RAISE EXCEPTION 'POS-CS3 FALHOU: policies da suspensão divergem (esperado 1 SELECT na decisão; SELECT+INSERT no log)';
  END IF;
  IF has_table_privilege('authenticated', 'public.reposicao_compra_suspensa', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reposicao_compra_suspensa', 'UPDATE')
     OR has_table_privilege('anon', 'public.reposicao_compra_suspensa', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.reposicao_compra_suspensa', 'SELECT') THEN
    RAISE EXCEPTION 'POS-CS4 FALHOU: ACL da decisão (authenticated só SELECT; anon nada)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = 'public.reposicao_motor_run'::regclass AND a.attname = 'suspensas_compra_n' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'POS-CS5 FALHOU: reposicao_motor_run.suspensas_compra_n ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'uq_reposicao_compra_suspensa_ativa' AND i.indisunique AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'POS-CS6 FALHOU: índice único parcial da suspensão ativa ausente';
  END IF;
  RAISE NOTICE 'COMPRA-SUSPENSA-MOTOR-OK';
END
$pos$;
