-- Migration: apaga o índice covering idx_radar_muni_cover (150 MB) de radar_empresas, que não tem leitor.
-- Evidência e números: docs/historico/tint-purge-staging-io.md ("leitor 4", drop do idx_radar_muni_cover).
-- ⚠️ NÃO auto-aplica (nome custom). Tem DROP INDEX → é DDL destrutivo, apply do founder:
-- SQL Editor do Lovable (transação implícita da colagem — por isso o arquivo não leva BEGIN/COMMIT).
--
-- O QUE NÃO MUDA: nenhuma coluna, nenhum dado, nenhuma função. Só some um índice que ninguém lê.
--
-- Diagnóstico (psql-ro, 2026-11-05 14:38Z):
--   idx_radar_muni_cover  150 MB  idx_scan = 0, idx_tup_read = 0. Contadores sem reset (stats_reset nunca,
--   postmaster de 2026-10-31 10:33): nem o caminho rápido antigo da contagem, para o qual ele nasceu
--   (20260614140000_radar_contagem_perf), o leu nesse período.
-- Por que nenhum leitor de hoje pode usá-lo: o índice é PARCIAL (ja_cliente = false AND prospeccao_status
-- <> 'descartado') e cobre só municipio_codigo, uf, prospeccao_status, telefone1/2, municipio_nome.
--   - radar_contagem_por_municipio: agregado e fino leem radar_agregado_*; o caminho vivo (data mínima,
--     inéditos de outro lote, CNAE secundário não coberto) filtra por colunas fora do índice (data_abertura,
--     ultimo_lote, cnaes_secundarios, email) — sem index-only scan, um índice de 150 MB inteiro perde do
--     seq scan / dos índices dirigidos.
--   - radar_penetracao_por_municipio: lê radar_agregado_municipio.
--   - carteira_por_municipio: municipio_codigo = $1 SEM o predicado parcial → não pode usar este índice nem
--     o idx_radar_muni (12 MB, mesmo predicado); o plano dela não muda com o drop.
--   - radar_possiveis_vinculos: por cnpj (pkey). radar_lista: SQL dinâmico, índices de score/fila/GIN.
-- Ganho: 150 MB de disco e de cache (23% dos 655 MB de índices da tabela) e uma inserção a menos por
-- update não-HOT e por linha da carga mensal (~573 mil).
-- Reverter: re-rodar o CREATE INDEX de 20260614140000_radar_contagem_perf.sql (de preferência CONCURRENTLY).

-- Lock curto: DROP INDEX precisa de ACCESS EXCLUSIVE em radar_empresas. Com leitor longo na frente, falha
-- em 3 s em vez de enfileirar o /radar atrás de si — basta colar de novo.
SET lock_timeout = '3s';

-- PRE: se o índice existe, tem de ser O de 20260614140000. Outro índice com o mesmo nome = alguém o
-- recriou para outro leitor; apagá-lo às cegas tiraria esse leitor. Ausente = já aplicado (idempotente).
DO $pre$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_indexdef(c.oid) INTO v_def
    FROM pg_catalog.pg_class c
   WHERE c.oid = to_regclass('public.idx_radar_muni_cover');
  IF v_def IS NOT NULL AND v_def <> 'CREATE INDEX idx_radar_muni_cover ON public.radar_empresas USING btree '
       || '(municipio_codigo, uf) INCLUDE (prospeccao_status, telefone1, telefone2, municipio_nome) '
       || 'WHERE ((ja_cliente = false) AND (prospeccao_status <> ''descartado''::text))' THEN
    RAISE EXCEPTION 'PRE: idx_radar_muni_cover mudou de definição (%) — revise quem o lê antes de apagar', v_def;
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_radar_muni_cover;

-- PÓS: o índice sumiu e o parcial por município (idx_radar_muni, 3 leituras) continua lá — o drop é de UM.
DO $post$
BEGIN
  IF to_regclass('public.idx_radar_muni_cover') IS NOT NULL THEN
    RAISE EXCEPTION 'POS: idx_radar_muni_cover ainda existe';
  END IF;
  IF to_regclass('public.idx_radar_muni') IS NULL THEN
    RAISE EXCEPTION 'POS: idx_radar_muni sumiu — o drop levou um índice que tem leitor';
  END IF;
  RAISE NOTICE 'POS ok: idx_radar_muni_cover apagado; idx_radar_muni intacto';
END
$post$;

RESET lock_timeout;
