-- ============================================================================================
-- Venda por cliente — Task 9: ONDAS 2 (complemento) e 3 (preço) no gerador e na lista da farmer
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §6, §7 Fases 3–5, §8 (ondas)
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md, Task 9
-- Prova PG17: db/test-venda-ondas23.sh (os dois locales + --falsificar)
-- Depende de (já em prod): 20261020174221 espinha · 20261020181743 gerador · 20261020194332 prova por
-- dados · 20261020143511 complemento (núcleo _mixgap_gaps_compradores) · 20261020233000 repasse
-- (venda_repasse_aprovado, _venda_repasse_base, _venda_repasse_sku_ok, regua_num_finito).
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO leva
-- BEGIN/COMMIT. Idempotente. Recria objetos VIVOS no molde TRAVA → PRE → CREATE → PÓS. Nenhuma escrita
-- em venda_config: a liberação das ondas continua só com venda_avaliar_ondas (Task 4).
--
-- Decisões (registradas no PR):
--  • A Onda 1 não muda: a inserção de `recompra` e o registro da rodada são os mesmos bytes da Task 4,
--    e venda_avaliar_ondas/venda_lista_calc não são tocadas (a comparação olha só tipo='recompra').
--  • `complemento` e `preco` só entram na lista ATIVA de HOJE (SP): o núcleo do Mix/Gap e o último preço
--    ao vivo leem now(), então gerar para outro dia olharia o futuro. Sombra e histórico ficam só com
--    recompra (são a linha de base da Onda 1). Os compradores são os da lista de recompra do dia — a
--    ficha é aberta para eles; nenhuma onda acrescenta comprador à lista.
--  • As duas consultas vivem em funções LANGUAGE sql privadas: o corpo é validado no CREATE (coluna ou
--    assinatura errada de um helper falha AQUI, no apply, e não às 05:15 no cron) e a PÓS as executa.
--  • Complemento: mesma régua da ficha (venda_complemento_comprador, 20261020143511): até 3 famílias por
--    comprador por confidence × lift, desempate evidence_count e família; a empresa da família é a da
--    linha mais forte do gap; feedback que suprime = o do dono (a farmer). Repetir a rodada no mesmo dia
--    não acrescenta família a quem já tem (o feedback pode ter mudado no meio).
--  • Preço: mesmo predicado da ficha (venda_preco_alvo_comprador, 20261020233000): repasse não revogado e
--    válido hoje, SKU Oben não-tinta, último preço AO VIVO provado e ABAIXO do alvo, grupo canônico com
--    dono único. Colacor e tinta nunca geram linha `preco`.
--  • Desfecho de `preco` (achado P2 do Codex na Task 6): "≥ alvo × 0,99" sozinho deixava o preço VELHO
--    contar como sucesso quando o alvo está a menos de 1% acima dele. A sugestão passa a guardar
--    `preco_anterior` = maior entre o último preço na aprovação e o último ao vivo ao gerar; o PEDIDO só
--    qualifica com preço líquido ≥ alvo × 0,99 E > preco_anterior (precisão > recall). O preço do pedido
--    é a média ponderada do SKU no pedido, sem as linhas de líquido 0 (bonificação) — a MESMA unidade do
--    último preço da base (média ponderada do dia): comparar item isolado com média deixava 90 + 110
--    "subir" sobre 100 (Codex desenho P2). Bruto médio ≤ anterior já reprova (desconto só abaixa);
--    líquido não apurado segue nao_medivel.
--  • `complemento` e `preco` só entram na medida se a farmer os VIU (`mostrada_em`; spec §7: a linha
--    existe "quando mostrada"). Nunca exibida → nao_medivel/nao_exibida, com ou sem pedido (simétrico:
--    contar só o sucesso do que não foi visto inflaria a taxa). Recompra segue como na Task 1.
--  • venda_minhas_sugestoes passa a expor `ondas` (liga/desliga do servidor) e `cadencia_dias` por SKU
--    de recompra; total e motivo do comprador contam só `recompra` (complemento/preço não têm valor de
--    referência e zerariam o total — ausente ≠ zero vale para o agregado também).
-- ============================================================================================

