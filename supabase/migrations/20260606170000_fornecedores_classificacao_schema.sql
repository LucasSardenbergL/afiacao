-- Fase 1 — Fornecedores fora da carteira: schema de classificação + exceções (curadoria).
-- Identidade por user_id (omie_clientes é mal-modelado — não guarda empresa de forma confiável).
-- RLS: leitura staff; escrita da FLAG só service_role/RPC (employee NÃO altera a flag — P1 do Codex).
-- Idempotente (re-rodável): CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS antes de cada CREATE.

-- ============================================================
-- cliente_classificacao — fonte da verdade reversível (por user_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cliente_classificacao (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tags_omie            text[]      NOT NULL DEFAULT '{}',
  is_fornecedor        boolean     NOT NULL DEFAULT false,
  excluir_da_carteira  boolean     NOT NULL DEFAULT false,
  tem_venda_real       boolean     NOT NULL DEFAULT false,
  tags_synced_at       timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cliente_classificacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff read classificacao" ON public.cliente_classificacao;
CREATE POLICY "staff read classificacao" ON public.cliente_classificacao
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role)
      OR public.has_role(auth.uid(), 'employee'::public.app_role));

DROP POLICY IF EXISTS "service_role manage classificacao" ON public.cliente_classificacao;
CREATE POLICY "service_role manage classificacao" ON public.cliente_classificacao
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- fornecedor_excecao — curadoria do founder (fornecedor que É cliente real → fica)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fornecedor_excecao (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  motivo      text,
  criado_por  uuid,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fornecedor_excecao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff read excecao" ON public.fornecedor_excecao;
CREATE POLICY "staff read excecao" ON public.fornecedor_excecao
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role)
      OR public.has_role(auth.uid(), 'employee'::public.app_role));

DROP POLICY IF EXISTS "master manage excecao" ON public.fornecedor_excecao;
CREATE POLICY "master manage excecao" ON public.fornecedor_excecao
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role));

DROP POLICY IF EXISTS "service_role manage excecao" ON public.fornecedor_excecao;
CREATE POLICY "service_role manage excecao" ON public.fornecedor_excecao
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- Validação (cole no SQL Editor e confira: tabelas = 2)
-- ============================================================
SELECT 'MIGRATION A OK' AS status,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('cliente_classificacao', 'fornecedor_excecao')) AS tabelas;
