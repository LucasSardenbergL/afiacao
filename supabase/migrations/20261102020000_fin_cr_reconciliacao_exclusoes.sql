-- Migration: reconciliação de títulos EXCLUÍDOS no Omie em fin_contas_receber (plano v4, lote 15 — B3).
-- Desenho: docs/superpowers/specs/2026-11-01-fin-cr-incremental-design.md. Prova: db/test-fin-cr-reconciliacao.sh.
-- ⚠️ NÃO auto-aplica (nome custom). Caminho: `bun run db:aplicar <este arquivo> --ensaio`, depois sem --ensaio
-- (a transação vem do executor). Fallback: SQL Editor do Lovable (transação implícita) — por isso sem BEGIN/COMMIT.
-- ADITIVA: 1 coluna nullable, 1 tabela nova (tombstone), 1 função nova. Nenhuma linha existente é escrita aqui.
--
-- Por quê: o sync só faz upsert, então título EXCLUÍDO no Omie fica no espelho para sempre. Medido em
-- 2026-11-01: 38 títulos ABERTOS que o Omie não devolve mais (oben 29, colacor_sc 7, colacor 2; R$ 16,5 mil),
-- 14 deles ATRASADO (R$ 4,3 mil, 8 clientes) — inadimplência fantasma no aging, na trava de crédito e na
-- cobrança (cobranca_quitacao_ok nunca dá quitação a um cliente com fantasma aberto). Na oben, 10/10
-- consultados responderam "Lançamento não cadastrado".
--
-- Por que DELETE com tombstone e não um status novo: status_titulo é texto livre e ~13 leitores só NEGAM
-- 'CANCELADO'/'RECEBIDO' (fin_aging_receber, v_grupo_contas_receber, v_ciclo_*, fin-cashflow-engine,
-- fin_dre_competencia_base…) — contariam 'EXCLUIDO' como aberto. Ausência de linha todos já tratam. A única
-- FK é fin_ic_matches.cr_id ON DELETE SET NULL; o tombstone guarda a linha inteira, inclusive o id.
--
-- Por que DUAS ausências: a listagem paginada do Omie desliza (título que sai do conjunto no meio da
-- varredura empurra outro para fora da janela da página). Um run marca; só o run completo SEGUINTE que
-- também não o vê apaga. Quem reaparece tem a marca limpa.

ALTER TABLE public.fin_contas_receber ADD COLUMN IF NOT EXISTS ausente_omie_desde timestamptz;
COMMENT ON COLUMN public.fin_contas_receber.ausente_omie_desde IS
  'Início do 1º run COMPLETO do sync em que o Omie não devolveu este título. Writer único: fin_cr_reconciliar_ausentes. NULL = visto no último run.';

