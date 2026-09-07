-- ============================================================
-- sku_fornecedor_externo.fator_conversao — CHECK de positividade E finitude
--
-- fator_conversao = unidades do PORTAL Sayerlack por unidade do OMIE. A edge
-- enviar-pedido-portal-sayerlack (#2149) faz qtde_portal = ceil(round6(qtde × fator))
-- e ABORTA o pedido inteiro (erro_nao_retentavel) se o fator for ≤ 0 ou não-finito.
-- A UI (MapeamentoFormDialog/useSkuMapeamento) já rejeita ≤ 0 — mas SQL Editor,
-- import e qualquer writer futuro entravam 0/negativo/NaN/Infinity sem barreira.
-- O guard mora no WRITER; a INVARIANTE mora na TABELA (docs/agent/money-path.md).
--
-- Por que os DOIS lados (não só `> 0`): medido em prod, ('NaN'::numeric > 0) é TRUE
-- e ('NaN' > 'Infinity') é TRUE. Logo:
--   CHECK (x > 0)                 aceita NaN  E Infinity
--   CHECK (x > 0 AND x <> 'NaN')  aceita Infinity
--   CHECK (x > 0 AND x < 'Infinity')  fecha os três: 0/negativo (lado 1),
--     Infinity (x < Infinity é FALSE), NaN (NaN < Infinity é FALSE). NULL já é
--     barrado pelo NOT NULL da coluna (DEFAULT 1 NOT NULL desde a criação).
--
-- Pré-flight PROD (psql-ro, 2026-09-04): 309 linhas, 0 NULL, 0 ≤ 0, 0 NaN/Infinity
-- (306 × 1, 3 × 0.2 — ids 131/139/252). Tabela pequena → ADD direto (valida o
-- acervo no mesmo statement; em tabela grande seria NOT VALID + VALIDATE).
--
-- Idempotente: DROP IF EXISTS + ADD (re-colar recria na forma canônica). Atômica:
-- BEGIN/COMMIT — se a postcondição gritar, o ALTER é desfeito junto (nada meio-aplicado).
-- Prova executável: db/test-sku-fornecedor-externo-fator-positivo.sh (PG17 + falsificação).
-- ============================================================

BEGIN;

ALTER TABLE public.sku_fornecedor_externo
  DROP CONSTRAINT IF EXISTS sku_fornecedor_externo_fator_positivo;

ALTER TABLE public.sku_fornecedor_externo
  ADD CONSTRAINT sku_fornecedor_externo_fator_positivo
  CHECK (fator_conversao > 0 AND fator_conversao < 'Infinity'::numeric);

-- ------------------------------------------------------------
-- Postcondição embutida: relê o catálogo E EXECUTA o CHECK. Um Run que não
-- pegou (ou pegou na forma fraca) aborta aqui, com o motivo escrito.
-- Todos os UPDATEs abaixo rodam em subtransação e são DESFEITOS: nenhuma
-- linha, nem atualizado_em, muda de fato.
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_n int;
  v_id bigint;
  v_veneno text;
BEGIN
  -- A1: a constraint existe, é CHECK e está VALIDADA sobre o acervo (NOT VALID = passivo invisível)
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE conrelid = 'public.sku_fornecedor_externo'::regclass
    AND conname = 'sku_fornecedor_externo_fator_positivo'
    AND contype = 'c'
    AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A1 FALHOU: sku_fornecedor_externo_fator_positivo ausente ou NOT VALID — fator 0/negativo/NaN/Infinity segue entrando por SQL/import e a edge do portal aborta o pedido inteiro';
  END IF;

  SELECT id INTO v_id FROM public.sku_fornecedor_externo ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'A2/A3 PULADO: tabela vazia (sem linha para exercitar o CHECK)';
    RETURN;
  END IF;

  -- A2: o CHECK MORDE os cinco venenos — capturando 23514, nunca WHEN OTHERS
  FOREACH v_veneno IN ARRAY ARRAY['0', '-1', 'NaN', 'Infinity', '-Infinity'] LOOP
    BEGIN
      EXECUTE format('UPDATE public.sku_fornecedor_externo SET fator_conversao = %L::numeric WHERE id = $1', v_veneno)
        USING v_id;
      RAISE EXCEPTION 'A2 FALHOU: o CHECK aceitou fator_conversao = % — a edge do portal abortaria todo pedido desse SKU (ou, em NaN/Infinity, ceil() fabricaria quantidade)', v_veneno;
    EXCEPTION
      WHEN check_violation THEN NULL;  -- 23514: exatamente o esperado; UPDATE desfeito
    END;
  END LOOP;

  -- A3: controle POSITIVO — um valor válido ainda entra (CHECK que recusa TUDO passaria em A2).
  --     O UPDATE é desfeito de propósito pela exceção P0999 (nenhum dado muda).
  BEGIN
    UPDATE public.sku_fornecedor_externo SET fator_conversao = 0.5 WHERE id = v_id;
    RAISE EXCEPTION USING ERRCODE = 'P0999', MESSAGE = 'rollback-controle-positivo';
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'A3 FALHOU: o CHECK recusou fator_conversao = 0.5 (VALIDO) — o cadastro de de-para pararia de gravar';
    WHEN SQLSTATE 'P0999' THEN NULL;  -- entrou e foi desfeito: controle positivo OK
  END;

  RAISE NOTICE 'sku_fornecedor_externo_fator_positivo: validada sobre o acervo; 0/-1/NaN/Infinity/-Infinity barrados (23514); 0.5 aceito';
END
$post$;

COMMIT;
