-- DES ao vivo: sem faturado confirmado do GoodData, a posição, a faixa e o gap são NULL (plano v6, lote 3b).
--
-- A v_des_posicao_trimestre_ao_vivo somava `COALESCE(s.fat_bruto_valor, 0) + trânsito`. Sem snapshot do
-- GoodData no trimestre (fat_bruto_confirmado NULL), a "posição" era só pedido em trânsito, e a faixa e o
-- gap saíam dela. Medido na prod (psql-ro, 2026-11-05): OBEN T4/26 sem snapshot, posição 297.966,59 = só
-- trânsito, faixa 3 estrelas, gap 102.873,43; OBEN T1 e T3/26 (só meta) com posição 0,00 e gap 400.840,02.
-- Regra do repo (docs/agent/money-path.md §2): ausente ≠ zero — degrada para NULL, nunca fabrica número.
--
-- O que muda (só 5 colunas; as outras 18 saem idênticas, na mesma ordem e com o mesmo tipo):
--   posicao_ao_vivo_conservadora/_otimista, faixa_conservadora/_otimista → NULL quando fat_bruto_valor é NULL;
--   gap_para_meta_pessoal → NULL quando fat_bruto_valor OU meta_faturamento é NULL (antes, meta NULL virava
--   gap 0, que a tela lê como "Meta atingida").
-- Snapshot com fat_bruto_valor = 0 é FATO (início de trimestre): segue somando o trânsito, como antes.
-- As colunas de trânsito continuam como estão: são fato observado, não posição.
--
-- Quem lê: PosicaoAtualTab, PerformanceHub, useSimuladorData, useCheckinQualitativo, useHistoricoData
-- (o front deste PR degrada para "—" antes desta migration ir ao ar), a view v_des_desconto_por_checkin
-- (faixa NULL → a linha sai pelo `WHERE faixa_id IS NOT NULL`, como já sai quando não há faixa) e a RPC
-- simular_puxar_volume_trimestre (já fazia `IF NULL THEN 0` — fabricação pré-existente, fora deste PR).
--
-- Molde TRAVA → PRE → CREATE → PÓS (.claude/skills/lovable-db-operator/references/sql-house-style.md).
-- Sem BEGIN/COMMIT: aplica por `bun run db:aplicar` (a transação é do executor). Pelo SQL Editor/MCP,
-- envolver em BEGIN; … COMMIT;.

-- TRAVA: ALTER sem efeito (security_invoker já é on na prod) prende a view até o COMMIT.
DO $trava$
BEGIN
  IF to_regclass('public.v_des_posicao_trimestre_ao_vivo') IS NULL THEN
    RAISE EXCEPTION 'TRAVA: public.v_des_posicao_trimestre_ao_vivo ausente — esta migration recria a view, não a cria';
  END IF;
  ALTER VIEW public.v_des_posicao_trimestre_ao_vivo SET (security_invoker = on);
END
$trava$;

-- PRE: o corpo vivo é o da prod de 2026-11-05 (md5 via psql-ro) ou já é este.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(pg_catalog.pg_get_viewdef('public.v_des_posicao_trimestre_ao_vivo'::regclass, true)));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('f299f9060f0cbc1eee2c0cad49955a6c', '02a508694f2f52bd170887a549593cba') THEN
    RAISE EXCEPTION 'PRE FALHOU: v_des_posicao_trimestre_ao_vivo viva (md5 %) não é a da prod de 2026-11-05 nem esta — outra sessão mudou a view; confira antes de recriar', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.v_des_posicao_trimestre_ao_vivo
