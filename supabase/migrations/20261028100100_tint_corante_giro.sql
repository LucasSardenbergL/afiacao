-- ============================================================
-- Giro de corante WP — Fase 1: faixa, regra de pedido e excesso por corante (ADVISORY)
--
-- POR QUÊ: com o consumo dosado coberto (20261028100000), cada WP ganha a política "abrir uma lata"
-- da spec §5: faixa (sem recomendação · parado · muito pouco · devagar · rápido), teto de latas
-- fechadas, excesso e capital parado. Nada aqui escreve no motor de compra.
--
-- Spec:  docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §5
-- Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Task 3; correções 1, 4, 7, 8, 11)
-- Prova: db/test-tint-corante-giro.sh (PG17, controle + --falsificar, C e pt_BR.UTF-8)
--
-- Relógio por PARÂMETRO (p_agora): as views só passam now(). SECURITY INVOKER + views com
-- security_invoker = on: quem lê vê o que o RLS dele permite (o cmc segue o gate de custo; sem ele,
-- capital NULL, nunca 0). Gate de staff na função: customer recebe 0 linhas.
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261028100100_tint_corante_giro.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação). Idempotente.
-- ============================================================

-- ── 1. Consumo diário por WP × dia COBERTO (zero legítimo só dentro da cobertura) ─────────────
CREATE OR REPLACE FUNCTION public.tint_corante_consumo_diario_em(p_agora timestamptz)
RETURNS TABLE (tint_corante_id uuid, wp_codigo text, dia date, qtd_ml numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH k AS (SELECT * FROM public.tint_corante_constantes()),
  cob AS (
    -- Uma loja só: com mais de uma, o giro é faixa 1 e o diário não mistura lojas.
    SELECT c.* FROM public.tint_consumo_cobertura_em(p_agora) c
     WHERE c.account = 'oben' AND c.primeiro_dia_coberto IS NOT NULL
       AND (SELECT count(*) FROM public.tint_consumo_cobertura_em(p_agora) c2 WHERE c2.account = 'oben') = 1
  ), janela AS (
    SELECT cob.store_code, greatest(cob.primeiro_dia_coberto, cob.ultimo_dia_coberto - (k.horizonte_dias - 1)) AS ini,
           cob.ultimo_dia_coberto AS fim
      FROM cob, k
  ), wp AS (
    SELECT tc.id, substring(op.descricao FROM '^(WP[0-9]{2})\.3900QT') AS wp_codigo
      FROM public.tint_corantes tc
      JOIN public.omie_products op ON op.id = tc.omie_product_id
     WHERE tc.account = 'oben' AND tc.omie_product_id IS NOT NULL
  ), dias AS (
    SELECT g::date AS dia FROM janela, generate_series(janela.ini::timestamp, janela.fim::timestamp, interval '1 day') g
  ), dosado AS (
    SELECT c.tint_corante_id, (c.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date AS dia, sum(c.qtd_ml) AS q
      FROM public.tint_consumo_corante c
      JOIN public.tint_consumo_preparacao p
        ON p.account = c.account AND p.store_code = c.store_code AND p.preparacao_id = c.preparacao_id
      JOIN janela j ON j.store_code = c.store_code
     WHERE c.account = 'oben' AND p.situacao = 'valida' AND c.tint_corante_id IS NOT NULL
       AND (c.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN j.ini AND j.fim
     GROUP BY 1, 2
  )
  SELECT wp.id, wp.wp_codigo, dias.dia, COALESCE(dosado.q, 0)  -- dia COBERTO sem dosagem = zero legítimo
    FROM wp CROSS JOIN dias
    LEFT JOIN dosado ON dosado.tint_corante_id = wp.id AND dosado.dia = dias.dia
$fn$;

-- ── 2. Giro por WP: faixa, regra, teto, excesso ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_corante_giro_em(p_agora timestamptz)
RETURNS TABLE (tint_corante_id uuid, wp_codigo text, descricao text, faixa text, faixa_ultimo_calculo text,
               motivo text, consumo_ml_dia numeric, consumo_ml_dia_60d numeric, giro_mudando boolean,
               ponto_pedido_ml numeric, maior_dosagem_ml numeric, lt_dias_corridos int, lt_fonte text,
               recarga_ml numeric, k_latas int, teto_l numeric, estoque_fechado_l numeric, excesso_l numeric,
               cmc_l numeric, capital_parado numeric, demanda_motor_l_dia numeric, dias_cobertos int,
               confianca text, fresco boolean, coberto_ate timestamptz, capacidade_confirmada boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH k AS (SELECT * FROM public.tint_corante_constantes()),
  staff AS (
    SELECT public.has_role(auth.uid(), 'master'::public.app_role)
           OR public.has_role(auth.uid(), 'employee'::public.app_role) AS ok
  ),
  lojas AS (SELECT count(*) AS n FROM public.tint_consumo_cobertura_em(p_agora) c WHERE c.account = 'oben'),
  cob AS (
    SELECT c.* FROM public.tint_consumo_cobertura_em(p_agora) c, lojas
     WHERE c.account = 'oben' AND lojas.n = 1
  ),
  janela AS (
    SELECT cob.store_code, cob.ilha_ate,
           greatest(cob.primeiro_dia_coberto, cob.ultimo_dia_coberto - (k.horizonte_dias - 1)) AS ini,
           cob.ultimo_dia_coberto AS fim
      FROM cob, k WHERE cob.primeiro_dia_coberto IS NOT NULL
  ),
  ausencia AS (
    -- Volume sem ponte e preparações rejeitadas na janela: acima do limite, faixa 1 em TODOS.
    SELECT (SELECT sum(c.qtd_ml) FILTER (WHERE c.tint_corante_id IS NULL) / NULLIF(sum(c.qtd_ml), 0)
              FROM public.tint_consumo_corante c JOIN janela j ON j.store_code = c.store_code
             WHERE c.account = 'oben'
               AND (c.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN j.ini AND j.fim) AS frac_sem_ponte,
           (SELECT count(*) FILTER (WHERE p.situacao = 'rejeitada')::numeric / NULLIF(count(*), 0)
              FROM public.tint_consumo_preparacao p JOIN janela j ON j.store_code = p.store_code
             WHERE p.account = 'oben'
               AND (p.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN j.ini AND j.fim) AS frac_rejeitadas
  ),
  wp AS (
    SELECT tc.id, tc.descricao, tc.capacidade_canister_ml, tc.capacidade_confirmada,
           op.omie_codigo_produto AS qt_codigo,
           substring(op.descricao FROM '^(WP[0-9]{2})\.3900QT') AS wp_codigo
      FROM public.tint_corantes tc
      JOIN public.omie_products op ON op.id = tc.omie_product_id
     WHERE tc.account = 'oben' AND tc.omie_product_id IS NOT NULL
  ),
  gl AS (
    SELECT DISTINCT ON (wp.id) wp.id, op.omie_codigo_produto AS gl_codigo
      FROM wp JOIN public.omie_products op
        ON op.account = 'oben' AND op.descricao ~ ('^' || wp.wp_codigo || '\.3900GL')
     ORDER BY wp.id, op.omie_codigo_produto
  ),
  diario AS (SELECT * FROM public.tint_corante_consumo_diario_em(p_agora)),
  consumo AS (
    SELECT wp.id,
           count(d.dia)::int AS dias,
           sum(d.qtd_ml) / NULLIF(count(d.dia), 0) AS d,
           sum(d.qtd_ml) FILTER (WHERE d.dia > j.fim - k.regime_janela_dias)
             / NULLIF(count(d.dia) FILTER (WHERE d.dia > j.fim - k.regime_janela_dias), 0) AS d60
      FROM wp CROSS JOIN k
      LEFT JOIN janela j ON true
      LEFT JOIN diario d ON d.tint_corante_id = wp.id
     GROUP BY wp.id
  ),
  maior AS (
    SELECT c.tint_corante_id AS id, max(c.qtd_ml) AS m
      FROM public.tint_consumo_corante c JOIN janela j ON j.store_code = c.store_code
     WHERE c.account = 'oben'
       AND (c.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN j.ini AND j.fim
     GROUP BY c.tint_corante_id
  ),
  lt_sku AS (
    SELECT sp.sku_codigo_omie, ceil(greatest(sp.lt_medio_dias_uteis, sp.lt_p95_dias))::int AS n
      FROM public.sku_parametros sp WHERE sp.empresa = 'OBEN'
  ),
  lt_proprio AS (
    SELECT wp.id, lq.n AS n_qt, lg.n AS n_gl
      FROM wp LEFT JOIN gl ON gl.id = wp.id
      LEFT JOIN lt_sku lq ON lq.sku_codigo_omie = wp.qt_codigo
      LEFT JOIN lt_sku lg ON lg.sku_codigo_omie = gl.gl_codigo
  ),
  lt_mediana AS (
    SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY COALESCE(n_qt, n_gl)) AS n
      FROM lt_proprio WHERE COALESCE(n_qt, n_gl) IS NOT NULL
  ),
  lt AS (
    SELECT lp.id, x.n, x.n + 2 * ceil(x.n / 5.0)::int AS ltc,
           CASE WHEN lp.n_qt IS NOT NULL THEN 'QT' WHEN lp.n_gl IS NOT NULL THEN 'GL'
                WHEN x.n IS NOT NULL THEN 'mediana_wp' END AS fonte
      FROM lt_proprio lp CROSS JOIN lt_mediana lm
      CROSS JOIN LATERAL (SELECT COALESCE(lp.n_qt, lp.n_gl, lm.n) AS n) x
  ),
  p90 AS (
    -- P90 das somas em janelas deslizantes de LTc dias INTEIRAMENTE cobertas.
    SELECT lt.id, (percentile_cont(0.9) WITHIN GROUP (ORDER BY w.soma))::numeric AS v
      FROM lt
      JOIN LATERAL (
        SELECT d1.dia, (SELECT sum(d2.qtd_ml) FROM diario d2
                         WHERE d2.tint_corante_id = lt.id AND d2.dia BETWEEN d1.dia AND d1.dia + lt.ltc - 1) AS soma
          FROM diario d1
         WHERE d1.tint_corante_id = lt.id
           AND d1.dia + lt.ltc - 1 <= (SELECT max(d3.dia) FROM diario d3 WHERE d3.tint_corante_id = lt.id)
      ) w ON true
     WHERE lt.ltc IS NOT NULL
     GROUP BY lt.id
  ),
  estoque AS (
    SELECT wp.id,
           CASE WHEN eq.estoque_fisico IS NULL THEN NULL
                WHEN gl.gl_codigo IS NULL THEN eq.estoque_fisico               -- GL não existe: só o QT
                WHEN eg.estoque_fisico IS NULL THEN NULL                       -- GL existe sem estoque: desconhecido
                ELSE eq.estoque_fisico + eg.estoque_fisico END AS fechado_l,
           CASE WHEN pq.demanda_media_diaria IS NULL THEN NULL
                WHEN gl.gl_codigo IS NULL THEN pq.demanda_media_diaria
                WHEN pg.demanda_media_diaria IS NULL THEN NULL                 -- correção 11
                ELSE pq.demanda_media_diaria + pg.demanda_media_diaria END AS demanda_l_dia,
           ip.cmc
      FROM wp LEFT JOIN gl ON gl.id = wp.id
      LEFT JOIN public.sku_estoque_atual eq ON eq.empresa = 'OBEN' AND eq.sku_codigo_omie = wp.qt_codigo::text
      LEFT JOIN public.sku_estoque_atual eg ON eg.empresa = 'OBEN' AND eg.sku_codigo_omie = gl.gl_codigo::text
      LEFT JOIN public.sku_parametros pq ON pq.empresa = 'OBEN' AND pq.sku_codigo_omie = wp.qt_codigo
      LEFT JOIN public.sku_parametros pg ON pg.empresa = 'OBEN' AND pg.sku_codigo_omie = gl.gl_codigo
      LEFT JOIN public.inventory_position ip ON ip.account = 'oben' AND ip.omie_codigo_produto = wp.qt_codigo
  ),
  base AS (
    SELECT wp.*, c.dias, c.d, c.d60, m.m AS maior, lt.ltc, lt.fonte AS lt_fonte, p90.v AS p90,
           least(k.lata_ml, wp.capacidade_canister_ml) AS u,
           greatest(c.d * lt.ltc, p90.v, m.m) AS s,
           cob.ilha_ate AS coberto_ate,
           (cob.ilha_ate > p_agora - make_interval(days => k.frescor_dias)) AS fresco,
           e.fechado_l, e.demanda_l_dia, e.cmc, k.*, lojas.n AS n_lojas, a.frac_sem_ponte, a.frac_rejeitadas
      FROM wp CROSS JOIN k CROSS JOIN lojas CROSS JOIN ausencia a
      LEFT JOIN consumo c ON c.id = wp.id
      LEFT JOIN maior m ON m.id = wp.id
      LEFT JOIN lt ON lt.id = wp.id
      LEFT JOIN p90 ON p90.id = wp.id
      LEFT JOIN estoque e ON e.id = wp.id
      LEFT JOIN cob ON true
  ),
  faixas AS (
    SELECT b.*,
           -- motivo da faixa 1, na ordem do plano; o 2º ignora só o "desatualizado" (último cálculo)
           CASE WHEN b.n_lojas > 1 THEN 'mais_de_uma_loja'
                WHEN b.coberto_ate IS NULL OR COALESCE(b.dias, 0) = 0 THEN 'sem_cobertura'
                WHEN NOT b.fresco THEN 'dado_desatualizado'
                WHEN b.dias < b.cobertura_min_dias THEN 'cobertura_insuficiente'
                WHEN NOT b.capacidade_confirmada OR b.capacidade_canister_ml IS NULL THEN 'capacidade_nao_confirmada'
                WHEN b.ltc IS NULL THEN 'lt_sem_fonte'
                WHEN b.frac_sem_ponte > b.limite_ausencia THEN 'dosagens_sem_ponte'
                WHEN b.frac_rejeitadas > b.limite_ausencia THEN 'preparacoes_rejeitadas'
                WHEN b.d = 0 AND b.dias < b.cobertura_plena_dias THEN 'sem_consumo_cobertura_parcial'
           END AS motivo,
           CASE WHEN b.n_lojas > 1 THEN 'mais_de_uma_loja'
                WHEN b.coberto_ate IS NULL OR COALESCE(b.dias, 0) = 0 THEN 'sem_cobertura'
                WHEN b.dias < b.cobertura_min_dias THEN 'cobertura_insuficiente'
                WHEN NOT b.capacidade_confirmada OR b.capacidade_canister_ml IS NULL THEN 'capacidade_nao_confirmada'
                WHEN b.ltc IS NULL THEN 'lt_sem_fonte'
                WHEN b.frac_sem_ponte > b.limite_ausencia THEN 'dosagens_sem_ponte'
                WHEN b.frac_rejeitadas > b.limite_ausencia THEN 'preparacoes_rejeitadas'
                WHEN b.d = 0 AND b.dias < b.cobertura_plena_dias THEN 'sem_consumo_cobertura_parcial'
           END AS motivo_calc,
           CASE WHEN (b.d = 0 AND b.dias >= b.cobertura_plena_dias) OR (b.d > 0 AND b.u / b.d > b.validade_dias)
                  THEN 'parado'
                WHEN b.d > 0 AND 2 * b.u / b.d - b.ltc > b.validade_dias THEN 'muito_pouco'
                WHEN b.s <= b.u THEN 'devagar'
                WHEN b.s > b.u THEN 'rapido'
           END AS banda
      FROM base b
  )
  SELECT f.id, f.wp_codigo, f.descricao,
         CASE WHEN f.motivo IS NOT NULL THEN 'sem_recomendacao' ELSE f.banda END,
         CASE WHEN f.motivo_calc IS NOT NULL THEN 'sem_recomendacao' ELSE f.banda END,
         f.motivo,
         f.d, f.d60,
         (f.d > 0 AND (f.d60 > f.regime_fator * f.d OR f.d60 < f.d / f.regime_fator)),
         f.s, f.maior, f.ltc, f.lt_fonte, f.u,
         CASE WHEN f.motivo IS NULL AND f.banda = 'rapido' THEN ceil((f.s - f.u) / f.u)::int END,
         t.teto,
         f.fechado_l,
         CASE WHEN f.fechado_l IS NULL OR t.teto IS NULL THEN NULL ELSE greatest(0, f.fechado_l - t.teto) END,
         f.cmc,
         CASE WHEN f.fechado_l IS NULL OR t.teto IS NULL THEN NULL
              ELSE greatest(0, f.fechado_l - t.teto) * f.cmc END,      -- correção 1: L × R$/L, sem ÷ 0,81
         f.demanda_l_dia,
         f.dias,
         CASE WHEN f.dias IS NULL THEN NULL WHEN f.dias < f.cobertura_plena_dias THEN 'baixa' ELSE 'alta' END,
         f.fresco, f.coberto_ate, f.capacidade_confirmada
    FROM faixas f
    CROSS JOIN staff
    CROSS JOIN LATERAL (
      SELECT CASE WHEN f.motivo IS NOT NULL THEN NULL
                  WHEN f.banda IN ('parado', 'muito_pouco') THEN 0::numeric
                  WHEN f.banda = 'devagar' THEN f.lata_l
                  WHEN f.banda = 'rapido' THEN (ceil((f.s - f.u) / f.u) + 1) * f.u / 1000 END AS teto
    ) t
   WHERE staff.ok   -- customer (e sessão sem usuário) recebe 0 linhas
$fn$;

-- ── 3. Views (security_invoker = on: lê como quem consulta, com o RLS dele) ─────────────────────
CREATE OR REPLACE VIEW public.v_corante_consumo_diario WITH (security_invoker = on) AS
  SELECT * FROM public.tint_corante_consumo_diario_em(now());
CREATE OR REPLACE VIEW public.v_corante_giro WITH (security_invoker = on) AS
  SELECT * FROM public.tint_corante_giro_em(now());
REVOKE ALL ON public.v_corante_consumo_diario, public.v_corante_giro FROM PUBLIC, anon;
GRANT SELECT ON public.v_corante_consumo_diario, public.v_corante_giro TO authenticated, service_role;

-- ── PÓS ────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_corante_consumo_diario', 'v_corante_giro'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.' || v)
                    AND c.reloptions @> ARRAY['security_invoker=on']) THEN
      RAISE EXCEPTION 'POS FALHOU: % sem security_invoker=on', v;
    END IF;
    IF has_table_privilege('anon', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'POS FALHOU: anon lê %', v;
    END IF;
  END LOOP;
END
$post$;
