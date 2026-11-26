-- Crédito-IA PR 7, opção C, fatia 1 — espelho das OS do Omie da Colacor SC (só leitura)
-- Uso: ~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/medir-omie-os.sql
-- Registro: docs/historico/credito-os-omie-2026-11.md · migration 20261126233000_omie_os_espelho.sql
\pset pager off

-- 0. Saúde do sync: último run, último run ÍNTEGRO e há quanto tempo (o espelho só muda num íntegro)
SELECT (SELECT max(iniciado_em) FROM public.omie_os_sync_runs WHERE company = 'colacor_sc') AS ultimo_run,
       (SELECT max(terminado_em) FROM public.omie_os_sync_runs WHERE company = 'colacor_sc' AND integra) AS ultimo_integro,
       round((extract(epoch FROM now() - (SELECT max(terminado_em) FROM public.omie_os_sync_runs
                                           WHERE company = 'colacor_sc' AND integra)) / 3600)::numeric, 1) AS horas_sem_integro,
       (SELECT count(*) FROM public.omie_os_sync_runs WHERE company = 'colacor_sc' AND NOT integra
          AND iniciado_em > now() - interval '24 hours') AS nao_integros_24h;

-- 0b. Os últimos 5 runs (o porquê de cada não íntegro)
SELECT id, status, integra, iniciado_em, paginas, lidas, distintas, gravadas, total_registros_declarado AS total_decl,
       promovidas, ausencias_marcadas, left(coalesce(motivo_nao_integra, ''), 80) AS motivo
  FROM public.omie_os_sync_runs WHERE company = 'colacor_sc' ORDER BY id DESC LIMIT 5;

-- 1. O espelho inteiro por situação (flags NULL = indeterminada, nunca "aberta")
SELECT CASE WHEN e.ausente_desde IS NOT NULL THEN 'ausente'
            WHEN e.cancelada IS TRUE THEN 'cancelada'
            WHEN e.faturada IS TRUE THEN 'faturada'
            WHEN e.faturada IS FALSE AND e.cancelada IS FALSE THEN 'aberta'
            ELSE 'indeterminada' END AS situacao,
       count(*) AS os, round(sum(e.valor_total)) AS brl, count(*) FILTER (WHERE e.valor_total IS NULL) AS valor_ilegivel,
       count(*) FILTER (WHERE e.prazo_max_dias IS NULL) AS prazo_ilegivel,
       count(*) FILTER (WHERE e.n_cod_cli IS NULL) AS cliente_ilegivel,
       min(e.data_inclusao)::date AS desde, max(e.data_inclusao)::date AS ate
  FROM public.omie_os_espelho e WHERE e.company = 'colacor_sc'
 GROUP BY 1 ORDER BY 2 DESC;

-- 2. OS ABERTAS: quantas e há quanto tempo (idade e dias sem movimento, dias corridos de Brasília)
SELECT count(*) AS abertas, round(sum(valor_total)) AS brl, count(DISTINCT n_cod_cli) AS clientes,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY idade_dias) AS idade_mediana,
       max(idade_dias) AS idade_max,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY dias_sem_movimento) AS parada_mediana,
       count(*) FILTER (WHERE dias_sem_movimento IS NULL) AS sem_data
  FROM public.omie_os_abertas_v;

-- 2b. Abertas por faixa de dias sem movimento (o N da suspeita de abandono da fatia 2 sai daqui)
SELECT CASE WHEN dias_sem_movimento IS NULL THEN '? sem data'
            WHEN dias_sem_movimento <= 15 THEN 'a ≤15'
            WHEN dias_sem_movimento <= 30 THEN 'b 16-30'
            WHEN dias_sem_movimento <= 60 THEN 'c 31-60'
            WHEN dias_sem_movimento <= 90 THEN 'd 61-90'
            ELSE 'e >90' END AS parada, count(*) AS os, round(sum(valor_total)) AS brl
  FROM public.omie_os_abertas_v GROUP BY 1 ORDER BY 1;

-- 2c. Abertas por etapa
SELECT etapa, count(*) AS os, round(sum(valor_total)) AS brl, max(idade_dias) AS idade_max
  FROM public.omie_os_abertas_v GROUP BY 1 ORDER BY 2 DESC;

