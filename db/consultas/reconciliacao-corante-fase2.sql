-- reconciliacao-corante-fase2.sql — critério 2 de entrada da Fase 2 do giro de corante
-- (spec docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §11.2; plano Task 4).
--
-- "Quando medir" é QUERY, não recado (docs/historico/fase-sem-sinal.md). Rode com psql-ro:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/consultas/reconciliacao-corante-fase2.sql
-- (opcional: -v agora="'2027-02-01 12:00-03'" para fixar o relógio; o físico é SEMPRE o snapshot atual de
-- sku_estoque_atual, então medir no passado só vale para o dosado/recebido.)
--
--   retirado(WP) = linha de base (§3) + Σ recebido (NF efetivada, L) − físico atual (QT+GL)
--   dosado(WP)   = Σ qtd_ml ÷ 1000 das preparações VÁLIDAS desde a linha de base
--   elegível     = retirado >= 2 L;  exige >= 5 elegíveis, senão `nao_medido` (não "passou")
--   por elegível = |dosado − retirado| <= C/1000 + 0,81  E  <= 25% do retirado
--   agregado     = Σ dosado ÷ Σ retirado (elegíveis) entre 0,85 e 1,15
-- Ausente ≠ zero: NF de WP em unidade ≠ L, físico/capacidade desconhecidos → a parcela é NULL e o WP
-- não é medido; elegível com veredito NULL → `nao_medido`.
\if :{?agora}
\else
  \set agora now
\endif

WITH params AS (
  SELECT :'agora'::timestamptz AS agora,
         '2026-10-27 21:53-03'::timestamptz AS base_em      -- sync da linha de base (§3)
), linha_base(wp_codigo, base_l) AS (
  VALUES ('WP01', 7.11), ('WP02', 2.43), ('WP03', 3.67), ('WP04', 3.24), ('WP42', 1.62),
         ('WP06', 2.43), ('WP07', 0.81), ('WP08', 5.48), ('WP12', 7.91),
         ('WP53', 1.43), ('WP69', 3.05), ('WP71', 0.00), ('WP87', 8.34), ('WP88', 0.00)
), wp AS (
  SELECT tc.id, tc.capacidade_canister_ml, substring(op.descricao FROM '^(WP[0-9]{2})\.3900QT') AS wp_codigo
    FROM tint_corantes tc JOIN omie_products op ON op.id = tc.omie_product_id
   WHERE tc.account = 'oben' AND tc.omie_product_id IS NOT NULL
), skus AS (   -- QT e GL de cada WP no Omie (OBEN)
  SELECT wp.wp_codigo, op.omie_codigo_produto
    FROM wp JOIN omie_products op
      ON op.account = 'oben' AND op.descricao ~ ('^' || wp.wp_codigo || '\.3900(QT|GL)')
), recebido AS (   -- só NF EFETIVADA no período; WP sem NF no período = 0 recebido (legítimo)
  SELECT s.wp_codigo,
         CASE WHEN bool_or(n.unidade_nfe IS DISTINCT FROM 'L') FILTER (WHERE n.item_id IS NOT NULL) THEN NULL
              ELSE COALESCE(sum(n.quantidade_nfe), 0) END AS recebido_l   -- unidade ≠ L: não mede
    FROM skus s
    LEFT JOIN (SELECT i.id AS item_id, i.produto_omie_id, i.unidade_nfe, i.quantidade_nfe
                 FROM nfe_recebimento_itens i
                 JOIN nfe_recebimentos r ON r.id = i.nfe_recebimento_id
                 CROSS JOIN params
                WHERE r.status = 'efetivado' AND r.efetivado_at > params.base_em
                  AND r.efetivado_at <= params.agora) n
      ON n.produto_omie_id = s.omie_codigo_produto
   GROUP BY s.wp_codigo
), fisico AS (
  SELECT s.wp_codigo,
         CASE WHEN count(e.sku_codigo_omie) < count(*) THEN NULL           -- SKU sem linha de estoque: desconhecido
              ELSE sum(e.estoque_fisico) END AS fisico_l
    FROM skus s
    LEFT JOIN sku_estoque_atual e ON e.empresa = 'OBEN' AND e.sku_codigo_omie = s.omie_codigo_produto::text
   GROUP BY s.wp_codigo
), dosado AS (
  SELECT wp.wp_codigo, COALESCE(sum(c.qtd_ml), 0) / 1000 AS dosado_l
    FROM wp CROSS JOIN params
    LEFT JOIN tint_consumo_corante c
      ON c.tint_corante_id = wp.id AND c.data_dosagem > params.base_em AND c.data_dosagem <= params.agora
     AND EXISTS (SELECT 1 FROM tint_consumo_preparacao p
                  WHERE p.account = c.account AND p.store_code = c.store_code
                    AND p.preparacao_id = c.preparacao_id AND p.situacao = 'valida')
   GROUP BY wp.wp_codigo
), por_wp AS (
  SELECT lb.wp_codigo, lb.base_l, rc.recebido_l, f.fisico_l,
         lb.base_l + rc.recebido_l - f.fisico_l AS retirado_l,
         d.dosado_l, wp.capacidade_canister_ml
    FROM linha_base lb
    LEFT JOIN wp ON wp.wp_codigo = lb.wp_codigo
    LEFT JOIN recebido rc ON rc.wp_codigo = lb.wp_codigo
    LEFT JOIN fisico f ON f.wp_codigo = lb.wp_codigo
    LEFT JOIN dosado d ON d.wp_codigo = lb.wp_codigo
), avaliado AS (
  SELECT p.*,
         (p.retirado_l >= 2) AS elegivel,
         CASE WHEN p.retirado_l IS NULL OR p.dosado_l IS NULL OR p.capacidade_canister_ml IS NULL THEN NULL
              ELSE abs(p.dosado_l - p.retirado_l) <= p.capacidade_canister_ml / 1000 + 0.81
                   AND abs(p.dosado_l - p.retirado_l) <= 0.25 * p.retirado_l END AS passa
    FROM por_wp p
), agregado AS (
  SELECT count(*) FILTER (WHERE elegivel) AS n_elegiveis,
         bool_or(elegivel AND passa IS NULL) AS algum_sem_medida,
         bool_and(passa) FILTER (WHERE elegivel) AS todos_passam,
         sum(dosado_l) FILTER (WHERE elegivel) / NULLIF(sum(retirado_l) FILTER (WHERE elegivel), 0) AS razao
    FROM avaliado
)
SELECT wp_codigo, base_l, recebido_l, fisico_l, retirado_l, round(dosado_l, 3) AS dosado_l,
       COALESCE(elegivel, false) AS elegivel, passa, NULL::text AS veredito
  FROM avaliado
UNION ALL
SELECT 'VEREDITO', NULL, NULL, NULL, NULL, round(a.razao, 3), NULL, NULL,
       CASE WHEN a.n_elegiveis < 5 OR a.algum_sem_medida THEN 'nao_medido'
            WHEN a.todos_passam AND a.razao BETWEEN 0.85 AND 1.15 THEN 'passou'
            ELSE 'reprovou' END
  FROM agregado a
ORDER BY 1;
