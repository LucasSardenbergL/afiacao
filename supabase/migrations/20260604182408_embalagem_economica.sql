-- Decisão de embalagem econômica (QT/GL) — v1.
-- Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
-- Pares de equivalência (cadastro manual) + preços (manual na v1; campos de captura prontos p/ Fase 2).

-- 1) Pares de equivalência de embalagem
CREATE TABLE IF NOT EXISTS public.sku_embalagem_equivalencia (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa          text NOT NULL,
  grupo_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  sku_codigo_omie  text NOT NULL,
  unidade_base     text NOT NULL,           -- ex.: 'QT'
  fator_para_base  numeric NOT NULL CHECK (fator_para_base > 0),  -- QT=1, GL=4
  fornecedor_nome  text,
  ativo            boolean NOT NULL DEFAULT true,
  vigente_desde    date NOT NULL DEFAULT CURRENT_DATE,
  vigente_ate      date,
  criado_por       text,
  criado_em        timestamptz NOT NULL DEFAULT now()
);

-- Cada SKU ativo pertence a no máximo um grupo (por empresa).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sku_emb_equiv_ativo
  ON public.sku_embalagem_equivalencia (empresa, sku_codigo_omie)
  WHERE ativo;

CREATE INDEX IF NOT EXISTS idx_sku_emb_equiv_grupo
  ON public.sku_embalagem_equivalencia (empresa, grupo_id) WHERE ativo;

ALTER TABLE public.sku_embalagem_equivalencia ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_sku_emb_equiv_select ON public.sku_embalagem_equivalencia
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_insert ON public.sku_embalagem_equivalencia
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_update ON public.sku_embalagem_equivalencia
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_delete ON public.sku_embalagem_equivalencia
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));

-- 2) Preços por embalagem (v1: fonte='manual_usuario'; demais campos prontos p/ Fase 2)
CREATE TABLE IF NOT EXISTS public.sku_preco_fornecedor_capturado (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa                  text NOT NULL,
  sku_codigo_omie          text NOT NULL,
  fornecedor_nome          text,
  preco                    numeric NOT NULL CHECK (preco > 0),
  moeda                    text NOT NULL DEFAULT 'BRL',
  preco_tipo               text NOT NULL DEFAULT 'liquido' CHECK (preco_tipo IN ('liquido','bruto')),
  capturado_em             timestamptz NOT NULL DEFAULT now(),
  fonte                    text NOT NULL CHECK (fonte IN ('manual_usuario','portal_capturado_ok','portal_capturado_parcial')),
  status                   text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','stale','falhou')),
  run_id                   text,
  validade_operacional_ate timestamptz,
  observacao               text,
  criado_por               text,
  criado_em                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_preco_cap_lookup
  ON public.sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, capturado_em DESC);

ALTER TABLE public.sku_preco_fornecedor_capturado ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_sku_preco_cap_select ON public.sku_preco_fornecedor_capturado
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_insert ON public.sku_preco_fornecedor_capturado
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_update ON public.sku_preco_fornecedor_capturado
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_delete ON public.sku_preco_fornecedor_capturado
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));

-- 3) Kill-switch + parâmetros em company_config (key/value text)
INSERT INTO public.company_config (key, value)
VALUES
  ('embalagem_captura_automatica_habilitada', 'false'),
  ('embalagem_preco_stale_horas', '24'),
  ('embalagem_limiar_economia_rs', '5')
ON CONFLICT (key) DO NOTHING;
