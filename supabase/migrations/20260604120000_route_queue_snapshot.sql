-- Painel das ligações da rota: persiste a FILA de elegíveis (denominador) que a
-- vendedora viu ao abrir /rota/ligacoes. Idempotente por (data_rota, farmer_id, customer).
CREATE TABLE IF NOT EXISTS public.route_queue_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_rota date NOT NULL,
  farmer_id uuid NOT NULL,                 -- o VISUALIZADOR (quem viu a lista)
  customer_user_id uuid NOT NULL,
  cidade text,
  bucket text,                             -- top/winback/coldstart (do ScoredCandidate)
  valor_da_ligacao numeric,                -- valor ESPERADO (score), não R$
  rank int,                                -- posição na fila no momento da abertura
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_rota, farmer_id, customer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_rqs_data ON public.route_queue_snapshot(data_rota);
CREATE INDEX IF NOT EXISTS idx_rqs_farmer_data ON public.route_queue_snapshot(farmer_id, data_rota);

ALTER TABLE public.route_queue_snapshot ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master) — mesmo critério do route_contact_log.
CREATE POLICY "rqs_staff_read" ON public.route_queue_snapshot FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
-- escrita: o próprio farmer grava a fila que ELE viu (farmer_id = auth.uid()), ou master.
CREATE POLICY "rqs_self_write" ON public.route_queue_snapshot FOR INSERT TO authenticated
  WITH CHECK (farmer_id = (select auth.uid())
              OR EXISTS (SELECT 1 FROM public.user_roles ur
                         WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));
