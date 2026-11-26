-- Crédito-IA PR 7 — o canal de OS do app tem uso? (só leitura)
-- Uso: ~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/medir-credito-os-canal.sql
-- Decisão (2026-11-26): o gate da OS espera o canal ter uso. A seção 0 é a CONDIÇÃO DE RETOMADA:
-- retomar_pr7 = true ⇔ ≥ 5 OS enviadas pelo app (afiacao_os_envio) nos últimos 30 dias.
-- Registro: docs/historico/credito-os-afiacao-2026-11.md
\pset pager off

-- 0. Condição de retomada
SELECT count(*) FILTER (WHERE e.reservado_em > now() - interval '30 days') AS os_app_30d,
       count(*) AS os_app_total,
       max(e.reservado_em) AS ultima_os_app,
       count(*) FILTER (WHERE e.reservado_em > now() - interval '30 days') >= 5 AS retomar_pr7
  FROM public.afiacao_os_envio e;

-- 1. Espelho das OS do app (antes do #4051) e pedidos de serviço
SELECT (SELECT count(*) FROM public.omie_ordens_servico) AS os_espelho_total,
       (SELECT max(created_at)::date FROM public.omie_ordens_servico) AS os_espelho_ultima,
       (SELECT count(*) FROM public.orders WHERE created_at > now() - interval '180 days') AS orders_180d;

-- 2. De onde nasce o crédito da Colacor SC (títulos de 90 d por origem Omie e categoria)
SELECT f.id_origem, f.categoria_codigo, count(*) AS titulos,
       round(sum(f.valor_documento)) AS brl, count(DISTINCT f.omie_codigo_cliente) AS clientes,
       count(*) FILTER (WHERE f.numero_pedido IS NOT NULL) AS com_numero_pedido
  FROM public.fin_contas_receber f
 WHERE f.company = 'colacor_sc' AND f.data_emissao > now() - interval '90 days'
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- 3. Prazo concedido no Omie (vencimento − emissão), Colacor SC, 90 d
SELECT (f.data_vencimento - f.data_emissao) AS dias, count(*) AS titulos
  FROM public.fin_contas_receber f
 WHERE f.company = 'colacor_sc' AND f.data_emissao > now() - interval '90 days'
 GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- 4. Opção C (OS criada no Omie): a Colacor SC ainda fatura OS no Omie?
-- O elo OS → título só existe nos títulos VENR (faturamento de OS): numero_pedido = nº da OS.
-- Condição para reabrir a opção C: retomar_opcao_c = true ⇔ ≥ 5 títulos VENR em 90 dias.
-- Em 2026-11-26: último VENR em 2025-12-19, 0 em 2026, retomar_opcao_c = f.
SELECT count(*) FILTER (WHERE f.id_origem = 'VENR')                                       AS venr_vida,
       count(*) FILTER (WHERE f.id_origem = 'VENR' AND nullif(f.numero_pedido, '') IS NOT NULL) AS venr_com_elo,
       max(f.data_emissao) FILTER (WHERE f.id_origem = 'VENR')                            AS ultimo_venr,
       count(*) FILTER (WHERE f.id_origem = 'VENR' AND f.data_emissao > now() - interval '90 days') AS venr_90d,
       count(*) FILTER (WHERE f.id_origem = 'VENR' AND f.data_emissao > now() - interval '90 days') >= 5
                                                                                           AS retomar_opcao_c
  FROM public.fin_contas_receber f
 WHERE f.company = 'colacor_sc';

-- 4b. Origem dos títulos da Colacor SC por mês, desde 2025-09 (mostra a troca VENR → MANR)
SELECT to_char(f.data_emissao, 'YYYY-MM') AS mes, f.id_origem, count(*) AS titulos
  FROM public.fin_contas_receber f
 WHERE f.company = 'colacor_sc' AND f.data_emissao >= date '2025-09-01'
 GROUP BY 1, 2 ORDER BY 1, 2;

SELECT 'FIM_OK' AS marcador;
