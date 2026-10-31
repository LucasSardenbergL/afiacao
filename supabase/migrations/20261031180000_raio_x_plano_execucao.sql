-- Raio-X do estoque parado — pacote 2: plano de execução da decisão [money-path]
--   Preço piso + canal (só no destino liquidar), responsável, prazo e "executado" por decisão.
--   Escritor único do plano: raio_x_planejar (SECURITY DEFINER, gate cap_custo_ler). raio_x_decidir NÃO muda:
--   o upsert dela só escreve as colunas que nomeia (o plano sobrevive a re-decidir) e ela devolve
--   raio_x_decisao via %ROWTYPE + SELECT * (ganha as colunas novas sem recriar — provado executando no PG17).
--   Re-decidir mudando o destino não zera o plano aqui: a leitura (TS) trata concluido_em < decidido_em como
--   "não concluído" e piso/canal só com destino liquidar.
-- Spec: docs/superpowers/specs/2026-10-31-raio-x-pacote-2-design.md · prova: db/test-raio-x-planejar.sh
-- Aplicação: `bun run db:aplicar supabase/migrations/20261031180000_raio_x_plano_execucao.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação; pelo SQL Editor, embrulhe em BEGIN; … COMMIT;).
-- Idempotente (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / CREATE OR REPLACE). Função NOVA: sem PRE.

ALTER TABLE public.raio_x_decisao
  ADD COLUMN IF NOT EXISTS preco_piso       numeric,
  ADD COLUMN IF NOT EXISTS canal_liquidacao text,
  ADD COLUMN IF NOT EXISTS responsavel      uuid,
  ADD COLUMN IF NOT EXISTS prazo            date,
  ADD COLUMN IF NOT EXISTS concluido_em     timestamptz,
  ADD COLUMN IF NOT EXISTS concluido_por    uuid;

-- NaN >= 0 é TRUE no numeric do Postgres: o CHECK nomeia o NaN.
ALTER TABLE public.raio_x_decisao DROP CONSTRAINT IF EXISTS raio_x_decisao_preco_piso_check;
ALTER TABLE public.raio_x_decisao ADD CONSTRAINT raio_x_decisao_preco_piso_check
  CHECK (preco_piso IS NULL OR (preco_piso >= 0 AND preco_piso <> 'NaN'::numeric));
ALTER TABLE public.raio_x_decisao DROP CONSTRAINT IF EXISTS raio_x_decisao_canal_liquidacao_check;
ALTER TABLE public.raio_x_decisao ADD CONSTRAINT raio_x_decisao_canal_liquidacao_check
  CHECK (canal_liquidacao IS NULL OR canal_liquidacao IN ('cliente_especifico','promocao_carteira','outlet_queima','outro'));

COMMENT ON COLUMN public.raio_x_decisao.preco_piso IS
  'Raio-X: preço mínimo aceitável (R$ por unidade de venda) no destino liquidar. Escritor único: raio_x_planejar.';
COMMENT ON COLUMN public.raio_x_decisao.concluido_em IS
  'Raio-X: execução marcada como feita (tarefa, não dinheiro — a meta vem da medição). < decidido_em = destino mudou depois.';

CREATE OR REPLACE FUNCTION public.raio_x_planejar(
  p_empresa text, p_sku bigint, p_preco_piso numeric, p_canal text, p_responsavel uuid, p_prazo date,
  p_concluido boolean, p_atualizado_em timestamptz)
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_old public.raio_x_decisao%ROWTYPE;
  v_row public.raio_x_decisao%ROWTYPE;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END IF;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_concluido IS NULL THEN
    RAISE EXCEPTION 'raio_x: concluido obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso < 0 THEN
    RAISE EXCEPTION 'raio_x: preco_piso negativo: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso = 'NaN'::numeric THEN
    RAISE EXCEPTION 'raio_x: preco_piso invalido: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NOT NULL AND p_canal NOT IN ('cliente_especifico','promocao_carteira','outlet_queima','outro') THEN
    RAISE EXCEPTION 'raio_x: canal invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_responsavel IS NOT NULL
     AND NOT (public.has_role(p_responsavel, 'employee') OR public.has_role(p_responsavel, 'master')) THEN
    RAISE EXCEPTION 'raio_x: responsavel nao e da equipe' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.raio_x_decisao d
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku FOR UPDATE;
  -- [rx002:inicio]
  IF NOT FOUND OR v_old.destino IS NULL THEN
    RAISE EXCEPTION 'raio_x: sem decisao para planejar (sku %)', p_sku USING ERRCODE = 'RX002';
  END IF;
  -- [rx002:fim]
  -- Concorrência otimista: o cliente manda o atualizado_em que EDITOU. Outro operador gravou no meio (decidir,
  -- contar ou planejar) → RX003, nada escrito: o estado completo velho não sobrescreve o novo em silêncio.
  IF v_old.atualizado_em IS DISTINCT FROM p_atualizado_em THEN
    RAISE EXCEPTION 'raio_x: decisao mudou desde a leitura (sku %)', p_sku USING ERRCODE = 'RX003';
  END IF;
  IF v_old.destino <> 'liquidar' AND (p_preco_piso IS NOT NULL OR p_canal IS NOT NULL) THEN
    RAISE EXCEPTION 'raio_x: piso e canal so no destino liquidar (destino %)', v_old.destino USING ERRCODE = '22023';
  END IF;

  UPDATE public.raio_x_decisao d SET
    preco_piso       = p_preco_piso,
    canal_liquidacao = p_canal,
    responsavel      = p_responsavel,
    prazo            = p_prazo,
    -- re-salvar "executado" VIGENTE não move data nem autor; executado de antes do destino atual
    -- (concluido_em < decidido_em) é de outra decisão: marcar de novo registra a nova execução.
    concluido_em     = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_em ELSE now() END END,
    concluido_por    = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_por ELSE auth.uid() END END,
    atualizado_em    = now()
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku
  RETURNING d.* INTO v_row;
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz) TO authenticated;

-- PÓS: postcondição embutida — qualquer falha aborta o apply inteiro.
DO $pos$
DECLARE
  f text := 'public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz)';
  c text;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: raio_x_planejar nao e SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa raio_x_planejar';
  END IF;
  IF has_function_privilege('public', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: PUBLIC executa raio_x_planejar';
  END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated nao executa raio_x_planejar';
  END IF;
  FOREACH c IN ARRAY ARRAY['preco_piso','canal_liquidacao','responsavel','prazo','concluido_em','concluido_por'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'raio_x_decisao' AND column_name = c) THEN
      RAISE EXCEPTION 'postcondicao: coluna % ausente em raio_x_decisao', c;
    END IF;
  END LOOP;
END
$pos$;