CREATE TABLE IF NOT EXISTS public.fin_contas_receber_excluidos (
  id bigserial PRIMARY KEY,
  company text NOT NULL,
  omie_codigo_lancamento bigint NOT NULL,
  cr_id uuid NOT NULL,
  linha jsonb NOT NULL,
  ausente_omie_desde timestamptz NOT NULL,
  universo text NOT NULL CHECK (universo IN ('abertos', 'todos')),
  excluido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_cr_excluidos_company_codigo
  ON public.fin_contas_receber_excluidos (company, omie_codigo_lancamento);
ALTER TABLE public.fin_contas_receber_excluidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fin_contas_receber_excluidos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.fin_contas_receber_excluidos_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.fin_contas_receber_excluidos TO service_role;
GRANT USAGE ON SEQUENCE public.fin_contas_receber_excluidos_id_seq TO service_role;

-- p_universo 'abertos' (incremental): universo = títulos com status aberto do Omie; visto = código em p_vistos
--   (A ∪ B do run). 'todos' (fim de um full): universo = todos os títulos da empresa; visto = updated_at >=
--   p_visto_desde (o full regrava tudo o que o Omie devolve; nenhum trigger mexe em updated_at).
-- Teto: ausentes > max(5, 10% do universo) → RAISE sem escrever (contrato do Omie mudou; não apaga em massa).
CREATE OR REPLACE FUNCTION public.fin_cr_reconciliar_ausentes(
  p_company text,
  p_universo text,
  p_vistos bigint[],
  p_visto_desde timestamptz,
  p_inicio_run timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_universo int;
  v_ausentes int;
  v_teto int;
  v_novos uuid[];
  v_confirmar uuid[];
  v_limpos int;
  v_excluidos int;
BEGIN
  IF p_company IS NULL OR p_inicio_run IS NULL OR p_universo IS NULL OR p_universo NOT IN ('abertos', 'todos') THEN
    RAISE EXCEPTION 'fin_cr_reconciliar_ausentes: argumento inválido (company=%, universo=%)', p_company, p_universo
      USING ERRCODE = '22023';
  END IF;
  IF p_universo = 'abertos' AND p_vistos IS NULL THEN
    RAISE EXCEPTION 'fin_cr_reconciliar_ausentes: universo abertos exige p_vistos' USING ERRCODE = '22023';
  END IF;
  IF p_universo = 'todos' AND p_visto_desde IS NULL THEN
    RAISE EXCEPTION 'fin_cr_reconciliar_ausentes: universo todos exige p_visto_desde' USING ERRCODE = '22023';
  END IF;

  -- Defesa em profundidade sobre o lease da edge: duas reconciliações da mesma empresa não se cruzam.
  PERFORM pg_advisory_xact_lock(hashtext('fin_cr_reconciliar_ausentes'), hashtext(p_company));

  SELECT count(*),
         count(*) FILTER (WHERE NOT u.visto),
         coalesce(array_agg(u.id) FILTER (WHERE NOT u.visto AND u.ausente_desde IS NULL), '{}'),
         coalesce(array_agg(u.id) FILTER (WHERE NOT u.visto AND u.ausente_desde < p_inicio_run), '{}')
    INTO v_universo, v_ausentes, v_novos, v_confirmar
    FROM (
      SELECT r.id,
             CASE WHEN p_universo = 'abertos' THEN r.omie_codigo_lancamento = ANY (p_vistos)
                  ELSE r.updated_at >= p_visto_desde END AS visto,
             r.ausente_omie_desde AS ausente_desde
        FROM public.fin_contas_receber r
       WHERE r.company = p_company
         AND (p_universo = 'todos' OR r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE'))
    ) u;

  v_teto := greatest(5, ceil(v_universo * 0.10)::int);
  IF v_ausentes > v_teto THEN
    RAISE EXCEPTION 'fin_cr_reconciliar_ausentes: TETO — % ausentes de % no universo % de % (teto %); nada escrito',
      v_ausentes, v_universo, p_universo, p_company, v_teto
      USING ERRCODE = 'P0001';
  END IF;

  -- Visto neste run: limpa a marca (inclusive de quem saiu do universo — título que B trouxe RECEBIDO).
  UPDATE public.fin_contas_receber r
     SET ausente_omie_desde = NULL
   WHERE r.company = p_company
     AND r.ausente_omie_desde IS NOT NULL
     AND CASE WHEN p_universo = 'abertos' THEN r.omie_codigo_lancamento = ANY (p_vistos)
              ELSE r.updated_at >= p_visto_desde END;
  GET DIAGNOSTICS v_limpos = ROW_COUNT;

  UPDATE public.fin_contas_receber r
     SET ausente_omie_desde = p_inicio_run
   WHERE r.id = ANY (v_novos);

  -- 2ª ausência em run completo distinto: tombstone ANTES do DELETE, na mesma transação.
  INSERT INTO public.fin_contas_receber_excluidos
         (company, omie_codigo_lancamento, cr_id, linha, ausente_omie_desde, universo)
  SELECT r.company, r.omie_codigo_lancamento, r.id, to_jsonb(r), r.ausente_omie_desde, p_universo
    FROM public.fin_contas_receber r
   WHERE r.id = ANY (v_confirmar);
  DELETE FROM public.fin_contas_receber r WHERE r.id = ANY (v_confirmar);
  GET DIAGNOSTICS v_excluidos = ROW_COUNT;

  RETURN jsonb_build_object(
    'universo', v_universo,
    'ausentes', v_ausentes,
    'teto', v_teto,
    'marcados', cardinality(v_novos),
    'excluidos', v_excluidos,
    'limpos', v_limpos
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fin_cr_reconciliar_ausentes(text, text, bigint[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_cr_reconciliar_ausentes(text, text, bigint[], timestamptz, timestamptz)
  TO service_role;

DO $post$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fin_cr_reconciliar_ausentes(text, text, bigint[], timestamptz, timestamptz)');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'fin_contas_receber' AND column_name = 'ausente_omie_desde') THEN
    RAISE EXCEPTION 'POSTCONDICAO: coluna fin_contas_receber.ausente_omie_desde ausente';
  END IF;
  IF to_regclass('public.fin_contas_receber_excluidos') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fin_contas_receber_excluidos'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICAO: tombstone ausente ou sem RLS';
  END IF;
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO: fin_cr_reconciliar_ausentes ausente';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO: ACL de fin_cr_reconciliar_ausentes errada';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_fn) NOT LIKE '%ausente_desde < p_inicio_run%' THEN
    RAISE EXCEPTION 'POSTCONDICAO: corpo de fin_cr_reconciliar_ausentes sem a regra das duas ausências';
  END IF;
END
$post$;
