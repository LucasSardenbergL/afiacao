-- ⚠️ DESTINO: 🟣 SQL Editor do Lovable (colar → Run). NÃO é auto-aplicada. NÃO vai em supabase/migrations/
--    (essa pasta é a fonte de DR — o Lovable a materializa após o apply). Este arquivo é o registro
--    versionado + a fonte do bloco de handoff. Prova: db/test-omie-customer-account-map.sh (PG17, 14/0).
--
-- Fatia 3 (opção C) — tabela nova ADITIVA: mapa (user_id, account) -> código Omie do cliente naquela conta.
-- ADITIVA e REVERSÍVEL. NÃO toca omie_clientes (espelho poluído fica intocado). Populada por re-sync
-- Omie DOCUMENT-FIRST (casa por profiles.document, nunca por código cross-account).
-- Vocabulário account ∈ {'oben','colacor','colacor_sc'} = empresa_omie = account de customer_segments/preferred.
-- Design: docs/superpowers/specs/2026-07-07-espelho-omie-rotulo-por-conta-design.md

CREATE TABLE IF NOT EXISTS public.omie_customer_account_map (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account               text NOT NULL,
  omie_codigo_cliente   bigint NOT NULL,
  omie_codigo_vendedor  bigint,
  source                text NOT NULL DEFAULT 'document',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc')),
  CONSTRAINT chk_ocam_source  CHECK (source IN ('document','code','manual')),
  -- um código por (user, conta) e um dono por (código, conta) — impede colisão cross-account no CASAMENTO.
  CONSTRAINT uq_ocam_user_account   UNIQUE (user_id, account),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account)
);

-- lookup dos consumidores: por user_id (todas as contas do cliente). O reverse-map (código->user) e o
-- casamento (user,conta) já vêm dos UNIQUE acima.
CREATE INDEX IF NOT EXISTS idx_ocam_user ON public.omie_customer_account_map (user_id);

ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;

-- RLS espelha omie_clientes: staff (master/employee) gerencia tudo; o próprio user vê só a sua linha.
-- authenticated (não public) — anon nunca vê. Edge (service_role) bypassa RLS para o sync.
CREATE POLICY "Staff can manage account map"
  ON public.omie_customer_account_map FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Users can view their own account map"
  ON public.omie_customer_account_map FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
