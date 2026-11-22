-- ============================================================================================================
-- omie_products.estoque: produto NOVO nasce com estoque NULL ("saldo desconhecido"), não 0
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`), que
-- fornece a transação — por isso este arquivo NÃO leva BEGIN/COMMIT.
--
-- O ZERO INVENTADO: a coluna tinha `DEFAULT 0`. Os syncs de catálogo (omie-vendas-sync/catalogo-gravacao,
-- sync-reprocess/products-lote, omie-sync-metadados, tint-omie-sync) inserem produto SEM informar `estoque` —
-- de propósito, porque o campo de estoque do cadastro é DEPRECATED no Omie e chega 0; o dono da coluna é o
-- sync de estoque (UPDATE com o saldo real). Mas no INSERT o DEFAULT preenchia 0, e até o sync de estoque
-- passar a tela mostrava "Est: 0" vermelho para um saldo que ninguém mediu. Ausente ≠ zero.
--
-- Pré-voo PROD (psql-ro, 2026-11-21): `estoque numeric NULL DEFAULT 0`; 8.099 linhas, 0 NULL, 5.808 com 0,
-- 2.291 ≠ 0; 33 criadas nos últimos 30 dias (9 com 0). Nenhuma função SQL faz INSERT em omie_products, e
-- nenhuma edge passa `estoque` no INSERT — só UPDATE com saldo medido (ou o zeramento deliberado).
-- Triggers da tabela (ativo/tipo_produto/updated_at) não leem `estoque`.
--
-- DECISÃO — só o DEFAULT, SEM backfill: o 0 já gravado pode ser saldo REAL informado pelo Omie, e a linha não
-- guarda a proveniência (inserido-pelo-DEFAULT vs. atualizado-pelo-sync-com-0). Reescrever 0→NULL às cegas
-- apagaria saldo medido; o próximo sync de estoque sobrescreve o valor de qualquer forma. Backfill só com
-- evidência por linha — não há, então nenhum.
--
-- `SET DEFAULT NULL` (e não `DROP DEFAULT`): mesmo efeito — o PG não grava pg_attrdef para default NULL
-- constante, então `atthasdef` vira false — sem DDL de DROP no arquivo. Idempotente: re-rodar é no-op.
-- ============================================================================================================

ALTER TABLE public.omie_products ALTER COLUMN estoque SET DEFAULT NULL;

COMMENT ON COLUMN public.omie_products.estoque IS
  'Saldo do produto no Omie, gravado pelo sync de estoque (UPDATE). NULL = saldo desconhecido (produto recém-inserido pelo catálogo, ainda não medido) — não é zero. Sem DEFAULT de propósito (20261121220100).';

DO $post$
DECLARE
  v_hasdef  boolean;
  v_notnull boolean;
BEGIN
  SELECT a.atthasdef, a.attnotnull INTO v_hasdef, v_notnull
    FROM pg_attribute a
   WHERE a.attrelid = 'public.omie_products'::regclass
     AND a.attname = 'estoque'
     AND NOT a.attisdropped;

  IF v_hasdef IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: coluna public.omie_products.estoque nao encontrada';
  END IF;
  IF v_hasdef OR EXISTS (
       SELECT 1 FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'public.omie_products'::regclass AND a.attname = 'estoque') THEN
    RAISE EXCEPTION 'A2 FALHOU: omie_products.estoque ainda tem DEFAULT — produto novo continuaria nascendo com estoque inventado';
  END IF;
  IF v_notnull THEN
    RAISE EXCEPTION 'A3 FALHOU: omie_products.estoque e NOT NULL — NULL (saldo desconhecido) seria rejeitado no INSERT do catalogo';
  END IF;

  RAISE NOTICE 'OK: omie_products.estoque sem DEFAULT e nullable — produto novo nasce NULL';
END
$post$;
