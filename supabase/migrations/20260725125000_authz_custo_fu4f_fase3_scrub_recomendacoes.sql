-- FU4-F fase 3 / PR-B — scrub do histórico de recomendações + guarda anti-recontaminação
--
-- POR QUE EXISTE. O PR-B tira o custo do browser nos engines (a RPC get_skus_margem_positiva
-- responde "este SKU é vendável?" em vez de o cliente baixar product_costs). Mas parar de GRAVAR
-- só resolve o futuro: as linhas já persistidas continuam legíveis pela própria vendedora e
-- invertem para margem unitária.
--
-- RLS medida em prod (2026-07-21) — não é hipótese:
--   frec_select_carteira  ... USING (cap_carteira_ler(uid) OR farmer_id = uid OR ...)
--   fbrec_select_carteira ... idem
-- ou seja, `farmer_id = auth.uid()` basta: a vendedora lê as próprias linhas.
--
-- OS DOIS CAMINHOS DE INVERSÃO (o segundo foi achado pelo Codex na rodada 3; eu só tinha visto
-- o primeiro, e tratá-lo sozinho teria deixado o oráculo intacto):
--   1. m_ij ÷ cluster_volume_estimate = margem unitária.  (conferido em prod: 134,26/2 = 67,13)
--   2. m_ij ≈ lie / ((p_ij / 100) × complexity_factor)     ← o `lie` MONETÁRIO inverte sozinho.
-- Análogo em bundles: m_bundle ≈ lie_bundle / ((p_bundle/100) × complexity_factor), e
-- `bundle_products` guarda o custo LITERAL por SKU.
--
-- Por isso `m_ij` e `lie` (e `m_bundle`/`lie_bundle`) mudam JUNTOS. `cluster_volume_estimate`
-- fica: é contagem de compradores, não custo, e sem `m_ij` não há divisão que o torne oráculo.
--
-- POPULAÇÃO MEDIDA (prod, 2026-07-21):
--   farmer_recommendations        3.659 linhas, m_ij preenchido em 3.659, última 2026-05-12
--   farmer_bundle_recommendations    12 linhas, bundle_products com "cost" em 24/24 elementos
-- Ambas paradas há meses (o motor rodou quebrado até os consertos #1466/#1468/#1471). Nenhum
-- código LÊ m_ij/m_bundle — conferido por grep; o valor analítico não paga um segredo legível.
--
-- SEM TRIGGER NA TABELA (conferido: pg_trigger não tem trigger não-interno nas duas), então o
-- UPDATE não avança `updated_at` e não falsifica o frescor que o Sentinela observa.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Scrub do histórico
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.farmer_recommendations
SET m_ij = NULL,
    lie  = NULL           -- valor MONETÁRIO antigo; o motor novo regrava afinidade no recálculo
WHERE m_ij IS NOT NULL OR lie IS NOT NULL;

UPDATE public.farmer_bundle_recommendations
SET m_bundle   = NULL,
    lie_bundle = NULL
WHERE m_bundle IS NOT NULL OR lie_bundle IS NOT NULL;

-- bundle_products: remove as chaves "cost" e "margin" de cada elemento, preservando a ORDEM
-- (WITH ORDINALITY) e os demais campos (id/name/price — `price` é público, o cliente o vê).
UPDATE public.farmer_bundle_recommendations
SET bundle_products = (
      SELECT COALESCE(jsonb_agg(
               CASE WHEN jsonb_typeof(elem) = 'object' THEN elem - 'cost' - 'margin' ELSE elem END
               ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(bundle_products) WITH ORDINALITY AS t(elem, ord)
    )
WHERE jsonb_typeof(bundle_products) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(bundle_products) e
    WHERE jsonb_typeof(e) = 'object' AND (e ? 'cost' OR e ? 'margin')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Guarda anti-recontaminação
--
-- O scrub sozinho não basta: uma aba ANTIGA (bundle JS pré-Publish, ainda carregada no browser
-- de alguém) continua mandando m_ij/m_bundle/cost no payload e regravaria o que acabamos de
-- limpar — só que agora em linhas FRESCAS, que é pior. Omitir o campo no writer novo não protege
-- contra o writer velho.
--
-- Trigger que NULIFICA em vez de CHECK que rejeita: rejeitar quebraria o insert do frontend
-- velho com erro visível ao usuário; nulificar deixa a feature funcionar degradada e garante o
-- invariante. Fail-closed sem quebrar tela.
--
-- ⚠️ O trigger NÃO toca `lie`/`lie_bundle`: no desenho novo essas colunas guardam o score de
-- AFINIDADE (adimensional, legítimo) e nulificá-las mataria o ranking. Não há como distinguir
-- por VALOR um `lie` monetário do frontend velho de um score de afinidade — a heurística de
-- escala (afinidade ≤ 1) seria frágil demais para virar invariante de banco.
-- RESÍDUO DECLARADO: uma aba antiga ainda consegue gravar `lie` monetário + p_ij +
-- complexity_factor, que invertem para margem. A janela é curta (fecha no primeiro refresh após
-- o Publish) e some de vez quando não houver mais bundle antigo em cache.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.frec_sem_margem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
BEGIN
  NEW.m_ij := NULL;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION private.frec_sem_margem() IS
  'FU4-F fase 3: impede que a margem absoluta volte a farmer_recommendations (writer antigo em aba nao recarregada). Nulifica em vez de rejeitar para nao quebrar tela.';

DROP TRIGGER IF EXISTS trg_frec_sem_margem ON public.farmer_recommendations;
CREATE TRIGGER trg_frec_sem_margem
  BEFORE INSERT OR UPDATE ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem();

CREATE OR REPLACE FUNCTION private.fbrec_sem_margem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
BEGIN
  NEW.m_bundle := NULL;
  IF jsonb_typeof(NEW.bundle_products) = 'array' THEN
    NEW.bundle_products := (
      SELECT COALESCE(jsonb_agg(
               CASE WHEN jsonb_typeof(elem) = 'object' THEN elem - 'cost' - 'margin' ELSE elem END
               ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(NEW.bundle_products) WITH ORDINALITY AS t(elem, ord)
    );
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION private.fbrec_sem_margem() IS
  'FU4-F fase 3: impede que margem/custo por SKU voltem a farmer_bundle_recommendations (writer antigo). Nulifica m_bundle e remove as chaves cost/margin do jsonb.';

DROP TRIGGER IF EXISTS trg_fbrec_sem_margem ON public.farmer_bundle_recommendations;
CREATE TRIGGER trg_fbrec_sem_margem
  BEFORE INSERT OR UPDATE ON public.farmer_bundle_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.fbrec_sem_margem();

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO PÓS-APPLY (rodar no SQL Editor depois do bloco acima; esperado: tudo zero)
--
--   SELECT count(*) FILTER (WHERE m_ij IS NOT NULL) AS mij_restante,
--          count(*) FILTER (WHERE lie  IS NOT NULL) AS lie_restante
--   FROM public.farmer_recommendations;
--
--   SELECT count(*) FILTER (WHERE m_bundle   IS NOT NULL) AS mbundle_restante,
--          count(*) FILTER (WHERE lie_bundle IS NOT NULL) AS liebundle_restante
--   FROM public.farmer_bundle_recommendations;
--
--   SELECT count(*) AS chaves_custo_restantes
--   FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e
--   WHERE e ? 'cost' OR e ? 'margin';
--
-- E o teste do trigger (deve voltar NULL, não o valor gravado):
--   -- INSERT ... (m_ij) VALUES (99.99) RETURNING m_ij;   → NULL
-- ─────────────────────────────────────────────────────────────────────────────