-- 3. PROVA DO ELO OS → título: VENR da colacor_sc com numero_pedido normalizado = c_num_os normalizado,
--    MESMO cliente. Normalização: só dígitos, sem zeros à esquerda, vazio/só zeros rejeitado.
WITH os AS (
  SELECT e.n_cod_os, e.n_cod_cli, e.faturada, e.valor_total,
         public.omie_os_numero_normalizado(e.c_num_os) AS num
    FROM public.omie_os_espelho e WHERE e.company = 'colacor_sc'
), venr AS (
  SELECT DISTINCT ON (f.omie_codigo_lancamento) f.omie_codigo_lancamento, f.omie_codigo_cliente,
         f.valor_documento, f.status_titulo, public.omie_os_numero_normalizado(f.numero_pedido) AS num
    FROM public.fin_contas_receber f
   WHERE f.company = 'colacor_sc' AND f.id_origem = 'VENR'
   ORDER BY f.omie_codigo_lancamento, f.updated_at DESC NULLS LAST
), par AS (
  SELECT v.omie_codigo_lancamento, count(o.n_cod_os) AS candidatas
    FROM venr v LEFT JOIN os o ON o.num = v.num AND o.n_cod_cli = v.omie_codigo_cliente
   GROUP BY 1
)
SELECT (SELECT count(*) FROM os WHERE faturada) AS os_faturadas,
       (SELECT count(*) FROM os o WHERE o.faturada AND EXISTS (
          SELECT 1 FROM venr v WHERE v.num = o.num AND v.omie_codigo_cliente = o.n_cod_cli)) AS os_faturadas_com_titulo,
       (SELECT count(*) FROM os WHERE num IS NULL) AS os_numero_rejeitado,
       (SELECT count(*) FROM venr) AS venr_lancamentos,
       (SELECT count(*) FROM venr WHERE num IS NULL) AS venr_numero_rejeitado,
       (SELECT count(*) FROM par WHERE candidatas = 1) AS venr_com_uma_os,
       (SELECT count(*) FROM par WHERE candidatas = 0) AS venr_sem_os,
       (SELECT count(*) FROM par WHERE candidatas > 1) AS venr_ambiguo,
       -- o mesmo número com OUTRO cliente: o elo por número sozinho erraria aqui
       (SELECT count(*) FROM venr v WHERE EXISTS (SELECT 1 FROM os o WHERE o.num = v.num)
          AND NOT EXISTS (SELECT 1 FROM os o WHERE o.num = v.num AND o.n_cod_cli = v.omie_codigo_cliente)) AS venr_numero_de_outro_cliente;

-- 3b. Valor conciliado do elo: OS faturada × Σ VENR ligados (parcelas) — diferença indica elo parcial
WITH os AS (
  SELECT e.n_cod_os, e.c_num_os, e.n_cod_cli, e.valor_total, public.omie_os_numero_normalizado(e.c_num_os) AS num
    FROM public.omie_os_espelho e WHERE e.company = 'colacor_sc' AND e.faturada
), venr AS (
  SELECT DISTINCT ON (f.omie_codigo_lancamento) f.omie_codigo_cliente, f.valor_documento,
         public.omie_os_numero_normalizado(f.numero_pedido) AS num
    FROM public.fin_contas_receber f
   WHERE f.company = 'colacor_sc' AND f.id_origem = 'VENR' AND f.status_titulo IS DISTINCT FROM 'CANCELADO'
   ORDER BY f.omie_codigo_lancamento, f.updated_at DESC NULLS LAST
)
SELECT count(*) FILTER (WHERE t.soma IS NOT NULL AND t.soma = o.valor_total) AS valor_bate,
       count(*) FILTER (WHERE t.soma IS NOT NULL AND t.soma <> o.valor_total) AS valor_diverge,
       count(*) FILTER (WHERE t.soma IS NULL) AS sem_titulo,
       round(sum(o.valor_total)) AS brl_os, round(sum(t.soma)) AS brl_titulos
  FROM os o
  LEFT JOIN LATERAL (SELECT sum(v.valor_documento) AS soma FROM venr v
                      WHERE v.num = o.num AND v.omie_codigo_cliente = o.n_cod_cli) t ON true;

-- 3c. Caso conhecido: OS 461 ↔ RPS 278 / NFS-e 302
SELECT e.n_cod_os, e.c_num_os, e.n_cod_cli, e.faturada, e.valor_total,
       f.numero_documento, f.numero_documento_fiscal, f.numero_pedido, f.valor_documento, f.status_titulo
  FROM public.omie_os_espelho e
  LEFT JOIN public.fin_contas_receber f
    ON f.company = 'colacor_sc' AND f.id_origem = 'VENR' AND f.omie_codigo_cliente = e.n_cod_cli
   AND public.omie_os_numero_normalizado(f.numero_pedido) = public.omie_os_numero_normalizado(e.c_num_os)
 WHERE e.company = 'colacor_sc' AND public.omie_os_numero_normalizado(e.c_num_os) = '461';

SELECT 'FIM_OK' AS marcador;
