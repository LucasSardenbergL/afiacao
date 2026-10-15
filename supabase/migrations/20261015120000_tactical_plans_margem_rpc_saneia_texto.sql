-- FU4-F (A de 2) — A margem por cliente sai do plano tático: RPC com gate de PROJEÇÃO para as colunas
-- e saneamento do TEXTO gerado pela IA (histórico + toda gravação futura).
--
-- Achado (medido por psql-ro em 2026-10-14, sessão do #3072, e re-medido em 2026-10-15):
--   · `public.farmer_tactical_plans` tem SELECT de TABELA para authenticated (relacl rDxtm, sem attacl) e
--     uma única policy de SELECT, `tactical_plans_select_staff` = master OR employee — staff-wide, sem
--     escopo de carteira. current_margin_pct e cluster_avg_margin_pct têm valor em 984/984 planos, e
--     expected_result (cenários de MARGEM projetados pela IA a partir do número) em 896.
--   · O TEXTO do plano cita o número: 902/984 planos têm "margem … N%"; em 546 o valor exato da margem do
--     próprio plano aparece com as duas casas ("37,73%"). Pior: em 273 o número está nas falas que a
--     vendedora diz AO CLIENTE (pergunta de implicação, transição, resposta a objeção) e em 294 a IA trata
--     a margem da Colacor como se fosse a do cliente ("sua margem de 40,97%").
--   Fechar coluna não resolve o texto; por isso esta migration tem duas metades.
--
-- Esta migration é ADITIVA para leitura: nenhuma tela perde coluna. A B (20261015120100) é a que fecha
-- as três colunas para authenticated.
-- ORDEM DE APPLY: (1) deploy da edge generate-tactical-plan nova (chat do Lovable — o prompt para de
-- receber a margem) → (2) esta → (3) Publish do front que lê a margem do plano pela RPC → (4) ADOÇÃO do
-- build novo pelo staff (build_id, analytics.md §6) → (5) a B.
-- (1) antes de (2) não é obrigatório: o trigger daqui saneia o que a edge velha gravar. É preferível
-- porque o saneador remove frases inteiras, e a edge nova nem as produz.
--
-- Metade 1 — RPC public.get_planos_margem(uuid[]):
--   · escopo de LINHA idêntico a tactical_plans_select_staff (master OR employee) — não alarga nem estreita;
--   · o NÚMERO (as 2 margens e os cenários) só sai sob private.cap_custo_ler; os demais recebem NULL com
--     margem_visivel=false, que o front distingue de "não apurada" (NULL com margem_visivel=true);
--   · sem ids → zero linhas (não é via de dump); saída ordenada por id, nunca pela margem.
--
-- Metade 2 — saneamento do texto:
--   · private.sanear_texto_margem(text): parte o texto em frases e remove a frase que tem um número com
--     unidade de margem (`%`, "por cento", "pontos", "p.p.") E fala de margem/rentabilidade/lucro/
--     cluster/pares — e também a frase seguinte, se ela tiver número com unidade ("…a média dos pares é
--     55%. A sua está em 37%."). Texto sem frase removida volta BYTE A BYTE igual. Campo que fica vazio
--     vira um aviso, para a tela não mostrar um campo em branco como se a IA não tivesse escrito nada.
--     "p.p." vira "pp" antes de partir (senão o ponto da abreviação separa o número da palavra).
--     Medido em prod com a regra exata (só agregados, 2026-10-15): remove 1.699 de 35.922 frases (4,7%);
--     34 dos 35 planos vivos têm ao menos uma frase removida. Resíduo nos dois detectores independentes:
--     valor literal da margem do próprio plano ou dos pares com 2 casas ("37,73") 551 → 0; "margem|cluster|
--     pares" a ≤80 caracteres de N%/pp, nos dois sentidos, 916 → 0 planos (é o POS8 abaixo).
--   · private.sanear_jsonb_margem(jsonb): a mesma regra em cada folha string (perguntas, objeções, riscos);
--     número, booleano e estrutura ficam intactos (a `probability` da objeção não é texto).
--   · trigger BEFORE INSERT/UPDATE: toda gravação passa pelo saneador, qualquer que seja o writer
--     (criar_plano_tatico pelo browser ou pelas edges, edge velha ainda no ar, writer futuro).
--   · backup: o texto ORIGINAL dos planos alterados vai para private.farmer_tactical_plans_texto_original
--     (sem GRANT para authenticated/anon, RLS ligada sem policy) ANTES do UPDATE — nada se perde, e só
--     quem administra o banco o lê. FK com ON DELETE CASCADE: apagar o plano (ex.: eliminação LGPD do
--     cliente) apaga o backup junto.
--
-- O que NÃO muda: o objetivo estratégico (selectObjective) e o perfil (classifyProfile) seguem decididos
-- pela margem NO SERVIDOR — são o sinal ("o número fecha, o sinal fica"). customer_profile e
-- strategic_objective revelam só a faixa (ex.: consolidacao_margem ⇔ margem < 0,8 × pares).
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>` (o executor fornece a
-- transação); no SQL Editor, envolver em BEGIN; … COMMIT;.

DO $pre$
BEGIN
  IF to_regclass('public.farmer_tactical_plans') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.farmer_tactical_plans ausente';
  END IF;
  IF to_regprocedure('private.cap_custo_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.cap_custo_ler(uuid) ausente';
  END IF;
  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.has_role(uuid, app_role) ausente';
  END IF;
END
$pre$;

-- ═══════════════════════════ Metade 2 — saneador ═══════════════════════════

CREATE OR REPLACE FUNCTION private.sanear_texto_margem(p_texto text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  -- Fala de margem. `\mpares\M` com borda de palavra: "comparação" não conta.
  c_contexto constant text := '(margem|margens|rentabil|lucrativ|lucro|cluster|\mpares\M)';
  -- Número com unidade de margem. "36 categorias" e "R$ 8.070" não casam; "9,3 pp", "~19pp", "4 p.p." e
  -- "14 pontos percentuais" casam.
  c_numero   constant text := '[0-9]+([.,][0-9]+)?\s*(%|por cento|pontos?|p\.?\s?p(\M|\.))';
  v_frase        text;
  v_saida        text[] := '{}';
  v_tirou        boolean := false;
  v_anterior_fala boolean := false;
  v_fala         boolean;
  v_tem_numero   boolean;
BEGIN
  -- Sem dígito não há número a remover: devolve o texto como veio (inclusive NULL e '').
  IF p_texto IS NULL OR p_texto !~ '[0-9]' THEN
    RETURN p_texto;
  END IF;

  -- "p.p." vira "pp" ANTES de partir em frases: o ponto da abreviação partia "Recuperar 4 p.p. de margem"
  -- em duas frases, uma com o número sem a palavra e outra com a palavra sem o número — e nenhuma caía
  -- (achado do harness; os detectores da medição tinham a mesma cegueira). Só afeta a saída quando alguma
  -- frase cai; sem queda o texto volta como veio.
  FOREACH v_frase IN ARRAY regexp_split_to_array(regexp_replace(p_texto, '\mp\.\s?p\.', 'pp', 'gi'), '(?<=[.!?;])\s+') LOOP
    v_tem_numero := v_frase ~* c_numero;
    v_fala := v_tem_numero AND v_frase ~* c_contexto;
    -- A frase cai se fala de margem com número, ou se tem número com unidade logo depois de uma que
    -- falava ("…a média dos pares é 55%. A sua está em 37%."). A contiguidade é de UM passo, contra a
    -- frase anterior ORIGINAL — é a regra que foi medida em prod.
    IF v_fala OR (v_tem_numero AND v_anterior_fala) THEN
      v_tirou := true;
    ELSE
      v_saida := v_saida || v_frase;
    END IF;
    v_anterior_fala := v_fala;
  END LOOP;

  IF NOT v_tirou THEN
    RETURN p_texto;  -- byte a byte: a rejunção abaixo normalizaria espaços e quebras de linha
  END IF;
  IF cardinality(v_saida) = 0 THEN
    RETURN '[trecho removido: citava a margem]';
  END IF;
  RETURN array_to_string(v_saida, ' ');
END;
$function$;

CREATE OR REPLACE FUNCTION private.sanear_jsonb_margem(p_valor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_saida jsonb;
BEGIN
  CASE jsonb_typeof(p_valor)
    WHEN 'string' THEN
      RETURN to_jsonb(private.sanear_texto_margem(p_valor #>> '{}'));
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(private.sanear_jsonb_margem(e.valor) ORDER BY e.ordem), '[]'::jsonb)
        INTO v_saida
        FROM jsonb_array_elements(p_valor) WITH ORDINALITY AS e(valor, ordem);
      RETURN v_saida;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(o.chave, private.sanear_jsonb_margem(o.valor)), '{}'::jsonb)
        INTO v_saida
        FROM jsonb_each(p_valor) AS o(chave, valor);
      RETURN v_saida;
    ELSE
      -- número, booleano, null JSON e NULL SQL: não são texto, ficam como estão.
      RETURN p_valor;
  END CASE;
END;
$function$;

-- SECURITY DEFINER: o trigger roda para qualquer writer (definer das RPCs, service_role, writer futuro)
-- sem depender de cada um ter EXECUTE nas funções de private.
CREATE OR REPLACE FUNCTION private.tactical_plan_saneia_margem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  NEW.approach_strategy    := private.sanear_texto_margem(NEW.approach_strategy);
  NEW.approach_strategy_b  := private.sanear_texto_margem(NEW.approach_strategy_b);
  NEW.implication_question := private.sanear_texto_margem(NEW.implication_question);
  NEW.offer_transition     := private.sanear_texto_margem(NEW.offer_transition);
  NEW.diagnostic_questions := private.sanear_jsonb_margem(NEW.diagnostic_questions);
  NEW.probable_objections  := private.sanear_jsonb_margem(NEW.probable_objections);
  NEW.operational_risks    := private.sanear_jsonb_margem(NEW.operational_risks);
  RETURN NEW;
END;
$function$;

-- ACL: o default privileges concede EXECUTE a anon/authenticated (e authenticated tem USAGE em private).
-- São funções puras, mas não há motivo para expô-las.
REVOKE ALL ON FUNCTION private.sanear_texto_margem(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sanear_jsonb_margem(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tactical_plan_saneia_margem() FROM PUBLIC, anon, authenticated;

-- O trigger nasce ANTES do backfill: o CREATE TRIGGER trava a tabela contra INSERT concorrente até o
-- commit, então nenhum plano gravado pelo batch durante o apply escapa entre o UPDATE e o trigger.
CREATE OR REPLACE TRIGGER trg_tactical_plan_saneia_margem
  BEFORE INSERT OR UPDATE OF approach_strategy, approach_strategy_b, implication_question, offer_transition,
                             diagnostic_questions, probable_objections, operational_risks
  ON public.farmer_tactical_plans
  FOR EACH ROW EXECUTE FUNCTION private.tactical_plan_saneia_margem();

-- ═══════════════════════════ backup + saneamento do histórico ═══════════════════════════

CREATE TABLE IF NOT EXISTS private.farmer_tactical_plans_texto_original (
  plan_id              uuid PRIMARY KEY REFERENCES public.farmer_tactical_plans(id) ON DELETE CASCADE,
  approach_strategy    text,
  approach_strategy_b  text,
  implication_question text,
  offer_transition     text,
  diagnostic_questions jsonb,
  probable_objections  jsonb,
  operational_risks    jsonb,
  guardado_em          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE private.farmer_tactical_plans_texto_original IS
  'Texto ORIGINAL dos planos táticos antes do saneamento de margem (FU4-F, 20261015120000). '
  'Sem GRANT para authenticated/anon: o texto cita a margem bruta por cliente.';
ALTER TABLE private.farmer_tactical_plans_texto_original ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.farmer_tactical_plans_texto_original FROM PUBLIC, anon, authenticated;

-- ON CONFLICT DO NOTHING: re-aplicar não sobrescreve o original com o texto já saneado.
INSERT INTO private.farmer_tactical_plans_texto_original (
  plan_id, approach_strategy, approach_strategy_b, implication_question, offer_transition,
  diagnostic_questions, probable_objections, operational_risks
)
SELECT p.id, p.approach_strategy, p.approach_strategy_b, p.implication_question, p.offer_transition,
       p.diagnostic_questions, p.probable_objections, p.operational_risks
  FROM public.farmer_tactical_plans p
 WHERE p.approach_strategy    IS DISTINCT FROM private.sanear_texto_margem(p.approach_strategy)
    OR p.approach_strategy_b  IS DISTINCT FROM private.sanear_texto_margem(p.approach_strategy_b)
    OR p.implication_question IS DISTINCT FROM private.sanear_texto_margem(p.implication_question)
    OR p.offer_transition     IS DISTINCT FROM private.sanear_texto_margem(p.offer_transition)
    OR p.diagnostic_questions IS DISTINCT FROM private.sanear_jsonb_margem(p.diagnostic_questions)
    OR p.probable_objections  IS DISTINCT FROM private.sanear_jsonb_margem(p.probable_objections)
    OR p.operational_risks    IS DISTINCT FROM private.sanear_jsonb_margem(p.operational_risks)
ON CONFLICT (plan_id) DO NOTHING;

-- `updated_at` fica como está: o plano não mudou de conteúdo comercial, só perdeu o número.
UPDATE public.farmer_tactical_plans p
   SET approach_strategy    = private.sanear_texto_margem(p.approach_strategy),
       approach_strategy_b  = private.sanear_texto_margem(p.approach_strategy_b),
       implication_question = private.sanear_texto_margem(p.implication_question),
       offer_transition     = private.sanear_texto_margem(p.offer_transition),
       diagnostic_questions = private.sanear_jsonb_margem(p.diagnostic_questions),
       probable_objections  = private.sanear_jsonb_margem(p.probable_objections),
       operational_risks    = private.sanear_jsonb_margem(p.operational_risks)
 WHERE p.id IN (SELECT o.plan_id FROM private.farmer_tactical_plans_texto_original o);

-- ═══════════════════════════ Metade 1 — RPC com gate de projeção ═══════════════════════════

CREATE OR REPLACE FUNCTION public.get_planos_margem(p_plan_ids uuid[])
RETURNS TABLE(plan_id uuid, current_margin_pct numeric, cluster_avg_margin_pct numeric,
              expected_result jsonb, margem_visivel boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid      uuid;
  v_pode_num boolean;
BEGIN
  -- Atribuição no CORPO (erro em DECLARE não é capturável pelo bloco).
  v_uid := (SELECT auth.uid());

  -- Fail-closed: sem identidade ou sem ids, zero linhas.
  IF v_uid IS NULL OR p_plan_ids IS NULL THEN
    RETURN;
  END IF;

  -- Escopo de LINHA = tactical_plans_select_staff. SECURITY DEFINER pula a RLS, então a policy é
  -- reproduzida aqui; quem não é staff não recebe linha nenhuma.
  IF NOT (public.has_role(v_uid, 'master'::public.app_role) OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RETURN;
  END IF;

  v_pode_num := COALESCE(private.cap_custo_ler(v_uid), false);

  RETURN QUERY
  SELECT p.id,
         -- Gate de PROJEÇÃO: esconde na SAÍDA. Os cenários de margem são projeção do mesmo número.
         CASE WHEN v_pode_num THEN p.current_margin_pct END,
         CASE WHEN v_pode_num THEN p.cluster_avg_margin_pct END,
         CASE WHEN v_pode_num THEN p.expected_result END,
         v_pode_num
    FROM public.farmer_tactical_plans p
   WHERE p.id = ANY (p_plan_ids)
   ORDER BY p.id;
END;
$function$;

COMMENT ON FUNCTION public.get_planos_margem(uuid[]) IS
  'Margem do cliente e média dos pares gravadas no plano tático (e os cenários de margem), no escopo de '
  'tactical_plans_select_staff. O número só sai sob private.cap_custo_ler; os demais recebem NULL com '
  'margem_visivel=false. Substitui a leitura direta das colunas, que a 20261015120100 fecha (FU4-F).';

-- ACL: o Supabase concede EXECUTE por NOME a anon (default privileges) — REVOKE das DUAS pontas.
REVOKE ALL ON FUNCTION public.get_planos_margem(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_planos_margem(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_planos_margem(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_planos_margem(uuid[]) TO service_role;

DO $pos$
DECLARE
  v_def text;
  v_n   int;
BEGIN
  IF to_regprocedure('public.get_planos_margem(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: public.get_planos_margem(uuid[]) nao existe';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_planos_margem(uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'POS2 FALHOU: get_planos_margem nao e SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.get_planos_margem(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS3 FALHOU: anon executa get_planos_margem';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_planos_margem(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS4 FALHOU: authenticated nao executa get_planos_margem - as telas ficariam sem margem';
  END IF;
  v_def := pg_get_functiondef('public.get_planos_margem(uuid[])'::regprocedure);
  IF position('cap_custo_ler' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POS5 FALHOU: o corpo de get_planos_margem perdeu o gate de projecao';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.farmer_tactical_plans'::regclass
                    AND tgname = 'trg_tactical_plan_saneia_margem' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POS6 FALHOU: trigger de saneamento ausente ou desligado';
  END IF;
  IF has_table_privilege('authenticated', 'private.farmer_tactical_plans_texto_original', 'SELECT')
     OR has_table_privilege('anon', 'private.farmer_tactical_plans_texto_original', 'SELECT') THEN
    RAISE EXCEPTION 'POS7 FALHOU: o backup do texto original e legivel por authenticated/anon';
  END IF;
  -- Resíduo: nenhuma folha de texto pode seguir com "margem|cluster|pares" a ≤80 caracteres de N%/pp.
  -- Detector diferente da regra do saneador (que é por frase), para não ser tautologia; por FOLHA (cada
  -- campo e cada string dos jsonb) para não casar através da fronteira entre duas strings do JSON.
  SELECT count(DISTINCT p.id) INTO v_n
    FROM public.farmer_tactical_plans p
   CROSS JOIN LATERAL (
     SELECT unnest(ARRAY[p.approach_strategy, p.approach_strategy_b, p.implication_question, p.offer_transition]) AS t
     UNION ALL
     SELECT f #>> '{}'
       FROM jsonb_path_query(coalesce(p.diagnostic_questions, '[]'::jsonb) || coalesce(p.probable_objections, '[]'::jsonb)
                             || coalesce(p.operational_risks, '[]'::jsonb), 'strict $.**') AS f
      WHERE jsonb_typeof(f) = 'string'
   ) folha
   -- "p.p." normalizado como no saneador: com o ponto, "4 p.p. de margem" escapa dos dois sentidos.
   WHERE regexp_replace(folha.t, '\mp\.\s?p\.', 'pp', 'gi')
         ~* '((margem|cluster|pares)[^.]{0,80}[0-9]+([.,][0-9]+)?\s*(%|pp|pontos)|[0-9]+([.,][0-9]+)?\s*(%|pp|pontos)[^.]{0,40}(margem|cluster|pares))';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POS8 FALHOU: % plano(s) seguem citando margem com numero apos o saneamento', v_n;
  END IF;
END
$pos$;
