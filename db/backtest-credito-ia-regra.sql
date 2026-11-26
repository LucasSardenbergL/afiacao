-- ============================================================
-- Backtest IA × regra em safras VENCIDAS — crédito-IA fatia 5b (2026-11-26).
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9.10 (backtest em safras já vencidas).
-- Resultado documentado: docs/historico/credito-reducao-backtest-5b-2026-11.md
--
-- Rodar (read-only, ~segundos):
--   ~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/backtest-credito-ia-regra.sql
-- A última linha impressa é `BACKTEST_FIM ok` — sem ela, a saída não vale (o psql sai 0 com ERROR).
--
-- Definições (cada uma é decisão de medida, não de produto):
--   * hoje = data civil em São Paulo. Corte T = hoje − 90 (parâmetro :corte_dias).
--   * Grupo (raiz) = réplica em SQL de credito_grupo_raiz (PR 2): dono ÚNICO do par em
--     omie_customer_account_map; alias `active` → canônico; alias `conflict` (no dono ou em qualquer
--     membro) ou cadeia → par fica FORA (contado em `cobertura`). O claude_ro não executa as funções
--     fechadas por desenho, por isso a réplica.
--   * Safra vencida = título CR de venda (categoria 1.01.*), não cancelado, presente no Omie, com
--     vencimento em (T, hoje − 15]. Só ela tem desfecho maduro.
--   * Desfecho por título (tolerância de 5 d, a mesma da ficha do PR 4):
--       em_dia   = RECEBIDO com baixa inferida (v_titulo_baixas, tipo CR, origem título) ≤ venc + 5;
--       atrasou  = RECEBIDO com baixa > venc + 5, OU ainda aberto (inclui PAGTO PARCIAL) — já passou
--                  de venc + 15;
--       sem_desfecho = valor NULL, RECEBIDO sem baixa inferida, ou status fora do vocabulário.
--     AUSENTE ≠ ZERO: sem_desfecho sai da conta e é contado à parte (nunca vira "em dia").
--   * Regra point-in-time (o que o piso diria em T): piso_T = título do grupo (qualquer categoria) com
--     vencimento ≤ T − 60, emitido até T, e ainda não baixado em T (aberto hoje, ou RECEBIDO com baixa
--     > T). RECEBIDO sem baixa inferida nessa condição ⇒ piso_T `indeterminado`.
--     Limitação: título CANCELADO depois de T sai da régua (não sabemos se estava aberto em T).
--   * IA = a proposta MAIS RECENTE do grupo (credito_limite_proposta, PR 4), qualquer status.
--     `ia_restringe` = limite pós-trava 0 OU risco alto/sem_evidencia. Também o risco BRUTO da IA
--     (saida_ia.risco), antes das travas.
--     ⚠️ IN-SAMPLE: a ficha da IA foi calculada HOJE e já contém as baixas destas safras
--     (pct_valor_atrasado e atraso_p50/p80 em 365 d). Mede coerência, não poder preditivo. O
--     out-of-time exige ficha point-in-time e re-chamar o modelo — declarado no doc.
--   * Gate v2 = pior faixa ATUAL da sombra (credito_sombra_pv_atual, PR 5) entre os PVs do grupo.
--   * Atraso por R$ = valor dos títulos `atrasou` ÷ valor dos títulos com desfecho (valor_documento).
--     `atraso_15d` = só o atraso grave (baixa > venc + 15 ou ainda aberto) — a régua do sensor §5.8.
-- ============================================================
\set ON_ERROR_STOP 1
\pset footer off
\if :{?corte_dias}
\else
  \set corte_dias 90
\endif