WITH (security_invoker = on)
AS
WITH snapshot AS (
  SELECT v_des_snapshot_mais_recente.empresa,
    v_des_snapshot_mais_recente.ano,
    v_des_snapshot_mais_recente.trimestre,
    v_des_snapshot_mais_recente.data_referencia,
    v_des_snapshot_mais_recente.objetivo_valor,
    v_des_snapshot_mais_recente.fat_bruto_valor,
    v_des_snapshot_mais_recente.pedidos_abertos_valor
  FROM v_des_snapshot_mais_recente
), pedidos_apos_snapshot AS (
  SELECT t.empresa,
    t.ano_atual AS ano,
    t.trimestre_atual AS trimestre,
    sum(CASE WHEN t.fatura_no_trimestre AND (t.zona_confianca = ANY (ARRAY['verde'::text, 'amarelo'::text])) THEN t.valor_total ELSE 0::numeric END) AS valor_em_transito_seguro,
    sum(CASE WHEN t.fatura_no_trimestre AND t.zona_confianca = 'vermelho'::text THEN t.valor_total ELSE 0::numeric END) AS valor_em_transito_risco,
    sum(CASE WHEN NOT t.fatura_no_trimestre THEN t.valor_total ELSE 0::numeric END) AS valor_fora_trimestre,
    count(*) FILTER (WHERE t.fatura_no_trimestre) AS pedidos_no_trimestre,
    count(*) FILTER (WHERE NOT t.fatura_no_trimestre) AS pedidos_fora_trimestre
  FROM v_des_pedidos_em_transito t
    LEFT JOIN snapshot s_1 ON s_1.empresa = t.empresa AND s_1.ano = t.ano_atual AND s_1.trimestre = t.trimestre_atual
  WHERE t.data_emissao > COALESCE(s_1.data_referencia, '1900-01-01'::date)
  GROUP BY t.empresa, t.ano_atual, t.trimestre_atual
), meta AS (
  SELECT des_meta_empresa.empresa,
    des_meta_empresa.ano,
    des_meta_empresa.trimestre,
    des_meta_empresa.meta_faturamento,
    des_meta_empresa.faixa_des_objetivo
  FROM des_meta_empresa
)
SELECT COALESCE(s.empresa, p.empresa, m.empresa) AS empresa,
  COALESCE(s.ano, p.ano, m.ano) AS ano,
  COALESCE(s.trimestre, p.trimestre, m.trimestre) AS trimestre,
  s.data_referencia AS gooddata_data_referencia,
  s.objetivo_valor AS gooddata_objetivo,
  s.fat_bruto_valor AS fat_bruto_confirmado,
  s.pedidos_abertos_valor AS gooddata_pedidos_abertos,
  m.meta_faturamento AS meta_pessoal,
  m.faixa_des_objetivo AS faixa_des_alvo,
  COALESCE(p.valor_em_transito_seguro, 0::numeric) AS valor_em_transito_seguro,
  COALESCE(p.valor_em_transito_risco, 0::numeric) AS valor_em_transito_risco,
  COALESCE(p.valor_fora_trimestre, 0::numeric) AS valor_fora_trimestre,
  COALESCE(p.pedidos_no_trimestre, 0::bigint) AS qtd_pedidos_no_trimestre,
  COALESCE(p.pedidos_fora_trimestre, 0::bigint) AS qtd_pedidos_fora_trimestre,
  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::numeric
       ELSE round(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric), 2)
  END AS posicao_ao_vivo_conservadora,
  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::numeric
       ELSE round(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric), 2)
  END AS posicao_ao_vivo_otimista,
  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::json
       ELSE (SELECT row_to_json(r.*) AS row_to_json
               FROM (SELECT des_determinar_faixa.faixa_id,
                       des_determinar_faixa.faixa_numero,
                       des_determinar_faixa.estrelas,
                       des_determinar_faixa.desconto_padrao_perc,
                       des_determinar_faixa.volume_min,
                       des_determinar_faixa.volume_max
                     FROM des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r)
  END AS faixa_conservadora,
  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::json
       ELSE (SELECT row_to_json(r.*) AS row_to_json
               FROM (SELECT des_determinar_faixa.faixa_id,
                       des_determinar_faixa.faixa_numero,
                       des_determinar_faixa.estrelas,
                       des_determinar_faixa.desconto_padrao_perc,
                       des_determinar_faixa.volume_min,
                       des_determinar_faixa.volume_max
                     FROM des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r)
  END AS faixa_otimista,
  CASE WHEN s.fat_bruto_valor IS NULL OR m.meta_faturamento IS NULL THEN NULL::numeric
       ELSE round(GREATEST(0::numeric, m.meta_faturamento - (s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2)
  END AS gap_para_meta_pessoal,
  (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS calculado_em,
  date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text))::date AS inicio_trimestre,
  (date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) + '3 mons -1 days'::interval)::date AS fim_trimestre,
  (date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) + '3 mons -1 days'::interval)::date - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS dias_restantes
FROM snapshot s
  FULL JOIN pedidos_apos_snapshot p ON p.empresa = s.empresa AND p.ano = s.ano AND p.trimestre = s.trimestre
  FULL JOIN meta m ON m.empresa = COALESCE(s.empresa, p.empresa) AND m.ano = COALESCE(s.ano, p.ano) AND m.trimestre = COALESCE(s.trimestre, p.trimestre);

-- PÓS: o corpo vivo é ESTE (a mesma régua da PRE) e a view segue lendo como quem consulta (RLS).
DO $pos$
BEGIN
  IF (SELECT md5(pg_catalog.pg_get_viewdef('public.v_des_posicao_trimestre_ao_vivo'::regclass, true)))
       IS DISTINCT FROM '02a508694f2f52bd170887a549593cba' THEN
    RAISE EXCEPTION 'POS1 FALHOU: v_des_posicao_trimestre_ao_vivo não ficou com o corpo desta migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
     WHERE c.oid = 'public.v_des_posicao_trimestre_ao_vivo'::regclass
       AND lower(o) IN ('security_invoker=on', 'security_invoker=true')
  ) THEN
    RAISE EXCEPTION 'POS2 FALHOU: v_des_posicao_trimestre_ao_vivo perdeu security_invoker=on — leria como dono e furaria a RLS';
  END IF;
END
$pos$;
