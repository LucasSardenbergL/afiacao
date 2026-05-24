-- Tabela para mapear clientes do app com clientes do Omie
CREATE TABLE public.omie_clientes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  omie_codigo_cliente BIGINT NOT NULL,
  omie_codigo_cliente_integracao TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_omie UNIQUE(user_id)
);

-- Tabela para mapear serviços do app com serviços do Omie
CREATE TABLE public.omie_servicos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  app_service_type TEXT NOT NULL, -- 'standard', 'premium', 'restoration', 'polishing'
  omie_codigo_servico BIGINT NOT NULL,
  omie_codigo_integracao TEXT,
  descricao TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT unique_service_type UNIQUE(app_service_type)
);

-- Tabela para registrar ordens de serviço enviadas ao Omie
CREATE TABLE public.omie_ordens_servico (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL,
  omie_numero_os TEXT NOT NULL,
  omie_codigo_os BIGINT,
  status TEXT NOT NULL DEFAULT 'enviado',
  payload_enviado JSONB,
  resposta_omie JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela de pedidos para persistir os pedidos do app
CREATE TABLE public.orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pedido_recebido',
  items JSONB NOT NULL DEFAULT '[]',
  service_type TEXT NOT NULL,
  delivery_option TEXT NOT NULL,
  address JSONB,
  time_slot TEXT,
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela de perfis de usuários
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  document TEXT, -- CPF/CNPJ
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela de endereços
CREATE TABLE public.addresses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  label TEXT NOT NULL,
  street TEXT NOT NULL,
  number TEXT NOT NULL,
  complement TEXT,
  neighborhood TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Habilitar RLS em todas as tabelas
ALTER TABLE public.omie_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omie_servicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omie_ordens_servico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;

-- Políticas para omie_clientes (admin pode tudo, usuário vê o seu)
CREATE POLICY "Users can view their own omie client mapping"
  ON public.omie_clientes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage omie clients"
  ON public.omie_clientes FOR ALL
  USING (true)
  WITH CHECK (true);

-- Políticas para omie_servicos (leitura pública para todos)
CREATE POLICY "Anyone can view omie services mapping"
  ON public.omie_servicos FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage omie services"
  ON public.omie_servicos FOR ALL
  USING (true)
  WITH CHECK (true);

-- Políticas para omie_ordens_servico
CREATE POLICY "Service role can manage omie os"
  ON public.omie_ordens_servico FOR ALL
  USING (true)
  WITH CHECK (true);

-- Políticas para orders
CREATE POLICY "Users can view their own orders"
  ON public.orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own orders"
  ON public.orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own orders"
  ON public.orders FOR UPDATE
  USING (auth.uid() = user_id);

-- Políticas para profiles
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Políticas para addresses
CREATE POLICY "Users can view their own addresses"
  ON public.addresses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own addresses"
  ON public.addresses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own addresses"
  ON public.addresses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own addresses"
  ON public.addresses FOR DELETE
  USING (auth.uid() = user_id);

-- Inserir serviços padrão (você precisará atualizar com os códigos reais do Omie)
INSERT INTO public.omie_servicos (app_service_type, omie_codigo_servico, omie_codigo_integracao, descricao) VALUES
  ('standard', 0, 'AFIACAO_PADRAO', 'Afiação Padrão'),
  ('premium', 0, 'AFIACAO_PREMIUM', 'Afiação Premium'),
  ('restoration', 0, 'RESTAURACAO', 'Recuperação/Restauração'),
  ('polishing', 0, 'POLIMENTO', 'Polimento/Acabamento');

-- Função para atualizar timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Triggers para atualizar timestamps
CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_omie_clientes_updated_at
  BEFORE UPDATE ON public.omie_clientes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_omie_ordens_servico_updated_at
  BEFORE UPDATE ON public.omie_ordens_servico
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();