WITH hoje AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d,
         (now() AT TIME ZONE 'America/Sao_Paulo')::date - :corte_dias AS t
),
donos AS (
  SELECT m.account AS company, m.omie_codigo_cliente AS codigo,
         array_agg(DISTINCT m.user_id) AS donos
    FROM public.omie_customer_account_map m
   WHERE m.omie_codigo_cliente > 0
   GROUP BY 1, 2
),
par_raiz AS (
  SELECT d.company, d.codigo,
         CASE WHEN cardinality(d.donos) <> 1 THEN NULL
              WHEN a.status = 'conflict' THEN NULL
              WHEN a.status = 'active' THEN a.canonical_user_id
              ELSE d.donos[1] END AS raiz_bruta,
         CASE WHEN cardinality(d.donos) <> 1 THEN 'sem_grupo'
              WHEN a.status = 'conflict' THEN 'grupo_conflito' END AS motivo_fora
    FROM donos d
    LEFT JOIN public.customer_canonical_alias a ON a.alias_user_id = d.donos[1]
),
par AS (
  SELECT p.company, p.codigo,
         CASE WHEN p.raiz_bruta IS NULL THEN NULL
              WHEN EXISTS (SELECT 1 FROM public.customer_canonical_alias x
                            WHERE x.canonical_user_id = p.raiz_bruta AND x.status = 'conflict')
                OR EXISTS (SELECT 1 FROM public.customer_canonical_alias x
                            WHERE x.alias_user_id = p.raiz_bruta AND x.status = 'active') THEN NULL
              ELSE p.raiz_bruta END AS raiz,
         COALESCE(p.motivo_fora,
                  CASE WHEN p.raiz_bruta IS NOT NULL
                        AND (EXISTS (SELECT 1 FROM public.customer_canonical_alias x
                                      WHERE x.canonical_user_id = p.raiz_bruta AND x.status = 'conflict')
                             OR EXISTS (SELECT 1 FROM public.customer_canonical_alias x
                                         WHERE x.alias_user_id = p.raiz_bruta AND x.status = 'active'))
                       THEN 'grupo_conflito' END) AS motivo_fora
    FROM par_raiz p
),
baixa AS (
  SELECT b.company, b.omie_codigo_lancamento, max(b.data_baixa_final)::date AS data_baixa
    FROM public.v_titulo_baixas b
   WHERE b.tipo = 'CR' AND b.origem_baixa = 'titulo' AND b.data_baixa_final IS NOT NULL
   GROUP BY 1, 2
),
tit AS (
  SELECT p.raiz, p.motivo_fora, f.company, f.omie_codigo_lancamento, f.valor_documento,
         f.data_emissao, f.data_vencimento, f.status_titulo, f.categoria_codigo, bx.data_baixa,
         (f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')) AS aberto_hoje
    FROM public.fin_contas_receber f
    JOIN par p ON p.company = f.company AND p.codigo = f.omie_codigo_cliente
    LEFT JOIN baixa bx ON bx.company = f.company AND bx.omie_codigo_lancamento = f.omie_codigo_lancamento
   WHERE f.status_titulo IS DISTINCT FROM 'CANCELADO'
     AND f.ausente_omie_desde IS NULL
),
safra AS (
  SELECT t.*,
         CASE WHEN t.valor_documento IS NULL THEN 'sem_desfecho:valor_nulo'
              WHEN t.status_titulo = 'RECEBIDO' AND t.data_baixa IS NULL THEN 'sem_desfecho:recebido_sem_baixa'
              WHEN t.status_titulo = 'RECEBIDO' AND t.data_baixa <= t.data_vencimento + 5 THEN 'em_dia'
              WHEN t.status_titulo = 'RECEBIDO' THEN 'atrasou'
              WHEN t.aberto_hoje THEN 'atrasou'
              ELSE 'sem_desfecho:status_' || COALESCE(t.status_titulo, 'nulo') END AS desfecho
    FROM tit t CROSS JOIN hoje h
   WHERE t.categoria_codigo LIKE '1.01.%'
     AND t.data_vencimento > h.t AND t.data_vencimento <= h.d - 15
),
piso_t AS (
  SELECT t.raiz,
         CASE WHEN bool_or(t.aberto_hoje OR (t.status_titulo = 'RECEBIDO' AND t.data_baixa > h.t)) THEN 'comprovado'
              WHEN bool_or(t.status_titulo = 'RECEBIDO' AND t.data_baixa IS NULL) THEN 'indeterminado'
              ELSE 'livre' END AS piso_t
    FROM tit t CROSS JOIN hoje h
   WHERE t.raiz IS NOT NULL
     AND t.data_vencimento <= h.t - 60
     AND (t.data_emissao IS NULL OR t.data_emissao <= h.t)
   GROUP BY t.raiz
),
ia AS (
  SELECT DISTINCT ON (p.grupo_user_id)
         p.grupo_user_id AS raiz, p.status AS status_proposta, p.created_at AS criada_em, p.risco, p.limite_sugerido_brl,
         p.saida_ia ->> 'risco' AS risco_bruto, p.ficha ->> 'piso_estado' AS piso_hoje,
         (p.limite_sugerido_brl = 0 OR p.risco IN ('alto','sem_evidencia')) AS ia_restringe
    FROM public.credito_limite_proposta p
   WHERE p.status <> 'aplicada_auto_reducao'      -- redução automática (5b) não é proposta da IA
   ORDER BY p.grupo_user_id, p.created_at DESC, p.id
),
v2 AS (
  SELECT s.grupo_user_id AS raiz,
         (array_agg(s.faixa::text ORDER BY CASE s.faixa::text WHEN 'vermelho' THEN 0 WHEN 'amarelo' THEN 1 ELSE 2 END))[1] AS pior_faixa
    FROM public.credito_sombra_pv_atual s
   WHERE s.grupo_user_id IS NOT NULL
   GROUP BY 1
),
grupo AS (
  SELECT s.raiz,
         count(*) FILTER (WHERE s.desfecho IN ('em_dia','atrasou')) AS n_com_desfecho,
         count(*) FILTER (WHERE s.desfecho LIKE 'sem_desfecho%') AS n_sem_desfecho,
         COALESCE(sum(s.valor_documento) FILTER (WHERE s.desfecho IN ('em_dia','atrasou')), 0) AS valor,
         COALESCE(sum(s.valor_documento) FILTER (WHERE s.desfecho = 'atrasou'), 0) AS valor_atrasado,
         COALESCE(sum(s.valor_documento) FILTER (WHERE s.desfecho = 'atrasou'
                    AND (s.aberto_hoje OR s.data_baixa > s.data_vencimento + 15)), 0) AS valor_atrasado_15d,
         count(*) FILTER (WHERE s.desfecho = 'atrasou') AS n_atrasou
    FROM safra s
   WHERE s.raiz IS NOT NULL
   GROUP BY 1
),
g AS (
  SELECT g.*, COALESCE(pt.piso_t, 'livre') AS piso_t,
         ia.raiz IS NOT NULL AS tem_ia, ia.risco, ia.risco_bruto, ia.limite_sugerido_brl, ia.ia_restringe, ia.piso_hoje,
         v2.pior_faixa
    FROM grupo g
    LEFT JOIN piso_t pt ON pt.raiz = g.raiz
    LEFT JOIN ia ON ia.raiz = g.raiz
    LEFT JOIN v2 ON v2.raiz = g.raiz
   WHERE g.n_com_desfecho > 0          -- safra sem nenhum desfecho sai (contada em cobertura)
),
linhas AS (
  -- 0. cobertura (o denominador e o que ficou de fora)
  SELECT 0 AS ord, 'cobertura' AS secao, x.chave, NULL::bigint AS grupos, x.n AS titulos,
         x.valor, NULL::numeric AS valor_atrasado, NULL::numeric AS valor_atrasado_15d
    FROM (SELECT CASE WHEN s.raiz IS NULL THEN 'fora_do_grupo:' || COALESCE(s.motivo_fora, '?')
                      ELSE s.desfecho END AS chave,
                 count(*) AS n, sum(s.valor_documento) AS valor
            FROM safra s GROUP BY 1) x
  UNION ALL
  SELECT 0, 'cobertura', 'sem_desfecho:vencimento_nulo', NULL, count(*), sum(t.valor_documento), NULL, NULL
    FROM tit t WHERE t.categoria_codigo LIKE '1.01.%' AND t.data_vencimento IS NULL
  UNION ALL
  SELECT 0, 'cobertura', 'grupos_so_sem_desfecho',
         (SELECT count(*) FROM grupo WHERE n_com_desfecho = 0), NULL, NULL, NULL, NULL
  UNION ALL
  -- 1. regra point-in-time (todos os grupos com desfecho)
  SELECT 1, 'piso_reconstruido_T', piso_t, count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g GROUP BY piso_t
  UNION ALL
  -- 2. IA (pós-trava) — só grupos com proposta
  SELECT 2, 'ia_risco', risco, count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY risco
  UNION ALL
  SELECT 2, 'ia_risco_bruto', COALESCE(risco_bruto, 'sem_saida'), count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY risco_bruto
  UNION ALL
  SELECT 2, 'ia_limite', CASE WHEN limite_sugerido_brl = 0 THEN 'limite_0'
                              WHEN limite_sugerido_brl <= 1000 THEN 'ate_1k' ELSE 'acima_1k' END,
         count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY 3
  UNION ALL
  SELECT 2, 'piso_reconstruido_T_sem_proposta', piso_t, count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE NOT tem_ia GROUP BY piso_t
  UNION ALL
  -- 3. concordância IA × regra (2×2), em T e hoje
  SELECT 3, 'proposta_restringe_x_piso_T',
         (CASE WHEN ia_restringe THEN 'ia_restringe' ELSE 'ia_libera' END) || ' · '
           || (CASE WHEN piso_t = 'comprovado' THEN 'piso_T_bloqueia' WHEN piso_t = 'indeterminado' THEN 'piso_T_indet' ELSE 'piso_T_libera' END),
         count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY 3
  UNION ALL
  SELECT 3, 'proposta_restringe_x_piso_hoje',
         (CASE WHEN ia_restringe THEN 'ia_restringe' ELSE 'ia_libera' END) || ' · piso_hoje_' || COALESCE(piso_hoje, 'nulo'),
         count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY 3
  UNION ALL
  -- 4. IA × gate v2 (sombra, faixa atual)
  SELECT 4, 'proposta_restringe_x_gate_v2',
         (CASE WHEN ia_restringe THEN 'ia_restringe' ELSE 'ia_libera' END) || ' · v2_' || COALESCE(pior_faixa, 'sem_pv'),
         count(*), sum(n_com_desfecho), sum(valor), sum(valor_atrasado), sum(valor_atrasado_15d)
    FROM g WHERE tem_ia GROUP BY 3
)
-- 5. PROSPECTIVO (§9.10 de verdade): títulos emitidos DEPOIS da proposta, já com desfecho maduro.
--    Vazio no começo; amadurece sozinho — re-rodar este arquivo é a medida. Sem vazamento: a ficha da
--    proposta não podia conhecer estes títulos.
, prosp AS (
  SELECT ia.raiz, ia.ia_restringe, ia.risco, s.desfecho, s.valor_documento
    FROM safra s JOIN ia ON ia.raiz = s.raiz
   WHERE s.data_emissao > (ia.criada_em AT TIME ZONE 'America/Sao_Paulo')::date
)
SELECT 5 AS ord, 'prospectivo' AS secao,
       (CASE WHEN ia_restringe THEN 'proposta_restringe' ELSE 'proposta_libera' END) || ' · ' || desfecho AS chave,
       count(DISTINCT raiz) AS grupos, count(*) AS titulos, round(sum(valor_documento), 2) AS valor_brl,
       NULL::numeric AS atrasado_brl, NULL::numeric AS atraso_por_rs_pct, NULL::numeric AS atraso_15d_por_rs_pct
  FROM prosp GROUP BY 3
UNION ALL
SELECT 5, 'prospectivo', 'titulos_pos_proposta_maduros', NULL, (SELECT count(*) FROM prosp), NULL, NULL, NULL, NULL
UNION ALL
SELECT ord, secao, chave, grupos, titulos, round(valor, 2) AS valor_brl, round(valor_atrasado, 2) AS atrasado_brl,
       CASE WHEN valor > 0 AND valor_atrasado IS NOT NULL THEN round(100 * valor_atrasado / valor, 1) END AS atraso_por_rs_pct,
       CASE WHEN valor > 0 AND valor_atrasado_15d IS NOT NULL THEN round(100 * valor_atrasado_15d / valor, 1) END AS atraso_15d_por_rs_pct
  FROM linhas
 ORDER BY 1, 2, 3;

-- Sanidade: a soma do 2×2 IA × piso_T é o nº de grupos com proposta e desfecho (nenhum grupo some).
SELECT 'BACKTEST_FIM ok' AS marcador;
