-- Migration: registro de VENDA PERDIDA + classificação Syntetos-Boylan advisory.
-- ⚠️ NÃO auto-aplica (nome custom) — colar no SQL Editor do Lovable.
--
-- (1) venda_perdida_log — a série que NÃO EXISTE hoje e que o challenge do Codex (2026-07-30)
--     apontou como lacuna P0 da análise de serviço: demanda censurada por indisponibilidade.
--     Registro MANUAL de staff ("cliente pediu e não tinha"); nenhum consumo automático no motor
--     (o valor é acumular a série; análises vêm depois, com meses de dado).
-- (2) v_sku_classe_sb — quadrantes Syntetos-Boylan (ADI × CV² dos tamanhos de venda diários,
--     cutoffs canônicos 1,32/0,49) sobre a demanda consolidada. ADVISORY: não entra no motor;
--     medido 2026-07-30: zero SKUs "smooth" — carteira inteira intermitente (160) ou lumpy (73).

-- ── 1) venda_perdida_log ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_perdida_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por uuid,
  empresa text NOT NULL DEFAULT 'OBEN',
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  cliente_nome text,
  motivo text NOT NULL DEFAULT 'sem_estoque' CHECK (motivo IN ('sem_estoque', 'preco', 'prazo', 'outro')),
  observacao text
);
COMMENT ON TABLE public.venda_perdida_log IS
  'Demanda que NAO virou venda (registro manual de staff). Serie de censura p/ analises futuras de servico; sem consumo automatico no motor.';
CREATE INDEX IF NOT EXISTS idx_venda_perdida_emp_data ON public.venda_perdida_log (empresa, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_venda_perdida_sku ON public.venda_perdida_log (empresa, sku_codigo_omie);

ALTER TABLE public.venda_perdida_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venda_perdida_log FROM PUBLIC;
REVOKE ALL ON public.venda_perdida_log FROM anon;
REVOKE ALL ON public.venda_perdida_log FROM authenticated;
GRANT SELECT, INSERT ON public.venda_perdida_log TO authenticated;
GRANT ALL ON public.venda_perdida_log TO service_role;

DROP POLICY IF EXISTS venda_perdida_sel ON public.venda_perdida_log;
CREATE POLICY venda_perdida_sel ON public.venda_perdida_log
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
DROP POLICY IF EXISTS venda_perdida_ins ON public.venda_perdida_log;
CREATE POLICY venda_perdida_ins ON public.venda_perdida_log
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- ── 2) v_sku_classe_sb (advisory) ────────────────────────────────────────────────────────────
-- security_invoker=on EXPLÍCITO (e repetido em TODO replace — omitir RESETA e a view passaria a
-- ler como o OWNER, bypassando a RLS staff de venda_items_history; provado no PG17: com a cadeia
-- invoker, customer vê 0 linhas). OR REPLACE p/ apply idempotente no SQL Editor.
CREATE OR REPLACE VIEW public.v_sku_classe_sb
WITH (security_invoker = on) AS
WITH vendas AS (
  SELECT empresa, sku_codigo_omie, data_emissao::date AS dia, SUM(quantidade) AS q
  FROM public.v_venda_items_history_efetivo
  WHERE quantidade > 0
  GROUP BY empresa, sku_codigo_omie, data_emissao::date
), stats AS (
  SELECT empresa, sku_codigo_omie,
         COUNT(*) AS n_dias_venda,
         (MAX(dia) - MIN(dia))::numeric / NULLIF(COUNT(*) - 1, 0) AS adi,
         CASE WHEN AVG(q) > 0 THEN power(stddev_samp(q) / AVG(q), 2) END AS cv2
  FROM vendas
  GROUP BY empresa, sku_codigo_omie
  HAVING COUNT(*) >= 3
)
SELECT empresa, sku_codigo_omie, n_dias_venda,
       round(adi, 2) AS adi,
       round(cv2, 2) AS cv2,
       CASE
         WHEN adi < 1.32 AND cv2 < 0.49 THEN 'smooth'
         WHEN adi >= 1.32 AND cv2 < 0.49 THEN 'intermittent'
         WHEN adi < 1.32 AND cv2 >= 0.49 THEN 'erratic'
         ELSE 'lumpy'
       END AS quadrante
FROM stats
WHERE adi IS NOT NULL AND cv2 IS NOT NULL;

COMMENT ON VIEW public.v_sku_classe_sb IS
  'Quadrantes Syntetos-Boylan (ADI x CV2, cutoffs 1.32/0.49) por SKU — ADVISORY, nao alimenta o motor.';
GRANT SELECT ON public.v_sku_classe_sb TO authenticated;
GRANT SELECT ON public.v_sku_classe_sb TO service_role;
