-- reposicao_pedidos_compra_run — marcador IMUTÁVEL de cada run completo do omie-sync-pedidos-compra.
-- Base de verdade da reconciliação de PO excluído (PR2/PR3): run_id, janela REAL consultada (anti-timezone),
-- contagem de POs distintos e volume_ok (circuit-breaker de cobertura). Insert-only (cada run = 1 linha nova).
-- NÃO confundir com sync_state('pedidos_compra_full'), que segue só para CADÊNCIA (quando rodar completo).
CREATE TABLE IF NOT EXISTS public.reposicao_pedidos_compra_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa         text NOT NULL,
  modo            text NOT NULL,
  janela_de       date NOT NULL,
  janela_ate      date NOT NULL,
  ids_distintos   integer NOT NULL DEFAULT 0,
  volume_baseline integer,             -- mediana dos últimos completos; NULL no bootstrap
  volume_ok       boolean,             -- NULL = desconhecido (sem baseline) → PR2/3 tratam como não-confiável
  status          text NOT NULL DEFAULT 'ok',
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  finalizado_em   timestamptz NOT NULL DEFAULT now()
);

-- Último run completo VÁLIDO por empresa (o que a reconciliação vai ancorar).
CREATE INDEX IF NOT EXISTS idx_reposicao_pcr_empresa_fim
  ON public.reposicao_pedidos_compra_run (empresa, finalizado_em DESC);

ALTER TABLE public.reposicao_pedidos_compra_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reposicao_pcr_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS reposicao_pcr_ins ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_ins ON public.reposicao_pedidos_compra_run
  FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.reposicao_pedidos_compra_run TO authenticated;
GRANT ALL    ON public.reposicao_pedidos_compra_run TO service_role;

-- Sinal single-writer: SÓ o omie-sync-pedidos-compra (modo completo) escreve. Imune ao updated_at multi-writer.
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_run_id uuid,
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_at     timestamptz;
