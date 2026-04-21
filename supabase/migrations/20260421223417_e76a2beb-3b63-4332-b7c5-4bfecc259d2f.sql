CREATE TABLE IF NOT EXISTS public.fornecedor_mapeamento_extracao (
  id bigserial PRIMARY KEY,
  alias_extraido text NOT NULL,
  nome_canonico text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fornecedor_mapeamento_extracao_alias_unique
  ON public.fornecedor_mapeamento_extracao (lower(alias_extraido));

ALTER TABLE public.fornecedor_mapeamento_extracao ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Mapeamento fornecedor visível para staff"
  ON public.fornecedor_mapeamento_extracao
  FOR SELECT
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
  );

CREATE POLICY "Admins gerenciam mapeamento fornecedor"
  ON public.fornecedor_mapeamento_extracao
  FOR ALL
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  )
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  );

INSERT INTO public.fornecedor_mapeamento_extracao (alias_extraido, nome_canonico) VALUES
  ('sayerlack', 'RENNER SAYERLACK S/A'),
  ('renner sayerlack', 'RENNER SAYERLACK S/A'),
  ('renner', 'RENNER SAYERLACK S/A'),
  ('renner sayerlack s/a', 'RENNER SAYERLACK S/A'),
  ('renner sayerlack sa', 'RENNER SAYERLACK S/A')
ON CONFLICT (lower(alias_extraido)) DO NOTHING;