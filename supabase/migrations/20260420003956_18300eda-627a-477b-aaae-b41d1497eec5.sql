-- Tabela de histórico de mudanças na cadeia logística
CREATE TABLE IF NOT EXISTS public.fornecedor_cadeia_logistica_historico (
  id BIGSERIAL PRIMARY KEY,
  empresa TEXT NOT NULL,
  fornecedor_nome TEXT NOT NULL,
  etapa_id BIGINT,
  etapa_codigo TEXT,
  acao TEXT NOT NULL, -- 'criacao', 'edicao', 'desativacao', 'troca_parceiro', 'reordenacao'
  descricao_mudanca TEXT NOT NULL,
  valores_anteriores JSONB,
  valores_novos JSONB,
  alterado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadeia_hist_fornecedor ON public.fornecedor_cadeia_logistica_historico (empresa, fornecedor_nome, criado_em DESC);

ALTER TABLE public.fornecedor_cadeia_logistica_historico ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff pode ler historico cadeia" ON public.fornecedor_cadeia_logistica_historico
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'employee'));

CREATE POLICY "Admin pode inserir historico cadeia" ON public.fornecedor_cadeia_logistica_historico
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'manager'));