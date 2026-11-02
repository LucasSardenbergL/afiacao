-- Migration: reconciliação de títulos ABERTOS excluídos no Omie em fin_contas_receber (plano v4, lote 15 — B3).
-- Desenho: docs/superpowers/specs/2026-11-01-fin-cr-incremental-design.md. Prova: db/test-fin-cr-reconciliacao.sh.
-- ⚠️ NÃO auto-aplica (nome custom). Caminho: `bun run db:aplicar <este arquivo> --ensaio`, depois sem --ensaio
-- (a transação vem do executor). Fallback: SQL Editor do Lovable (transação implícita) — por isso sem BEGIN/COMMIT.
-- ADITIVA: 1 coluna nullable, 1 tabela nova (tombstone), 2 funções novas. Nenhuma linha existente é escrita aqui.
--
-- Por quê: o sync só faz upsert, então título EXCLUÍDO no Omie fica no espelho para sempre. Medido em
-- 2026-11-01: 38 títulos ABERTOS que o Omie não devolve mais (oben 29, colacor_sc 7, colacor 2; R$ 16,5 mil),
-- 14 deles ATRASADO (R$ 4,3 mil, 8 clientes) — inadimplência fantasma no aging, na trava de crédito e na
-- cobrança (cobranca_quitacao_ok nunca dá quitação a um cliente com fantasma aberto).
--
-- Por que DELETE com tombstone e não um status novo: status_titulo é texto livre e ~13 leitores só NEGAM
-- 'CANCELADO'/'RECEBIDO' (fin_aging_receber, v_grupo_contas_receber, v_ciclo_*, fin-cashflow-engine,
-- fin_dre_competencia_base…) — contariam 'EXCLUIDO' como aberto. Ausência de linha todos já tratam. A única
-- FK é fin_ic_matches.cr_id ON DELETE SET NULL; o tombstone guarda a linha inteira, inclusive o id.
--
-- Por que AUSÊNCIA NÃO BASTA (Codex, desenho, P0): a listagem paginada do conjunto aberto DESLIZA — um título
-- que sai do aberto no meio da varredura empurra outro, inalterado, para uma página já lida, e isso pode se
-- repetir em runs seguidos. Então a ausência só gera CANDIDATO (marcar_ausentes). O DELETE (excluir_confirmados)
-- exige a prova que a edge traz: uma listagem de UMA página do cliente na janela de emissão do título, com
-- contagem afirmativa, que não o contém (resposta única = leitura consistente, sem deslize). A evidência fica
-- no tombstone.

ALTER TABLE public.fin_contas_receber ADD COLUMN IF NOT EXISTS ausente_omie_desde timestamptz;
COMMENT ON COLUMN public.fin_contas_receber.ausente_omie_desde IS
  'Início do 1º run COMPLETO do incremental em que o conjunto aberto do Omie não trouxe este título. Writer único: fin_cr_marcar_ausentes. NULL = visto no último run. Candidato, NÃO prova de exclusão.';

CREATE TABLE IF NOT EXISTS public.fin_contas_receber_excluidos (
  id bigserial PRIMARY KEY,
  company text NOT NULL,
  omie_codigo_lancamento bigint NOT NULL,
  cr_id uuid NOT NULL,
  linha jsonb NOT NULL,
  ausente_omie_desde timestamptz NOT NULL,
  evidencia jsonb NOT NULL,
  excluido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_cr_excluidos_company_codigo
  ON public.fin_contas_receber_excluidos (company, omie_codigo_lancamento);
ALTER TABLE public.fin_contas_receber_excluidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fin_contas_receber_excluidos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.fin_contas_receber_excluidos_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.fin_contas_receber_excluidos TO service_role;
GRANT USAGE ON SEQUENCE public.fin_contas_receber_excluidos_id_seq TO service_role;

-- C1. Universo = títulos da empresa com status aberto do Omie; visto = código em p_vistos (A ∪ B do run).
-- Limpa a marca de todo visto (inclusive de quem saiu do universo — título que B trouxe RECEBIDO), marca os
-- ausentes sem marca, e devolve como CANDIDATOS só os que já estavam marcados por um run ANTERIOR (o deslize
-- de um run se cura sozinho no seguinte e não gasta chamada ao Omie).
-- Teto: ausentes > max(5, 10% do universo) → RAISE sem escrever (o filtro do Omie mudou de semântica).
-- Medido 2026-11-01: 29/860 (oben), 7/116 (colacor_sc), 2/330 (colacor).
CREATE OR REPLACE FUNCTION public.fin_cr_marcar_ausentes(
  p_company text,
  p_vistos bigint[],
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
  v_limpos int;
  v_candidatos jsonb;
BEGIN
  IF p_company IS NULL OR p_inicio_run IS NULL OR p_vistos IS NULL THEN
    RAISE EXCEPTION 'fin_cr_marcar_ausentes: argumento ausente (company=%, vistos nulo=%)', p_company, p_vistos IS NULL
      USING ERRCODE = '22023';
  END IF;

  -- Defesa em profundidade sobre o lease da edge: duas reconciliações da mesma empresa não se cruzam.
  PERFORM pg_advisory_xact_lock(hashtext('fin_cr_reconciliacao'), hashtext(p_company));

  SELECT count(*),
         count(*) FILTER (WHERE NOT (r.omie_codigo_lancamento = ANY (p_vistos))),
         coalesce(array_agg(r.id) FILTER (WHERE NOT (r.omie_codigo_lancamento = ANY (p_vistos))
                                            AND r.ausente_omie_desde IS NULL), '{}')
    INTO v_universo, v_ausentes, v_novos
    FROM public.fin_contas_receber r
   WHERE r.company = p_company
     AND r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE');

  v_teto := greatest(5, ceil(v_universo * 0.10)::int);
  IF v_ausentes > v_teto THEN
    RAISE EXCEPTION 'fin_cr_marcar_ausentes: TETO — % ausentes de % abertos de % (teto %); nada escrito',
      v_ausentes, v_universo, p_company, v_teto
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.fin_contas_receber r
     SET ausente_omie_desde = NULL
   WHERE r.company = p_company
     AND r.ausente_omie_desde IS NOT NULL
     AND r.omie_codigo_lancamento = ANY (p_vistos);
  GET DIAGNOSTICS v_limpos = ROW_COUNT;

  UPDATE public.fin_contas_receber r
     SET ausente_omie_desde = p_inicio_run
   WHERE r.id = ANY (v_novos);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'codigo', r.omie_codigo_lancamento,
           'cliente', r.omie_codigo_cliente,
           'emissao', r.data_emissao) ORDER BY r.ausente_omie_desde, r.omie_codigo_lancamento), '[]'::jsonb)
    INTO v_candidatos
    FROM public.fin_contas_receber r
   WHERE r.company = p_company
     AND r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE')
     AND r.ausente_omie_desde < p_inicio_run
     AND NOT (r.omie_codigo_lancamento = ANY (p_vistos));

  RETURN jsonb_build_object(
    'universo', v_universo,
    'ausentes', v_ausentes,
    'teto', v_teto,
    'marcados', cardinality(v_novos),
    'limpos', v_limpos,
    'candidatos', v_candidatos
  );
