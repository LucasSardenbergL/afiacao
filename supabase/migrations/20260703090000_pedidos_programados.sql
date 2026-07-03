-- Pedidos programados (Lider): pool de itens extraídos do PDF do cliente → envios
-- agendados ao Omie. Spec: docs/superpowers/specs/2026-07-02-pedidos-programados-design.md
-- Todas as tabelas staff-only (money-path: gera pedido de venda no Omie).
-- Substitui 20260702120000_pedidos_programados.sql (nunca aplicada em nenhum ambiente):
-- migration commitada é imutável no repo → correção pós-review entrou como arquivo novo.
-- Transação única: o SQL Editor do Lovable roda o bloco como script — erro no meio
-- NÃO pode deixar estado parcial (ex.: tabela sem policy). Todo o DDL aqui é transacional.

BEGIN;

-- ── 1. Header: 1 linha por PDF ──
CREATE TABLE public.pedidos_programados (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_ref text NOT NULL DEFAULT 'lider',
  arquivo_path text NOT NULL,
  numero_pedido_compra text,
  versao text,
  data_emissao_cliente date,
  status text NOT NULL DEFAULT 'extraindo'
    CHECK (status IN ('extraindo','erro_extracao','ativo','concluido','cancelado')),
  erro_motivo text,
  extracao_bruta jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Envios: grupo de itens marcado pelo founder para envio numa data ──
CREATE TABLE public.pedidos_programados_envios (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_programado_id uuid NOT NULL REFERENCES public.pedidos_programados(id) ON DELETE CASCADE,
  data_envio date NOT NULL,
  status text NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado','enviado','erro','cancelado')),
  erro_motivo text,
  -- Map account → sales_order_id (jsonb p/ retry idempotente: reusa o MESMO
  -- sales_order → mesma chave PV_${id} no Omie; nunca duplica pedido).
  -- SINGLE-WRITER: apenas a edge pedido-programado-enviar escreve neste campo.
  sales_orders_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pp_envios_pendentes ON public.pedidos_programados_envios (data_envio)
  WHERE status = 'agendado';

-- ── 3. De-para memorizado + memória de preço ──
CREATE TABLE public.cliente_item_mapa (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_ref text NOT NULL DEFAULT 'lider',
  codigo_item_cliente text NOT NULL,
  omie_product_id uuid NOT NULL REFERENCES public.omie_products(id),
  ultimo_preco numeric CHECK (ultimo_preco IS NULL OR ultimo_preco > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_ref, codigo_item_cliente)
);

-- ── 4. Itens extraídos do PDF ──
CREATE TABLE public.pedidos_programados_itens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_programado_id uuid NOT NULL REFERENCES public.pedidos_programados(id) ON DELETE CASCADE,
  envio_id uuid REFERENCES public.pedidos_programados_envios(id) ON DELETE SET NULL,
  codigo_item_cliente text NOT NULL,
  num_ordem_cliente text,
  descricao_cliente text NOT NULL,
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  unidade text,
  data_entrega_cliente date,
  cod_forn text,
  preco_pdf numeric,
  -- Ausente ≠ zero: NULL bloqueia envio; nunca defaultar para 0.
  preco_final numeric CHECK (preco_final IS NULL OR preco_final > 0),
  mapa_id uuid REFERENCES public.cliente_item_mapa(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pp_itens_pedido ON public.pedidos_programados_itens (pedido_programado_id);
CREATE INDEX idx_pp_itens_envio ON public.pedidos_programados_itens (envio_id);

-- ── 5. Config por empresa (founder edita na UI) ──
CREATE TABLE public.pedidos_programados_config (
  account text NOT NULL PRIMARY KEY CHECK (account IN ('oben','colacor')),
  codigo_cliente_omie bigint,
  customer_user_id uuid,
  obs_venda text,
  dados_adicionais_nf text,
  codigo_parcela text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── RLS: staff-only em tudo ──
ALTER TABLE public.pedidos_programados        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_envios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_itens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_item_mapa          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY pp_staff_all ON public.pedidos_programados FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_envios_staff_all ON public.pedidos_programados_envios FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_itens_staff_all ON public.pedidos_programados_itens FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_mapa_staff_all ON public.cliente_item_mapa FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_config_staff_all ON public.pedidos_programados_config FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

-- ── updated_at triggers (função já existe no banco) ──
CREATE TRIGGER upd_pp        BEFORE UPDATE ON public.pedidos_programados        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_envios BEFORE UPDATE ON public.pedidos_programados_envios FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_itens  BEFORE UPDATE ON public.pedidos_programados_itens  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_mapa   BEFORE UPDATE ON public.cliente_item_mapa          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_config BEFORE UPDATE ON public.pedidos_programados_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Storage: bucket privado para os PDFs ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pedidos-programados', 'pedidos-programados', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY pp_storage_staff_select ON storage.objects FOR SELECT
  USING (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));
CREATE POLICY pp_storage_staff_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));
CREATE POLICY pp_storage_staff_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));

-- ── Seed da config (valores reais confirmados no banco em 2026-07-02) ──
INSERT INTO public.pedidos_programados_config
  (account, codigo_cliente_omie, customer_user_id, obs_venda, dados_adicionais_nf, codigo_parcela)
VALUES
  ('oben', 8689689628, '2ff308c9-d125-4e32-9033-6f46e88ef0b2',
   E'RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL\nE-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA.\nTRANSPORTADORA: Transporte próprio: Oben Comercio\nDeclaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\nCPF/CNPJ:___________________________________\nDATA DA ENTREGA:___/__/____\nNome/ASSINATURA:_________________________________________________',
   E'FORMA DE PGTO BOLETO\n\n-- --\nOperação contratada no âmbito do comércio eletrônico ou do telemarketing. As mercadorias comercializadas no âmbito do comércio eletrônico ou do telemarketing pelo E-Commerce não Vinculado deverão ser destinadas exclusivamente a consumidor final, ainda que contribuinte do imposto, não sendo aplicável às referidas operações o regime de substituição tributária. MERCADORIA DESTINADA A USO E CONSUMO, vedado o aproveitamento do crédito nos termos do inciso III do art. 70 do RICMS". E-PTA-RE Nº: 45.000035717-51.\nEntrega por ordem do destinatário descrita acima.',
   NULL),
  ('colacor', NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (account) DO NOTHING;

COMMIT;