-- ── 1. TRAVA (antes de ler): ALTER sem efeito (a volatilidade VIVA) em cada função recriada ───
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_gerar_lista(date,text)') IS NULL
     OR to_regprocedure('public.venda_minhas_sugestoes(date)') IS NULL
     OR to_regprocedure('public.venda_fechar_desfechos(date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: gerador/espinha ausentes — aplique 20261020174221, 20261020181743 e 20261020194332 antes';
  END IF;
  ALTER FUNCTION public.venda_gerar_lista(date, text) VOLATILE;
  ALTER FUNCTION public.venda_minhas_sugestoes(date) STABLE;
  ALTER FUNCTION public.venda_fechar_desfechos(date) VOLATILE;
END
$trava$;

-- ── 2. PRE: corpo vivo ∈ {predecessor revisado (prod 2026-10-20), este}; dependências presentes ─
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_gerar_lista(date,text)',   '0548cd63c19a2f87db94ada259f7657f', '5abe897dbcaaf3b70351da896e35b566'),
        ('public.venda_minhas_sugestoes(date)',   '75f7d766c2989ee97813b53942a278f1', 'e38baeb57b7e19c815e45baa77a23810'),
        ('public.venda_fechar_desfechos(date)',   'd187360234689981761b1cdfac225b2e', '6c962e84f9b821d5612b555e10489616')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;

  -- Os helpers que as funções novas consomem (Tasks 5 e 6), na assinatura exata.
  IF to_regprocedure('private._mixgap_gaps_compradores(uuid[],uuid[])') IS NULL
     OR to_regprocedure('private._venda_repasse_base(uuid)') IS NULL
     OR to_regprocedure('private._venda_repasse_sku_ok(bigint)') IS NULL
     OR to_regprocedure('private.regua_num_finito(numeric)') IS NULL
     OR to_regclass('public.venda_repasse_aprovado') IS NULL
     OR to_regclass('public.venda_recompra') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: helpers do complemento/repasse ausentes — aplique 20261020143511 e 20261020233000 antes';
  END IF;
END
$pre$;

-- ── 3. A sugestão de preço guarda o preço que o pedido tem de SUPERAR ─────────────────────────
ALTER TABLE public.venda_sugestao ADD COLUMN IF NOT EXISTS preco_anterior numeric;

DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.venda_sugestao'::regclass
                    AND conname = 'venda_sugestao_preco_anterior_ck') THEN
    ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_preco_anterior_ck CHECK (
      ((tipo = 'preco') = (preco_anterior IS NOT NULL))
      AND (preco_anterior IS NULL OR (preco_anterior > 0 AND preco_anterior < preco_alvo)));
  END IF;
END
$ck$;

COMMENT ON COLUMN public.venda_sugestao.preco_anterior IS
  'Só tipo=preco: maior entre o último preço na aprovação do repasse e o último ao vivo ao gerar. '
  'O desfecho exige preço líquido > preco_anterior além de ≥ preco_alvo × 0,99 (Task 9).';