END
$fn$;

-- C3. p_confirmados = [{"codigo": <bigint>, "evidencia": {...}}] — só códigos cuja AUSÊNCIA a edge PROVOU
-- (listagem de 1 página do cliente na janela de emissão, contagem afirmativa, sem o código). Apaga só quem
-- ainda está aberto, marcado por um run ANTERIOR e não foi regravado neste run (updated_at < p_inicio_run):
-- qualquer observação positiva entre a prova e esta chamada vence a prova. Tombstone ANTES do DELETE.
CREATE OR REPLACE FUNCTION public.fin_cr_excluir_confirmados(
  p_company text,
  p_confirmados jsonb,
  p_inicio_run timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_ids uuid[];
  v_evid jsonb[];
  v_excluidos int;
BEGIN
  IF p_company IS NULL OR p_inicio_run IS NULL OR p_confirmados IS NULL OR jsonb_typeof(p_confirmados) <> 'array' THEN
    RAISE EXCEPTION 'fin_cr_excluir_confirmados: argumento inválido (company=%)', p_company USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_confirmados) e
              WHERE jsonb_typeof(e->'codigo') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(e->'evidencia') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'fin_cr_excluir_confirmados: item sem codigo numérico ou sem evidencia' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fin_cr_reconciliacao'), hashtext(p_company));

  SELECT coalesce(array_agg(r.id ORDER BY r.id), '{}'), coalesce(array_agg(e.evid ORDER BY r.id), '{}')
    INTO v_ids, v_evid
    FROM (SELECT DISTINCT ON ((x->>'codigo')::bigint) (x->>'codigo')::bigint AS codigo, x->'evidencia' AS evid
            FROM jsonb_array_elements(p_confirmados) x) e
    JOIN public.fin_contas_receber r ON r.company = p_company AND r.omie_codigo_lancamento = e.codigo
   WHERE r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE')
     AND r.ausente_omie_desde < p_inicio_run
     AND r.updated_at < p_inicio_run;

  INSERT INTO public.fin_contas_receber_excluidos
         (company, omie_codigo_lancamento, cr_id, linha, ausente_omie_desde, evidencia)
  SELECT r.company, r.omie_codigo_lancamento, r.id, to_jsonb(r), r.ausente_omie_desde, v.evid
    FROM unnest(v_ids, v_evid) AS v(id, evid)
    JOIN public.fin_contas_receber r ON r.id = v.id;

  DELETE FROM public.fin_contas_receber r WHERE r.id = ANY (v_ids);
  GET DIAGNOSTICS v_excluidos = ROW_COUNT;

  RETURN jsonb_build_object('pedidos', jsonb_array_length(p_confirmados), 'excluidos', v_excluidos);
END
$fn$;

REVOKE ALL ON FUNCTION public.fin_cr_marcar_ausentes(text, bigint[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_cr_marcar_ausentes(text, bigint[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fin_cr_excluir_confirmados(text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_cr_excluir_confirmados(text, jsonb, timestamptz) TO service_role;

DO $post$
DECLARE
  v_marcar regprocedure := to_regprocedure('public.fin_cr_marcar_ausentes(text, bigint[], timestamptz)');
  v_excluir regprocedure := to_regprocedure('public.fin_cr_excluir_confirmados(text, jsonb, timestamptz)');
  v_fn regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'fin_contas_receber' AND column_name = 'ausente_omie_desde') THEN
    RAISE EXCEPTION 'POSTCONDICAO: coluna fin_contas_receber.ausente_omie_desde ausente';
  END IF;
  IF to_regclass('public.fin_contas_receber_excluidos') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fin_contas_receber_excluidos'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICAO: tombstone ausente ou sem RLS';
  END IF;
  IF v_marcar IS NULL OR v_excluir IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO: funções de reconciliação ausentes (marcar=%, excluir=%)', v_marcar, v_excluir;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[v_marcar, v_excluir] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: ACL errada em %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_excluir) NOT LIKE '%r.updated_at < p_inicio_run%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_marcar) NOT LIKE '%r.ausente_omie_desde < p_inicio_run%' THEN
    RAISE EXCEPTION 'POSTCONDICAO: corpo das funções sem as guardas de run anterior';
  END IF;
END
$post$;
