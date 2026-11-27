-- ============================================================
-- Crédito-IA — painel de crédito: NOME do grupo pela fonte certa (correção do PR 8, #4190).
-- Medido em prod (psql-ro 2026-11-26): fin_contas_receber.nome_cliente = '' em 1.208/1.208 títulos
-- abertos (o sync não preenche) → a exposição e os bloqueios recentes mostravam grupo SEM NOME.
-- Fonte nova: profiles da raiz do grupo (razao_social, senão name) — o mesmo COALESCE das RPCs de
-- crédito (20261106205557); 16.107/16.107 donos do mapa têm nome. Nome não é contato (onda D).
-- Só isso muda; o resto do corpo é byte a byte o de 20261126180000.
-- Guarda de drift: corpo em prod = o de 20261126180000 (md5 1df6581f…, testemunhado no apply #1488)
-- ou já este. Qualquer outro ⇒ aborta.
-- ============================================================

DO $drift$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.credito_painel_resumo(integer)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'credito_painel_resumo ausente: aplique 20261125120000 e 20261126180000 antes';
  END IF;
  IF md5(v_src) <> '1df6581f02ba66e19a63c46990e026db' AND position('painel-nome-grupo-v3' IN v_src) = 0 THEN
    RAISE EXCEPTION 'credito_painel_resumo: corpo em prod diverge do repo (md5 %) — reconcilie antes', md5(v_src);
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.credito_painel_resumo(p_dias integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_desde_ts timestamptz;
  v_tem_efetivo boolean;
  v_sombra jsonb;
  v_exposicao jsonb;
  v_bloqueios jsonb;
  v_limites jsonb;
  v_concordancia jsonb;
  v_ia jsonb;
  v_fila jsonb;
  v_liberados jsonb;
  v_frescor jsonb;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'credito_painel_resumo: leitura só para gestor/master' USING ERRCODE = '42501';
  END IF;
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 730 THEN
    RAISE EXCEPTION 'credito_painel_resumo: p_dias fora de 1..730 (%)', p_dias USING ERRCODE = '22023';
  END IF;
  -- início do período = meia-noite SP de (hoje - p_dias)
  v_desde_ts := ((v_hoje - p_dias)::timestamp AT TIME ZONE 'America/Sao_Paulo');

  v_tem_efetivo := EXISTS (SELECT 1 FROM public.credito_decisao_pedido d WHERE d.modo = 'efetivo');

  -- ── frescor do espelho de CR por empresa (a exposição é tão boa quanto o sync) ──────────────
  SELECT COALESCE(jsonb_object_agg(x.company, x.ultimo), '{}'::jsonb) INTO v_frescor
    FROM (SELECT f.company, max(f.updated_at) AS ultimo
            FROM public.fin_contas_receber f GROUP BY f.company) x;

  -- ── 1. exposição por grupo × limite ─────────────────────────────────────────────────────────
  WITH abertos AS (
    SELECT f.company, f.omie_codigo_cliente AS codigo, f.saldo, f.data_vencimento, f.status_titulo,
           f.nome_cliente
      FROM public.fin_contas_receber f
     WHERE f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')
  ),
  pares AS (SELECT DISTINCT a.company, a.codigo FROM abertos a),
  raiz AS (
    SELECT p.company, p.codigo, r.j ->> 'raiz' AS raiz, r.j ->> 'motivo' AS motivo
      FROM pares p
      CROSS JOIN LATERAL (SELECT public.credito_grupo_raiz(p.company, p.codigo) AS j) r
  ),
  tit AS (
    SELECT a.*, r.raiz, r.motivo,
           (a.saldo IS NULL OR a.data_vencimento IS NULL) AS indeterminado,
           COALESCE(a.data_vencimento < v_hoje, false) AS vencido,
           COALESCE(a.data_vencimento <= v_hoje - 60, false) AS vencido_60
      FROM abertos a
      JOIN raiz r ON r.company = a.company AND r.codigo IS NOT DISTINCT FROM a.codigo
  ),
  por_grupo AS (
    SELECT t.raiz::uuid AS grupo,
           array_agg(DISTINCT t.company ORDER BY t.company) AS empresas,
           count(*) AS titulos,
           count(*) FILTER (WHERE t.indeterminado) AS titulos_indeterminados,
           count(*) FILTER (WHERE t.status_titulo = 'PAGTO PARCIAL') AS titulos_pagto_parcial,
           -- soma do que se CONHECE; NULL só se nenhum título do grupo tem saldo
           sum(greatest(t.saldo, 0)) FILTER (WHERE t.saldo IS NOT NULL) AS aberto_conhecido,
           -- o conjunto de títulos do grupo está enumerado: 0 aqui é "nenhum vencido conhecido";
           -- os indeterminados ficam na contagem ao lado (o front mostra "≥")
           COALESCE(sum(greatest(t.saldo, 0)) FILTER (WHERE t.saldo IS NOT NULL AND t.vencido), 0) AS vencido_conhecido,
           COALESCE(sum(greatest(t.saldo, 0)) FILTER (WHERE t.saldo IS NOT NULL AND t.vencido_60), 0) AS vencido_60_conhecido,
           count(*) FILTER (WHERE t.vencido_60 AND (t.saldo > 0 OR t.status_titulo = 'PAGTO PARCIAL')) AS titulos_vencidos_60,
           v_hoje - min(t.data_vencimento) FILTER (WHERE t.vencido AND (t.saldo > 0 OR t.status_titulo = 'PAGTO PARCIAL'))
             AS dias_maior_atraso
      FROM tit t
     WHERE t.raiz IS NOT NULL
     GROUP BY t.raiz
  ),
  reservas AS (
    SELECT r.grupo_user_id AS grupo, sum(r.valor_brl) AS reservado
      FROM public.credito_reserva r
     WHERE r.modo = 'efetivo' AND r.status = 'ativa'
     GROUP BY r.grupo_user_id
  ),
  -- universo = grupos com título aberto ∪ grupos com limite vigente (corte por ranking só com UNIÃO
  -- da fonte que conhece a decisão — CLAUDE.md "o teto é o EIXO")
  universo AS (
    SELECT g.grupo FROM por_grupo g
    UNION
    SELECT l.grupo_user_id FROM public.credito_limite l
  ),
  linhas AS (
    SELECT u.grupo,
           -- painel-nome-grupo-v3: nome do grupo = profiles da RAIZ (fin_contas_receber.nome_cliente
           -- vem vazio do sync em 100% dos títulos — medido em prod 2026-11-26). Ausente ⇒ NULL, nunca ''.
           (SELECT COALESCE(NULLIF(btrim(pf.razao_social), ''), NULLIF(btrim(pf.name), ''))
              FROM public.profiles pf WHERE pf.user_id = u.grupo) AS nome,
           g.empresas, COALESCE(g.titulos, 0) AS titulos, g.titulos_indeterminados,
           g.titulos_pagto_parcial, g.aberto_conhecido, g.vencido_conhecido, g.vencido_60_conhecido,
           g.titulos_vencidos_60, g.dias_maior_atraso,
           CASE WHEN v_tem_efetivo THEN COALESCE(rs.reservado, 0) END AS reservado,
           l.limite_brl, l.prazo_max_dias, l.risco, l.vigente_desde, l.versao AS limite_versao
      FROM universo u
      LEFT JOIN por_grupo g ON g.grupo = u.grupo
      LEFT JOIN reservas rs ON rs.grupo = u.grupo
      LEFT JOIN public.credito_limite l ON l.grupo_user_id = u.grupo
  ),
  ranqueadas AS (
    SELECT x.*, row_number() OVER (ORDER BY x.aberto_conhecido DESC NULLS LAST, x.grupo) AS rk
      FROM linhas x
  ),
  nao_consolidados AS (
    SELECT t.motivo, count(DISTINCT (t.company, t.codigo)) AS pares, count(*) AS titulos,
           sum(greatest(t.saldo, 0)) FILTER (WHERE t.saldo IS NOT NULL) AS aberto_conhecido,
           count(*) FILTER (WHERE t.indeterminado) AS titulos_indeterminados
      FROM tit t WHERE t.raiz IS NULL GROUP BY t.motivo
  )
  SELECT jsonb_build_object(
    'totais', (SELECT jsonb_build_object(
        'grupos', count(*) FILTER (WHERE x.titulos > 0),
        'aberto_conhecido', sum(x.aberto_conhecido),
        'vencido_conhecido', sum(x.vencido_conhecido),
        'vencido_60_conhecido', sum(x.vencido_60_conhecido),
        'titulos_indeterminados', COALESCE(sum(x.titulos_indeterminados), 0),
        'grupos_com_limite', count(*) FILTER (WHERE x.limite_brl IS NOT NULL),
        'grupos_vencido_60', count(*) FILTER (WHERE x.titulos_vencidos_60 > 0))
      FROM linhas x),
    'reservas', CASE WHEN v_tem_efetivo
                     THEN jsonb_build_object('disponivel', true)
                     ELSE jsonb_build_object('disponivel', false, 'motivo',
                       'gate efetivo ainda não gravou decisão (enforcement liga no PR 6): reserva não medida') END,
    'grupos', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'grupo_user_id', x.grupo, 'nome', x.nome, 'empresas', to_jsonb(x.empresas),
        'parcial_colacor_sc', COALESCE('colacor_sc' = ANY (x.empresas), false),
        'titulos', x.titulos, 'titulos_indeterminados', x.titulos_indeterminados,
        'titulos_pagto_parcial', x.titulos_pagto_parcial,
        'aberto_conhecido', x.aberto_conhecido, 'vencido_conhecido', x.vencido_conhecido,
        'vencido_60_conhecido', x.vencido_60_conhecido, 'titulos_vencidos_60', x.titulos_vencidos_60,
        'dias_maior_atraso', x.dias_maior_atraso, 'reservado', x.reservado,
        'limite_brl', x.limite_brl, 'prazo_max_dias', x.prazo_max_dias, 'risco', x.risco,
        'limite_versao', x.limite_versao, 'vigente_desde', x.vigente_desde,
        -- uso só com limite > 0, exposição de título conhecida E reserva medida
        'uso_pct', CASE WHEN x.limite_brl > 0 AND x.aberto_conhecido IS NOT NULL AND x.reservado IS NOT NULL
                        THEN round(100 * (x.aberto_conhecido + x.reservado) / x.limite_brl, 1) END
      ) ORDER BY x.rk)
      FROM ranqueadas x WHERE x.rk <= 200 OR x.limite_brl IS NOT NULL), '[]'::jsonb),
    'grupos_omitidos', (SELECT count(*) FROM ranqueadas x WHERE x.rk > 200 AND x.limite_brl IS NULL),
    'nao_consolidados', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'motivo', n.motivo, 'pares', n.pares, 'titulos', n.titulos,
        'aberto_conhecido', n.aberto_conhecido, 'titulos_indeterminados', n.titulos_indeterminados)
        ORDER BY n.motivo) FROM nao_consolidados n), '[]'::jsonb)
  ) INTO v_exposicao;

  -- ── 2. bloqueios (piso do PR 1 → venda_bloqueio_credito_log; gate v2 efetivo → decisões) ───
  SELECT jsonb_build_object(
    'log_total_historico', (SELECT count(*) FROM public.venda_bloqueio_credito_log),
    -- denominador: pedidos criados NO APP no período (os importados do Omie não passam pelo gate)
    'pedidos_app_periodo', (SELECT COALESCE(jsonb_object_agg(z.account, z.n), '{}'::jsonb) FROM (
        SELECT so.account, count(*) AS n FROM public.sales_orders so
         WHERE so.created_by IS NOT NULL AND so.created_at >= v_desde_ts
           -- universo canônico de pedidos (src/lib/farmer/universo-pedidos.ts; gate universo-pedidos-sql)
           AND so.status NOT IN ('cancelado','orcamento','pendente','rascunho') AND so.deleted_at IS NULL
         GROUP BY so.account) z),
    'por_acao', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'acao', z.acao, 'eventos', z.n, 'vencido_conhecido', z.vencido, 'sem_valor', z.sem_valor)
        ORDER BY z.acao) FROM (
        SELECT l.acao, count(*) AS n, sum(l.vencido) FILTER (WHERE l.vencido IS NOT NULL) AS vencido,
               count(*) FILTER (WHERE l.vencido IS NULL) AS sem_valor
          FROM public.venda_bloqueio_credito_log l WHERE l.created_at >= v_desde_ts GROUP BY l.acao) z),
      '[]'::jsonb),
    'recentes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'created_at', z.created_at, 'company', z.company, 'omie_codigo_cliente', z.omie_codigo_cliente,
        'acao', z.acao, 'vencido', z.vencido, 'titulos', z.titulos, 'nome', z.nome)
        ORDER BY z.created_at DESC) FROM (
        SELECT l.created_at, l.company, l.omie_codigo_cliente, l.acao, l.vencido, l.titulos,
               -- dono do par no mapa → profiles; par com mais de 1 dono ⇒ NULL (não adivinha)
               (SELECT CASE WHEN count(DISTINCT m.user_id) = 1 THEN max(COALESCE(NULLIF(btrim(pf.razao_social), ''), NULLIF(btrim(pf.name), ''))) END
                  FROM public.omie_customer_account_map m
                  JOIN public.profiles pf ON pf.user_id = m.user_id
                 WHERE m.account = l.company AND m.omie_codigo_cliente = l.omie_codigo_cliente) AS nome
          FROM public.venda_bloqueio_credito_log l
         WHERE l.created_at >= v_desde_ts
         ORDER BY l.created_at DESC LIMIT 30) z), '[]'::jsonb),
    'gate_v2', CASE WHEN v_tem_efetivo THEN jsonb_build_object('disponivel', true, 'por_motivo',
        COALESCE((SELECT jsonb_agg(jsonb_build_object('faixa', z.faixa, 'motivo', z.motivo, 'decisoes', z.n)
                    ORDER BY z.faixa, z.n DESC) FROM (
          SELECT d.faixa, d.motivo, count(*) AS n FROM public.credito_decisao_pedido d
           WHERE d.modo = 'efetivo' AND d.faixa <> 'verde' AND d.created_at >= v_desde_ts
           GROUP BY d.faixa, d.motivo) z), '[]'::jsonb))
      ELSE jsonb_build_object('disponivel', false, 'motivo',
        'gate v2 ainda não decide pedido de verdade (enforcement liga no PR 6)') END
  ) INTO v_bloqueios;

  -- ── 3. limites vigentes / propostas (PR 4) ──────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'disponivel', EXISTS (SELECT 1 FROM public.credito_limite),
    'motivo', CASE WHEN NOT EXISTS (SELECT 1 FROM public.credito_limite)
                   THEN 'nenhum limite vigente: a 1ª leva de propostas (PR 4) ainda não foi aprovada' END,
    'vigentes', (SELECT count(*) FROM public.credito_limite),
    'propostas', (SELECT COALESCE(jsonb_object_agg(z.status, z.n), '{}'::jsonb)
                    FROM (SELECT p.status, count(*) AS n FROM public.credito_limite_proposta p GROUP BY p.status) z)
  ) INTO v_limites;

  -- ── 4a. concordância IA × regra (fatia 5b → bloco vivo) ────────────────────────────────────
  -- painel-concordancia-ia-v2 (marca de idempotência da guarda de drift da migration 20261126180000)
  -- Réplica VIVA de db/backtest-credito-ia-regra.sql (seções ia_risco, IA × piso de hoje, prospectivo),
  -- com o grupo resolvido pela função canônica credito_grupo_raiz (não a réplica do psql-ro).
  --  • IA = proposta MAIS RECENTE do grupo (qualquer status, fora a redução automática da 5b);
  --    prospectivo = 1ª proposta (coorte fixa). `ia_restringe` = limite 0 OU risco alto/sem_evidencia;
  --  • Safra = CR de venda (1.01.*), não cancelado, presente no Omie, vencimento em
  --    (hoje − p_dias, hoje − 15] (data civil SP). Desfecho com tolerância de 5 d: em_dia = RECEBIDO com
  --    baixa inferida (v_titulo_baixas tipo CR, origem título) ≤ venc + 5; atrasou = baixa depois disso
  --    ou ainda aberto; sem_desfecho (valor nulo, RECEBIDO sem baixa, status fora do vocabulário) sai da
  --    conta e é contado — AUSENTE ≠ ZERO, nunca vira "em dia".
  --  • ⚠️ IN-SAMPLE: a ficha da IA já contém as baixas destas safras — mede coerência, não predição.
  --    O out-of-time é o `prospectivo` (títulos emitidos DEPOIS da 1ª proposta); começa vazio.
  IF NOT EXISTS (SELECT 1 FROM public.credito_limite_proposta p WHERE p.status <> 'aplicada_auto_reducao') THEN
    v_ia := jsonb_build_object('disponivel', false, 'motivo',
      'a IA ainda não propôs limite para nenhum grupo (PR 4): sem proposta não há o que comparar com a regra');
  ELSE
    WITH ia AS (
      SELECT DISTINCT ON (p.grupo_user_id)
             p.grupo_user_id::text AS raiz, p.risco,
             p.ficha ->> 'piso_estado' AS piso_hoje,
             -- limite e risco são NOT NULL na tabela (PR 2): a decisão da IA é sempre conhecida
             (p.limite_sugerido_brl = 0 OR p.risco IN ('alto','sem_evidencia')) AS ia_restringe
        FROM public.credito_limite_proposta p
       WHERE p.status <> 'aplicada_auto_reducao'
       ORDER BY p.grupo_user_id, p.created_at DESC, p.id
    ),
    ia1 AS (
      SELECT DISTINCT ON (p.grupo_user_id)
             p.grupo_user_id::text AS raiz,
             (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS primeira_em,
             -- limite e risco são NOT NULL na tabela (PR 2): a decisão da IA é sempre conhecida
             (p.limite_sugerido_brl = 0 OR p.risco IN ('alto','sem_evidencia')) AS ia_restringe
        FROM public.credito_limite_proposta p
       WHERE p.status <> 'aplicada_auto_reducao'
       ORDER BY p.grupo_user_id, p.created_at, p.id
    ),
    safra0 AS (
      SELECT f.company, f.omie_codigo_cliente AS codigo, f.omie_codigo_lancamento, f.valor_documento,
             f.data_emissao, f.data_vencimento, f.status_titulo
        FROM public.fin_contas_receber f
       WHERE f.status_titulo IS DISTINCT FROM 'CANCELADO'
         AND f.ausente_omie_desde IS NULL
         AND f.categoria_codigo LIKE '1.01.%'
         AND f.data_vencimento > v_hoje - p_dias
         AND f.data_vencimento <= v_hoje - 15
    ),
    pares AS (SELECT DISTINCT s.company, s.codigo FROM safra0 s),
    raiz AS (
      SELECT p.company, p.codigo, r.j ->> 'raiz' AS raiz
        FROM pares p
        CROSS JOIN LATERAL (SELECT public.credito_grupo_raiz(p.company, p.codigo) AS j) r
    ),
    baixa AS (
      SELECT b.company, b.omie_codigo_lancamento, max(b.data_baixa_final) AS data_baixa
        FROM public.v_titulo_baixas b
       WHERE b.tipo = 'CR' AND b.origem_baixa = 'titulo' AND b.data_baixa_final IS NOT NULL
       GROUP BY 1, 2
    ),
    safra AS (
      SELECT r.raiz, s.valor_documento, s.data_emissao,
             CASE WHEN s.valor_documento IS NULL THEN 'sem_desfecho'
                  WHEN s.status_titulo = 'RECEBIDO' AND bx.data_baixa IS NULL THEN 'sem_desfecho'
                  WHEN s.status_titulo = 'RECEBIDO' AND bx.data_baixa <= s.data_vencimento + 5 THEN 'em_dia'
                  WHEN s.status_titulo = 'RECEBIDO' THEN 'atrasou'
                  WHEN s.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')
                    THEN 'atrasou'
                  ELSE 'sem_desfecho' END AS desfecho,
             -- atraso grave (régua do sensor §5.8): ainda aberto, ou baixa depois de venc + 15
             (s.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')
              OR (s.status_titulo = 'RECEBIDO' AND bx.data_baixa > s.data_vencimento + 15)) AS grave
        FROM safra0 s
        JOIN raiz r ON r.company = s.company AND r.codigo = s.codigo AND r.raiz IS NOT NULL
        LEFT JOIN baixa bx ON bx.company = s.company AND bx.omie_codigo_lancamento = s.omie_codigo_lancamento
    ),
    g AS (
      SELECT s.raiz,
             count(*) FILTER (WHERE s.desfecho <> 'sem_desfecho') AS n,
             count(*) FILTER (WHERE s.desfecho = 'sem_desfecho') AS n_sem,
             sum(s.valor_documento) FILTER (WHERE s.desfecho <> 'sem_desfecho') AS valor,
             sum(s.valor_documento) FILTER (WHERE s.desfecho = 'atrasou') AS valor_atrasado,
             sum(s.valor_documento) FILTER (WHERE s.desfecho = 'atrasou' AND s.grave) AS valor_grave
        FROM safra s
       GROUP BY 1
    ),
    gi AS (
      SELECT ia.*, COALESCE(g.n, 0) AS n, COALESCE(g.n_sem, 0) AS n_sem, g.valor,
             -- as somas abaixo só usam grupos com desfecho (n > 0): ali "nenhum atrasado" é ZERO MEDIDO
             COALESCE(g.valor_atrasado, 0) AS valor_atrasado, COALESCE(g.valor_grave, 0) AS valor_grave
        FROM ia LEFT JOIN g ON g.raiz = ia.raiz
    ),
    prosp AS (
      SELECT ia1.ia_restringe, s.desfecho, s.valor_documento, s.grave
        FROM safra s JOIN ia1 ON ia1.raiz = s.raiz
       WHERE s.data_emissao > ia1.primeira_em
    )
    SELECT jsonb_build_object(
      'disponivel', true,
      'in_sample', true,
      'aviso', 'descritivo, não preditivo: a ficha da IA foi calculada depois destas safras e já contém as baixas delas. A medida out-of-time é o bloco prospectivo',
      'janela', jsonb_build_object('vencimento_de', v_hoje - p_dias + 1, 'vencimento_ate', v_hoje - 15,
                                   'tolerancia_dias', 5),
      'grupos_com_proposta', (SELECT count(*) FROM gi),
      'grupos_com_desfecho', (SELECT count(*) FROM gi WHERE gi.n > 0),
      'titulos_sem_desfecho', (SELECT COALESCE(sum(gi.n_sem), 0) FROM gi),
      'concordancia_piso', (
        SELECT jsonb_build_object(
                 'comparaveis', c.comparaveis,
                 'concordam', c.concordam,
                 'fora_da_comparacao', c.fora,
                 'concordancia_pct', CASE WHEN c.comparaveis > 0 THEN round(100.0 * c.concordam / c.comparaveis, 1) END)
          FROM (SELECT count(*) FILTER (WHERE gi.piso_hoje IN ('comprovado','livre')) AS comparaveis,
                       count(*) FILTER (WHERE (gi.piso_hoje = 'comprovado' AND gi.ia_restringe)
                                           OR (gi.piso_hoje = 'livre' AND NOT gi.ia_restringe)) AS concordam,
                       -- ficha sem piso_estado conhecido: fora da comparação, CONTADO (nunca "concorda")
                       count(*) FILTER (WHERE gi.piso_hoje IS NULL OR gi.piso_hoje NOT IN ('comprovado','livre')) AS fora
                  FROM gi) c),
      'por_risco', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'risco', x.risco, 'grupos', x.grupos, 'titulos', x.titulos, 'valor', round(x.valor, 2),
                 'valor_atrasado', round(x.valor_atrasado, 2),
                 'atraso_pct', CASE WHEN x.valor > 0 THEN round(100 * x.valor_atrasado / x.valor, 1) END,
                 'atraso_grave_pct', CASE WHEN x.valor > 0 THEN round(100 * x.valor_grave / x.valor, 1) END)
               ORDER BY x.ordem, x.risco), '[]'::jsonb)
          FROM (SELECT gi.risco,
                       CASE gi.risco WHEN 'baixo' THEN 0 WHEN 'medio' THEN 1 WHEN 'alto' THEN 2
                                     WHEN 'sem_evidencia' THEN 3 ELSE 4 END AS ordem,
                       count(*) AS grupos, sum(gi.n) AS titulos, sum(gi.valor) AS valor,
                       sum(gi.valor_atrasado) AS valor_atrasado, sum(gi.valor_grave) AS valor_grave
                  FROM gi WHERE gi.n > 0 GROUP BY gi.risco) x),
      'ia_x_piso', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'ia_restringe', x.ia_restringe, 'piso_hoje', x.piso_hoje, 'grupos', x.grupos,
                 'titulos', x.titulos, 'valor', round(x.valor, 2),
                 'atraso_pct', CASE WHEN x.valor > 0 THEN round(100 * x.valor_atrasado / x.valor, 1) END,
                 'atraso_grave_pct', CASE WHEN x.valor > 0 THEN round(100 * x.valor_grave / x.valor, 1) END)
               ORDER BY x.ia_restringe, x.piso_hoje NULLS LAST), '[]'::jsonb)
          FROM (SELECT gi.ia_restringe, gi.piso_hoje, count(*) AS grupos, sum(gi.n) AS titulos,
                       sum(gi.valor) AS valor, sum(gi.valor_atrasado) AS valor_atrasado,
                       sum(gi.valor_grave) AS valor_grave
                  FROM gi WHERE gi.n > 0 GROUP BY gi.ia_restringe, gi.piso_hoje) x),
      'prospectivo', jsonb_build_object(
        'titulos_maduros', (SELECT count(*) FROM prosp WHERE prosp.desfecho <> 'sem_desfecho'),
        'por_ia', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'ia_restringe', x.ia_restringe, 'titulos', x.titulos, 'valor', round(x.valor, 2),
                   'atraso_pct', CASE WHEN x.valor > 0 THEN round(100 * x.valor_atrasado / x.valor, 1) END)
                 ORDER BY x.ia_restringe), '[]'::jsonb)
            FROM (SELECT prosp.ia_restringe, count(*) AS titulos, sum(prosp.valor_documento) AS valor,
                         COALESCE(sum(prosp.valor_documento) FILTER (WHERE prosp.desfecho = 'atrasou'), 0) AS valor_atrasado
                    FROM prosp WHERE prosp.desfecho <> 'sem_desfecho' GROUP BY prosp.ia_restringe) x))
    ) INTO v_ia;
  END IF;

  -- ── 4b. distribuição da sombra do PR 5 + concordância gate v2 × piso ─────────────────────────
  -- ── 4. concordância IA × regra (sensores do PR 5) + distribuição da sombra ──────────────────
  -- A sombra do PR 5 NÃO grava em credito_decisao_pedido (por desenho: não toca o gate efetivo); o
  -- estado atual por PV fica em public.credito_sombra_pv_atual (PR 5, #4192 — migration
  -- 20261125200000). Bloco PREPARADO: enquanto a view não existe → "PR 5 não aplicado"; existindo,
  -- lê faixa/motivo; forma diferente da esperada → degrada só o bloco (sem dado + motivo), nunca o painel.
  -- SQL dinâmico de propósito: a view não existe na prod hoje e o corpo não pode depender dela.
  IF to_regclass('public.credito_sombra_pv_atual') IS NULL THEN
    v_sombra := jsonb_build_object('disponivel', false, 'motivo',
      'gate v2 em sombra (PR 5) ainda não aplicado em produção: a distribuição de faixas não existe');
  ELSE
    BEGIN
      EXECUTE $q$
        -- NOT carga_inicial: a distribuição é dos PVs avaliados no fluxo, não da carga dos preexistentes
        -- (orientação do dono do PR 5; seção 4 de db/medir-credito-sombra.sql)
        SELECT jsonb_build_object('disponivel', true,
                 'pvs', (SELECT count(*) FROM public.credito_sombra_pv_atual a WHERE NOT a.carga_inicial),
                 'por_faixa', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'faixa', z.faixa, 'motivo', z.motivo, 'decisoes', z.n) ORDER BY z.faixa, z.n DESC)
                   FROM (SELECT a.faixa::text AS faixa, a.motivo::text AS motivo, count(*) AS n
                           FROM public.credito_sombra_pv_atual a WHERE NOT a.carga_inicial
                          GROUP BY 1, 2) z), '[]'::jsonb),
                 -- concordância v2 × piso atual (a única que existe: a IA ainda não decide — fatia 5b).
                 -- piso_bloqueado NULL (piso sem a chave) fica como NULL, não como "não bloqueou".
                 'v2_x_piso', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'faixa', z.faixa, 'piso_bloqueado', z.pb, 'decisoes', z.n) ORDER BY z.faixa, z.pb)
                   FROM (SELECT a.faixa::text AS faixa, (a.piso ->> 'bloqueado')::boolean AS pb, count(*) AS n
                           FROM public.credito_sombra_pv_atual a WHERE NOT a.carga_inicial
                          GROUP BY 1, 2) z), '[]'::jsonb))
      $q$ INTO v_sombra;
    EXCEPTION WHEN undefined_column OR undefined_table OR insufficient_privilege THEN
      v_sombra := jsonb_build_object('disponivel', false, 'motivo',
        'credito_sombra_pv_atual existe mas não tem a forma esperada (faixa, motivo, piso, carga_inicial): o painel precisa ser ajustado');
    END;
  END IF;

  v_concordancia := v_ia || jsonb_build_object('sombra', v_sombra);

  -- ── 5. fila de aprovação (PR 6) ─────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.credito_solicitacao) THEN
    SELECT jsonb_build_object(
      'disponivel', true,
      'abertas', count(*) FILTER (WHERE s.status = 'aberta'),
      'aberta_mais_antiga', min(s.created_at) FILTER (WHERE s.status = 'aberta'),
      'decididas_periodo', count(*) FILTER (WHERE s.status <> 'aberta' AND s.decidida_em >= v_desde_ts))
      INTO v_fila FROM public.credito_solicitacao s;
  ELSE
    v_fila := jsonb_build_object('disponivel', false, 'motivo',
      'nenhuma solicitação de crédito ainda: a fila nasce no PR 6');
  END IF;

  -- ── 6. liberados que depois atrasaram ───────────────────────────────────────────────────────
  WITH lib AS (
    SELECT so.id, so.account AS company, so.omie_numero_pedido AS pv, so.total, so.created_at,
           CASE
             WHEN EXISTS (SELECT 1 FROM public.venda_bloqueio_credito_log l
                           WHERE l.sales_order_id = so.id AND l.acao = 'liberado_excecao') THEN 'excecao'
             WHEN EXISTS (SELECT 1 FROM public.credito_decisao_pedido d
                           WHERE d.sales_order_id = so.id AND d.modo = 'efetivo' AND d.faixa = 'verde') THEN 'gate_v2'
             WHEN EXISTS (SELECT 1 FROM public.venda_bloqueio_credito_log l
                           WHERE l.sales_order_id = so.id AND l.acao = 'gate_indisponivel') THEN 'gate_indisponivel'
             ELSE 'piso'
           END AS via
      FROM public.sales_orders so
     WHERE so.created_by IS NOT NULL          -- criado no app (importado do Omie não passou pelo gate)
       AND so.omie_numero_pedido IS NOT NULL  -- chegou ao Omie = foi liberado
       AND ltrim(so.omie_numero_pedido, '0') <> ''
       -- universo canônico de pedidos (src/lib/farmer/universo-pedidos.ts; gate universo-pedidos-sql)
       AND so.status NOT IN ('cancelado','orcamento','pendente','rascunho') AND so.deleted_at IS NULL
       -- o pedido do app fica `enviado`; quem segue o Omie é o GÊMEO importado — cancelado lá = não liberou
       -- (lookup do gêmeo POR ID, todo status: registrado no gate universo-pedidos-sql, alias g)
       AND NOT EXISTS (SELECT 1 FROM public.sales_orders g
                        WHERE g.id = so.gemeo_importado_id AND g.status = 'cancelado')
       AND so.created_at >= v_desde_ts
  ),
  tit AS (
    SELECT l.id AS pedido, f.company, f.omie_codigo_lancamento, f.saldo, f.data_vencimento, f.status_titulo,
           COALESCE(f.data_vencimento <= v_hoje - 15, false) AS maturado,
           (COALESCE(f.data_vencimento <= v_hoje - 15, false)
             AND f.status_titulo IS DISTINCT FROM 'RECEBIDO'
             AND (f.status_titulo = 'PAGTO PARCIAL'
                  OR NOT EXISTS (SELECT 1 FROM public.v_titulo_baixas b
                                  WHERE b.company = f.company AND b.tipo = 'CR'
                                    AND b.omie_codigo_lancamento = f.omie_codigo_lancamento
                                    AND b.data_baixa_final IS NOT NULL))) AS atrasou
      FROM lib l
      -- o app grava o PV com zeros à esquerda ('000000000010520'); o título e o gêmeo, sem ('10520')
      JOIN public.fin_contas_receber f ON f.company = l.company AND ltrim(f.numero_pedido, '0') = ltrim(l.pv, '0')
     WHERE f.status_titulo IS DISTINCT FROM 'CANCELADO'
  ),
  por_pedido AS (
    SELECT l.id, l.company, l.pv, l.total, l.created_at, l.via,
           count(t.pedido) AS titulos,
           COALESCE(bool_or(t.maturado), false) AS maturado,
           COALESCE(bool_or(t.atrasou), false) AS atrasou,
           sum(greatest(t.saldo, 0)) FILTER (WHERE t.atrasou AND t.saldo IS NOT NULL) AS saldo_atrasado,
           count(*) FILTER (WHERE t.atrasou AND t.saldo IS NULL) AS atrasados_sem_saldo,
           min(t.data_vencimento) FILTER (WHERE t.atrasou) AS venc_mais_antigo
      FROM lib l LEFT JOIN tit t ON t.pedido = l.id
     GROUP BY l.id, l.company, l.pv, l.total, l.created_at, l.via
  )
  SELECT jsonb_build_object(
    'definicao', 'pedido criado no app que chegou ao Omie, com título derivado vencido há > 15 d (SP) e sem baixa inferida',
    'cobertura', jsonb_build_object('parcial', true, 'motivo',
      'Colacor SC não tem pedido no app: o recorte cobre só Oben e Colacor'),
    'liberados', count(*),
    'liberados_valor', sum(p.total),
    'por_via', (SELECT COALESCE(jsonb_object_agg(z.via, z.n), '{}'::jsonb)
                  FROM (SELECT q.via, count(*) AS n FROM por_pedido q GROUP BY q.via) z),
    'com_titulo', count(*) FILTER (WHERE p.titulos > 0),
    'maturados', count(*) FILTER (WHERE p.maturado),
    'atrasados', count(*) FILTER (WHERE p.atrasou),
    'saldo_atrasado_conhecido', sum(p.saldo_atrasado),
    'titulos_atrasados_sem_saldo', COALESCE(sum(p.atrasados_sem_saldo), 0),
    -- taxa só com denominador: sem pedido maturado não há taxa (NULL, não 0%)
    'taxa_atraso_pct', CASE WHEN count(*) FILTER (WHERE p.maturado) > 0
      THEN round(100.0 * count(*) FILTER (WHERE p.atrasou) / count(*) FILTER (WHERE p.maturado), 1) END,
    'lista', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sales_order_id', q.id, 'company', q.company, 'omie_numero_pedido', q.pv, 'total', q.total,
        'created_at', q.created_at, 'via', q.via, 'saldo_atrasado', q.saldo_atrasado,
        'dias_atraso', v_hoje - q.venc_mais_antigo) ORDER BY q.venc_mais_antigo, q.id)
        FROM (SELECT * FROM por_pedido WHERE atrasou ORDER BY venc_mais_antigo, id LIMIT 50) q), '[]'::jsonb)
  ) INTO v_liberados
    FROM por_pedido p;

  RETURN jsonb_build_object(
    'gerado_em', now(),
    'hoje_sp', v_hoje,
    'periodo_dias', p_dias,
    'frescor_cr', v_frescor,
    'exposicao', v_exposicao,
    'bloqueios', v_bloqueios,
    'limites', v_limites,
    'concordancia', v_concordancia,
    'fila', v_fila,
    'liberados_atrasaram', v_liberados
  );
END;
$$;

-- Fecho por ALLOWLIST: só authenticated executa (o gate de papel está no corpo). O default ACL de
-- public dá EXECUTE também a anon/service_role/sandbox_exec* — sai de todo grantee que não é o dono.
DO $acl$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON FUNCTION public.credito_painel_resumo(integer) FROM PUBLIC;
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
            WHERE p.oid = 'public.credito_painel_resumo(integer)'::regprocedure
              AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.credito_painel_resumo(integer) FROM %s', r.papel);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.credito_painel_resumo(integer) TO authenticated;
END
$acl$;

-- Postcondição (falha a transação se o ACL não ficou como desenhado)
DO $pos$
BEGIN
  IF has_function_privilege('anon', 'public.credito_painel_resumo(integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.credito_painel_resumo(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.credito_painel_resumo(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'credito_painel_resumo: ACL fora do desenho';
  END IF;
END
$pos$;