-- ── 4. Complemento do dia: até 3 famílias por comprador da lista ATIVA de recompra ────────────
CREATE OR REPLACE FUNCTION private.venda_lista_complemento(p_dia date)
RETURNS TABLE (
  farmer_user_id uuid,
  comprador_id   uuid,
  empresa        text,
  familia        text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH lista AS (
    SELECT DISTINCT s.farmer_user_id, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.dia_referencia = p_dia AND s.fase = 'ativa' AND s.tipo = 'recompra'
  ),
  por_farmer AS (
    SELECT l.farmer_user_id, array_agg(l.comprador_id ORDER BY l.comprador_id) AS compradores
      FROM lista l GROUP BY l.farmer_user_id
  ),
  -- Núcleo do Mix/Gap por farmer: o feedback que suprime é o DELA (como na ficha).
  g AS (
    SELECT pf.farmer_user_id, x.customer_user_id AS comprador_id, x.familia, x.empresa,
           x.confidence, x.lift, x.evidence_count
      FROM por_farmer pf
     CROSS JOIN LATERAL private._mixgap_gaps_compradores(pf.compradores, ARRAY[pf.farmer_user_id]) x
  ),
  fam AS (
    SELECT g.farmer_user_id, g.comprador_id, g.familia,
           max(g.confidence) AS confidence, max(g.lift) AS lift, sum(g.evidence_count) AS evidence_count
      FROM g GROUP BY g.farmer_user_id, g.comprador_id, g.familia
  ),
  top3 AS (
    SELECT f.*, row_number() OVER (PARTITION BY f.farmer_user_id, f.comprador_id
                                   ORDER BY (f.confidence * f.lift) DESC, f.evidence_count DESC, f.familia) AS rn
      FROM fam f
  ),
  emp AS (
    SELECT DISTINCT ON (g.farmer_user_id, g.comprador_id, g.familia)
           g.farmer_user_id, g.comprador_id, g.familia, g.empresa
      FROM g
     ORDER BY g.farmer_user_id, g.comprador_id, g.familia,
              (g.confidence * g.lift) DESC, g.evidence_count DESC, g.empresa
  )
  SELECT t.farmer_user_id, t.comprador_id, e.empresa, t.familia
    FROM top3 t
    JOIN emp e ON e.farmer_user_id = t.farmer_user_id AND e.comprador_id = t.comprador_id
              AND e.familia = t.familia
   WHERE t.rn <= 3
     AND e.empresa IN ('oben','colacor','colacor_sc')
$fn$;
REVOKE ALL ON FUNCTION private.venda_lista_complemento(date) FROM PUBLIC, anon, authenticated;

-- ── 5. Preço do dia: repasse aprovado VIGENTE de comprador da lista ATIVA de recompra ─────────
CREATE OR REPLACE FUNCTION private.venda_lista_preco(p_dia date)
RETURNS TABLE (
  farmer_user_id      uuid,
  comprador_id        uuid,
  omie_codigo_produto bigint,
  preco_alvo          numeric,
  preco_anterior      numeric
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH lista AS (
    SELECT DISTINCT s.farmer_user_id, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.dia_referencia = p_dia AND s.fase = 'ativa' AND s.tipo = 'recompra'
  ),
  rep AS (
    SELECT l.farmer_user_id, ra.comprador_id, ra.omie_codigo_produto, ra.preco_alvo,
           ra.ultimo_preco_na_aprovacao
      FROM lista l
      JOIN public.venda_repasse_aprovado ra ON ra.comprador_id = l.comprador_id
     WHERE ra.empresa = 'oben'
       AND ra.revogado_em IS NULL
       AND ra.valido_ate >= p_dia
       AND private._venda_repasse_sku_ok(ra.omie_codigo_produto)
  ),
  -- Dono ÚNICO das atribuições elegíveis do grupo canônico, e é a farmer da linha (o gate da ficha
  -- nega 2+ donos e nega quem não é o dono — carteira transferida no meio do dia, Codex P2).
  dono AS (
    SELECT c.comprador_id, count(DISTINCT ca.owner_user_id) AS n,
           (array_agg(DISTINCT ca.owner_user_id))[1] AS dono
      FROM (SELECT DISTINCT r.comprador_id FROM rep r) c
      JOIN public.carteira_assignments ca
        ON ca.eligible = true AND ca.owner_user_id IS NOT NULL
       AND (ca.customer_user_id = c.comprador_id
            OR ca.customer_user_id IN (SELECT a.alias_user_id FROM public.customer_canonical_alias a
                                        WHERE a.canonical_user_id = c.comprador_id AND a.status = 'active'))
     GROUP BY c.comprador_id
  ),
  base AS (
    SELECT b.comprador_id, b.omie_codigo_produto, b.ultimo_preco
      FROM (SELECT DISTINCT r.comprador_id FROM rep r) c
     CROSS JOIN LATERAL private._venda_repasse_base(c.comprador_id) b
  )
  SELECT r.farmer_user_id, r.comprador_id, r.omie_codigo_produto, r.preco_alvo,
         GREATEST(r.ultimo_preco_na_aprovacao, b.ultimo_preco)
    FROM rep r
    JOIN dono d ON d.comprador_id = r.comprador_id AND d.n = 1 AND d.dono = r.farmer_user_id
    JOIN base b ON b.comprador_id = r.comprador_id AND b.omie_codigo_produto = r.omie_codigo_produto
   WHERE private.regua_num_finito(b.ultimo_preco)
     AND b.ultimo_preco > 0
     AND b.ultimo_preco < r.preco_alvo
$fn$;
REVOKE ALL ON FUNCTION private.venda_lista_preco(date) FROM PUBLIC, anon, authenticated;

-- ── 6. Gerador: recompra como antes; complemento e preço quando a onda está ligada ───────────
CREATE OR REPLACE FUNCTION public.venda_gerar_lista(p_dia date, p_fase text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_n     integer;
  v_k     integer;
  v_total integer;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_gerar_lista: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  IF p_fase IS NULL OR p_fase NOT IN ('historico','sombra','ativa') THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase invalida' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'historico' AND p_dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'venda_gerar_lista: historico so para dia passado' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'ativa' AND NOT EXISTS (SELECT 1 FROM public.venda_config
                                       WHERE chave = 'onda_recompra' AND valor = 'true'::jsonb) THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase ativa com onda_recompra desligada' USING ERRCODE = '22023';
  END IF;

  -- Uma rodada por vez (cron + reconstrução manual).
  PERFORM pg_advisory_xact_lock(hashtext('venda_gerar_lista'));

  INSERT INTO public.venda_sugestao
         (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
          qtd_ref, valor_ref, motivo_entrada)
  SELECT 'recompra', p_fase, p_dia, l.farmer_user_id, l.comprador_id, l.empresa, l.omie_codigo_produto,
         l.qtd_ref, l.valor_ref, l.motivo_entrada
    FROM private.venda_lista_calc(p_dia) l
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_total
    FROM public.venda_sugestao
   WHERE dia_referencia = p_dia AND fase = p_fase AND tipo = 'recompra';

  INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas)
  VALUES (p_dia, p_fase, v_total)
  ON CONFLICT (dia_referencia, fase)
  DO UPDATE SET ultima_em = now(), linhas = EXCLUDED.linhas;

  -- Ondas 2 e 3: só na lista ATIVA de hoje (núcleo do Mix/Gap e último preço ao vivo leem now()).
  IF p_fase = 'ativa' AND p_dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_complemento' AND valor = 'true'::jsonb) THEN
      INSERT INTO public.venda_sugestao
             (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, familia, motivo_entrada)
      SELECT 'complemento', p_fase, p_dia, c.farmer_user_id, c.comprador_id, c.empresa, c.familia,
             'clientes parecidos compram'
        FROM private.venda_lista_complemento(p_dia) c
       WHERE NOT EXISTS (SELECT 1 FROM public.venda_sugestao s
                          WHERE s.dia_referencia = p_dia AND s.fase = p_fase AND s.tipo = 'complemento'
                            AND s.farmer_user_id = c.farmer_user_id AND s.comprador_id = c.comprador_id)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END IF;

    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_preco' AND valor = 'true'::jsonb) THEN
      INSERT INTO public.venda_sugestao
             (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
              preco_alvo, preco_anterior, motivo_entrada)
      SELECT 'preco', p_fase, p_dia, p.farmer_user_id, p.comprador_id, 'oben', p.omie_codigo_produto,
             p.preco_alvo, p.preco_anterior, 'repasse aprovado'
        FROM private.venda_lista_preco(p_dia) p
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END IF;
  END IF;

  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.venda_gerar_lista(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_gerar_lista(date, text) TO service_role;

-- ── 7. Lista da farmer: + ondas, + cadência; total e motivo só da recompra ────────────────────
CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ondas jsonb;
  v_out   jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: p_dia NULL' USING ERRCODE = '22023';
  END IF;

  -- Liga/desliga do servidor (vale para o aparelho da farmer). Chave ausente = desligada.
  SELECT jsonb_build_object(
           'recompra',    COALESCE(bool_or(c.chave = 'onda_recompra'    AND c.valor = 'true'::jsonb), false),
           'complemento', COALESCE(bool_or(c.chave = 'onda_complemento' AND c.valor = 'true'::jsonb), false),
           'preco',       COALESCE(bool_or(c.chave = 'onda_preco'       AND c.valor = 'true'::jsonb), false))
    INTO v_ondas
    FROM public.venda_config c;

  WITH s AS (
    SELECT s.*, op.descricao, round(vr.cadencia_dias)::int AS cadencia_dias
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
      LEFT JOIN public.venda_recompra vr
             ON s.tipo = 'recompra' AND vr.comprador_id = s.comprador_id
            AND vr.empresa = s.empresa AND vr.omie_codigo_produto = s.omie_codigo_produto
     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = v_uid
       AND s.dia_referencia = p_dia
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões de recompra têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN sum(s.valor_ref) FILTER (WHERE s.tipo = 'recompra') END AS valor_ref_total,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo, 'cadencia_dias', s.cadencia_dias)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'ondas', v_ondas,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_minhas_sugestoes(date) TO authenticated, service_role;

-- ── 8. Desfecho: o preço só "virou" se SUPEROU o anterior (além de bater o alvo) ──────────────
CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos(p_hoje date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_janela jsonb;
  v_n      integer;
BEGIN
  IF p_hoje IS NULL THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: p_hoje NULL' USING ERRCODE = '22023';
  END IF;

  SELECT valor INTO v_janela FROM public.venda_config WHERE chave = 'janela_dias';
  IF jsonb_typeof(v_janela -> 'recompra') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'complemento') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'preco') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: venda_config.janela_dias ausente ou incompleta' USING ERRCODE = '22023';
  END IF;

  -- Um fechamento por vez (cron + chamada manual da reconstrução histórica).
  PERFORM pg_advisory_xact_lock(hashtext('venda_fechar_desfechos'));

  WITH jan(tipo, dias) AS (
    VALUES ('recompra',    (v_janela ->> 'recompra')::int),
           ('complemento', (v_janela ->> 'complemento')::int),
           ('preco',       (v_janela ->> 'preco')::int)
  ),
  alvo AS (
    SELECT s.id, s.tipo, s.empresa, s.fase,
           COALESCE(ca.canonical_user_id, s.comprador_id) AS comprador,
           s.omie_codigo_produto, s.familia, s.preco_alvo, s.preco_anterior, s.mostrada_em,
           s.dia_referencia AS de,
           s.dia_referencia + j.dias AS ate                  -- exclusivo
      FROM public.venda_sugestao s
      JOIN jan j ON j.tipo = s.tipo
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = s.comprador_id AND ca.status = 'active'
     WHERE s.desfecho IS NULL
       AND s.dia_referencia + j.dias <= p_hoje
  ),
  pedido AS (
    -- Universo de venda de src/lib/farmer/universo-pedidos.ts (denylist; NULL não passa).
    SELECT so.id, so.account,
           COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido
      FROM public.sales_orders so
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
  ),
  item AS (
    SELECT a.id AS sug_id, a.tipo, a.preco_alvo, a.preco_anterior, p.id AS so_id, p.data_pedido,
           oi.quantity                                                             AS qtd,
           oi.quantity * oi.unit_price - oi.desconto_valor                          AS valor_liq,
           (oi.quantity * oi.unit_price - oi.desconto_valor) / NULLIF(oi.quantity, 0) AS preco_liq,
           oi.unit_price                                                           AS preco_bruto
      FROM alvo a
      JOIN pedido p
        ON p.comprador = a.comprador
       AND p.account = a.empresa
       AND p.data_pedido >= a.de
       AND p.data_pedido <  a.ate
      JOIN public.order_items oi ON oi.sales_order_id = p.id
     WHERE (a.tipo IN ('recompra','preco') AND oi.omie_codigo_produto = a.omie_codigo_produto)
        OR (a.tipo = 'complemento' AND EXISTS (
              SELECT 1 FROM public.omie_products op
               WHERE op.omie_codigo_produto = oi.omie_codigo_produto
                 AND op.account = p.account
                 AND op.familia = a.familia))
  ),
  -- Preço: o PEDIDO é a unidade (média ponderada do SKU no pedido, sem bonificação de líquido 0).
  pedido_preco AS (
    SELECT i.sug_id, i.so_id, i.data_pedido, min(i.preco_alvo) AS preco_alvo, min(i.preco_anterior) AS preco_anterior,
           CASE WHEN bool_and(i.valor_liq IS NOT NULL) THEN sum(i.valor_liq) END            AS valor_liq,
           bool_and(i.valor_liq IS NOT NULL)                                                AS liq_apurado,
           sum(i.valor_liq) FILTER (WHERE i.preco_liq > 0)
             / NULLIF(sum(i.qtd) FILTER (WHERE i.preco_liq > 0), 0)                         AS preco_medio_liq,
           sum(i.qtd * i.preco_bruto) / NULLIF(sum(i.qtd), 0)                               AS preco_medio_bruto
      FROM item i
     WHERE i.tipo = 'preco'
     GROUP BY i.sug_id, i.so_id, i.data_pedido
  ),
  item_q AS (
    SELECT i.sug_id, i.so_id, i.data_pedido, i.valor_liq, true AS qualifica
      FROM item i
     WHERE i.tipo <> 'preco'
    UNION ALL
    SELECT pp.sug_id, pp.so_id, pp.data_pedido, pp.valor_liq,
           -- preco_anterior NULL (impossível pelo CHECK) cai em NULL = indeterminado, nunca "virou"
           CASE WHEN pp.liq_apurado THEN COALESCE(pp.preco_medio_liq >= pp.preco_alvo * 0.99
                                                  AND pp.preco_medio_liq > pp.preco_anterior, false)
                WHEN pp.preco_medio_bruto < pp.preco_alvo * 0.99
                  OR pp.preco_medio_bruto <= pp.preco_anterior THEN false   -- desconto só abaixa
                ELSE NULL                                                  -- desconto não apurado
           END
      FROM pedido_preco pp
  ),
  agg AS (
    SELECT sug_id,
           (array_agg(so_id ORDER BY data_pedido, so_id) FILTER (WHERE qualifica))[1] AS so_id,
           CASE WHEN bool_and(valor_liq IS NOT NULL) FILTER (WHERE qualifica)
                THEN sum(valor_liq) FILTER (WHERE qualifica) END                     AS valor,
           bool_or(qualifica IS NULL)                                                AS indeterminado
      FROM item_q
     GROUP BY sug_id
  ),
  faixa AS (
    SELECT empresa, min(de) AS de, max(ate) AS ate FROM alvo GROUP BY empresa
  ),
  descoberto AS (
    SELECT f.empresa, g.d::date AS dia
      FROM faixa f
      CROSS JOIN LATERAL generate_series(f.de, f.ate - 1, interval '1 day') AS g(d)
     WHERE NOT private.venda_sync_dia_coberto(f.empresa, g.d::date)
  ),
  -- Linha de base (fase='historico'): dia sem heartbeat/cursor ainda conta como coberto se o MÊS passar na
  -- prova por dados (private.venda_mes_completo_por_dados). Só os dias de mês reprovado seguem descobertos.
  mes_descoberto AS (
    SELECT DISTINCT x.empresa, date_trunc('month', x.dia)::date AS mes FROM descoberto x
  ),
  mes_reprovado AS (
    SELECT m.empresa, m.mes FROM mes_descoberto m
     WHERE NOT private.venda_mes_completo_por_dados(m.empresa, m.mes)
  ),
  descoberto_hist AS (
    SELECT x.empresa, x.dia
      FROM descoberto x
      JOIN mes_reprovado r ON r.empresa = x.empresa AND r.mes = date_trunc('month', x.dia)::date
  ),
  decisao AS (
    SELECT a.id, g.so_id, g.valor,
           CASE
             WHEN a.tipo <> 'recompra' AND a.mostrada_em IS NULL THEN 'nao_medivel'   -- a farmer não viu
             WHEN g.so_id IS NOT NULL THEN 'virou_pedido'
             WHEN g.indeterminado     THEN 'nao_medivel'
             WHEN a.fase = 'historico' THEN
               CASE
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                                 AND x.dia + 5 < p_hoje)       THEN 'nao_medivel'
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
                 ELSE 'nao_virou'
               END
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                             AND x.dia + 5 < p_hoje)           THEN 'nao_medivel'
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
             ELSE 'nao_virou'
           END AS desfecho,
           CASE
             WHEN a.tipo <> 'recompra' AND a.mostrada_em IS NULL THEN 'nao_exibida'
             WHEN g.so_id IS NOT NULL THEN NULL
             WHEN g.indeterminado     THEN 'desconto_nao_apurado'
             WHEN a.fase = 'historico' THEN 'historico_incompleto'
             ELSE 'sync_atrasado'
           END AS motivo
      FROM alvo a
      LEFT JOIN agg g ON g.sug_id = a.id
  )
  UPDATE public.venda_sugestao s
     SET desfecho        = d.desfecho,
         desfecho_motivo = CASE WHEN d.desfecho = 'nao_medivel' THEN d.motivo END,
         sales_order_id  = CASE WHEN d.desfecho = 'virou_pedido' THEN d.so_id END,
         valor_realizado = CASE WHEN d.desfecho = 'virou_pedido' THEN d.valor END,
         avaliado_em     = now()
    FROM decisao d
   WHERE d.id = s.id
     AND d.desfecho IS NOT NULL
     AND s.desfecho IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.venda_fechar_desfechos(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_fechar_desfechos(date) TO service_role;

-- ── 9. PÓS: aborta o apply se qualquer peça não pegou ────────────────────────────────────────
DO $post$
DECLARE
  r     record;
  f     text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_n   bigint;
  v_j   jsonb;
BEGIN
  -- P1 corpos = os deste arquivo
  FOR r IN
    SELECT x.alvo, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_gerar_lista(date,text)',   '5abe897dbcaaf3b70351da896e35b566'),
        ('public.venda_minhas_sugestoes(date)',   'e38baeb57b7e19c815e45baa77a23810'),
        ('public.venda_fechar_desfechos(date)',   '6c962e84f9b821d5612b555e10489616')
      ) AS x(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', r.alvo, r.vivo;
    END IF;
  END LOOP;

  -- P2 ACL: gerador, desfecho e as duas listas privadas fechados a anon/PUBLIC/authenticated
  FOREACH f IN ARRAY ARRAY['public.venda_gerar_lista(date,text)','public.venda_fechar_desfechos(date)',
                           'private.venda_lista_complemento(date)','private.venda_lista_preco(date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P2 FALHOU: % executavel por anon/PUBLIC/authenticated', f;
    END IF;
  END LOOP;
  -- RPC da farmer: aberta só a authenticated (duas pontas fechadas)
  IF has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
     OR has_function_privilege('public', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de venda_minhas_sugestoes (anon/PUBLIC sem, authenticated com)';
  END IF;

  -- P3 SECURITY DEFINER + search_path fixo nas 3 públicas; as privadas NÃO são definer
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('venda_gerar_lista','venda_minhas_sugestoes','venda_fechar_desfechos')
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 3 THEN
    RAISE EXCEPTION 'P3 FALHOU: funcoes publicas sem SECURITY DEFINER/search_path fixo (ou sobrecarga extra)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE prosecdef
              AND oid IN ('private.venda_lista_complemento(date)'::regprocedure,
                          'private.venda_lista_preco(date)'::regprocedure)) THEN
    RAISE EXCEPTION 'P3 FALHOU: lista privada nao deveria ser SECURITY DEFINER';
  END IF;

  -- P4 coluna e CHECK do preço anterior (validado: as linhas existentes não são tipo=preco)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.venda_sugestao'::regclass
                    AND conname = 'venda_sugestao_preco_anterior_ck' AND convalidated) THEN
    RAISE EXCEPTION 'P4 FALHOU: venda_sugestao_preco_anterior_ck ausente ou NOT VALID';
  END IF;

  -- P5 as consultas novas EXECUTAM contra o banco real (late binding dos helpers)
  SELECT count(*) INTO v_n FROM private.venda_lista_complemento(v_hoje);
  SELECT count(*) INTO v_n FROM private.venda_lista_preco(v_hoje);

  -- P6 a RPC da farmer executa e expõe as 3 ondas como booleano (sessão fictícia, dentro da transação)
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  v_j := public.venda_minhas_sugestoes(v_hoje);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF jsonb_typeof(v_j -> 'ondas' -> 'recompra') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_j -> 'ondas' -> 'complemento') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_j -> 'ondas' -> 'preco') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_j -> 'compradores') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'P6 FALHOU: venda_minhas_sugestoes sem ondas booleanas ou sem compradores: %', v_j;
  END IF;

  RAISE NOTICE 'venda_cliente_ondas23 OK: gerador com complemento/preco, lista com ondas, desfecho de preco exige alta';
END
$post$;
