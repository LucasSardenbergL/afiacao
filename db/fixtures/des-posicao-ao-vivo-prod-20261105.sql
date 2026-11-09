-- Predecessor da 20261105091216: v_des_posicao_trimestre_ao_vivo como a PROD a tem em 2026-11-05.
-- Corpo = pg_get_viewdef('public.v_des_posicao_trimestre_ao_vivo'::regclass, true) VERBATIM, lido via
-- ~/.config/afiacao/psql-ro (md5 f299f9060f0cbc1eee2c0cad49955a6c); reloptions {security_invoker=on}.
-- Usado por db/test-des-posicao-ao-vivo-sem-faturado.sh (o P1 exige o md5 da prod).
CREATE VIEW public.v_des_posicao_trimestre_ao_vivo
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
            sum(
                CASE
                    WHEN t.fatura_no_trimestre AND (t.zona_confianca = ANY (ARRAY['verde'::text, 'amarelo'::text])) THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_em_transito_seguro,
            sum(
                CASE
                    WHEN t.fatura_no_trimestre AND t.zona_confianca = 'vermelho'::text THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_em_transito_risco,
            sum(
                CASE
                    WHEN NOT t.fatura_no_trimestre THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_fora_trimestre,
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
    round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric), 2) AS posicao_ao_vivo_conservadora,
    round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric), 2) AS posicao_ao_vivo_otimista,
    ( SELECT row_to_json(r.*) AS row_to_json
           FROM ( SELECT des_determinar_faixa.faixa_id,
                    des_determinar_faixa.faixa_numero,
                    des_determinar_faixa.estrelas,
                    des_determinar_faixa.desconto_padrao_perc,
                    des_determinar_faixa.volume_min,
                    des_determinar_faixa.volume_max
                   FROM des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r) AS faixa_conservadora,
    ( SELECT row_to_json(r.*) AS row_to_json
           FROM ( SELECT des_determinar_faixa.faixa_id,
                    des_determinar_faixa.faixa_numero,
                    des_determinar_faixa.estrelas,
                    des_determinar_faixa.desconto_padrao_perc,
                    des_determinar_faixa.volume_min,
                    des_determinar_faixa.volume_max
                   FROM des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r) AS faixa_otimista,
    round(GREATEST(0::numeric, COALESCE(m.meta_faturamento, 0::numeric) - (COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2) AS gap_para_meta_pessoal,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS calculado_em,
    date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text))::date AS inicio_trimestre,
    (date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) + '3 mons -1 days'::interval)::date AS fim_trimestre,
    (date_trunc('quarter'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)) + '3 mons -1 days'::interval)::date - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS dias_restantes
   FROM snapshot s
     FULL JOIN pedidos_apos_snapshot p ON p.empresa = s.empresa AND p.ano = s.ano AND p.trimestre = s.trimestre
     FULL JOIN meta m ON m.empresa = COALESCE(s.empresa, p.empresa) AND m.ano = COALESCE(s.ano, p.ano) AND m.trimestre = COALESCE(s.trimestre, p.trimestre);
