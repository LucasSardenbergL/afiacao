-- Add specifications column to user_tools table to store tool-specific details
ALTER TABLE public.user_tools 
ADD COLUMN IF NOT EXISTS specifications JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS generated_name TEXT;

-- Create table for tool specification options (predefined values for each tool type)
CREATE TABLE public.tool_specifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_category_id UUID REFERENCES tool_categories(id) ON DELETE CASCADE,
  spec_key TEXT NOT NULL, -- e.g., 'comprimento', 'largura', 'diametro', 'dentes', 'marca'
  spec_label TEXT NOT NULL, -- e.g., 'Comprimento', 'Largura', 'Diâmetro', 'Número de dentes', 'Marca'
  spec_type TEXT NOT NULL DEFAULT 'select', -- 'select', 'number', 'text'
  options JSONB, -- For select type: array of options e.g., ["até 120mm", "120mm a 300mm"]
  is_required BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tool_specifications ENABLE ROW LEVEL SECURITY;

-- Everyone can read specifications
CREATE POLICY "Anyone can read tool specifications"
ON public.tool_specifications
FOR SELECT
USING (true);

-- Only admins can manage specifications
CREATE POLICY "Only admins can manage specifications"
ON public.tool_specifications
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Insert specifications for Faca de Plaina Estreita
INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'comprimento', 'Comprimento', 'select', 
  '["até 120mm", "de 120mm a 300mm", "de 301mm a 450mm", "de 451mm a 600mm", "de 601mm a 700mm"]'::jsonb,
  1, true
FROM tool_categories WHERE name = 'Faca de Plaina (Estreita)';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'largura', 'Largura', 'select', '["30mm", "35mm"]'::jsonb, 2, true
FROM tool_categories WHERE name = 'Faca de Plaina (Estreita)';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'espessura', 'Espessura', 'select', '["3mm"]'::jsonb, 3, true
FROM tool_categories WHERE name = 'Faca de Plaina (Estreita)';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'marca', 'Marca', 'select', '["Indfema", "Fepam"]'::jsonb, 4, false
FROM tool_categories WHERE name = 'Faca de Plaina (Estreita)';

-- Insert specifications for Faca de Desengrosso
INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'comprimento', 'Comprimento', 'select', 
  '["até 120mm", "de 120mm a 300mm", "de 301mm a 450mm", "de 451mm a 600mm", "de 601mm a 700mm"]'::jsonb,
  1, true
FROM tool_categories WHERE name = 'Faca de Desengrosso';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'largura', 'Largura', 'select', '["75mm a 80mm"]'::jsonb, 2, true
FROM tool_categories WHERE name = 'Faca de Desengrosso';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'espessura', 'Espessura', 'select', '["9mm"]'::jsonb, 3, true
FROM tool_categories WHERE name = 'Faca de Desengrosso';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'marca', 'Marca', 'select', '["Indfema", "Fepam"]'::jsonb, 4, false
FROM tool_categories WHERE name = 'Faca de Desengrosso';

-- Insert specifications for Serra Circular de Widea
INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'diametro', 'Diâmetro', 'select', 
  '["110mm (4-3/8\")", "115mm (4-1/2\")", "120mm (4-3/4\")", "125mm (5\")", "140mm (5-1/2\")", "150mm (5-7/8\")", "160mm (6-1/4\")", "165mm (6-1/2\")", "180mm (7-1/4\")", "184mm (7-1/4\")", "190mm (7-1/2\")", "200mm (7-7/8\")", "210mm (8-1/4\")", "216mm (8-1/2\")", "225mm (8-7/8\")", "230mm (9\")", "235mm (9-1/4\")", "250mm (10\")", "254mm (10\")", "300mm (12\")", "305mm (12\")", "315mm (12-3/8\")", "350mm (14\")", "355mm (14\")", "400mm (16\")", "450mm (18\")", "500mm (20\")", "550mm (22\")", "600mm (24\")"]'::jsonb,
  1, true
FROM tool_categories WHERE name = 'Serra Circular de Widea';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'dentes', 'Número de dentes (Z)', 'select', 
  '["12", "14", "16", "18", "20", "24", "30", "32", "36", "40", "42", "44", "48", "50", "52", "56", "60", "64", "72", "80", "84", "90", "96", "100", "108", "120"]'::jsonb,
  2, true
FROM tool_categories WHERE name = 'Serra Circular de Widea';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'furo_central', 'Furo central (d)', 'select', 
  '["10mm", "16mm", "20mm", "22,23mm", "25mm", "25,4mm", "30mm", "31,75mm", "32mm", "35mm", "40mm", "50mm", "60mm"]'::jsonb,
  3, true
FROM tool_categories WHERE name = 'Serra Circular de Widea';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'marca', 'Marca', 'select', 
  '["Freud", "Leitz", "Kanefusa", "Fepam", "Makita", "DeWalt", "Skil", "Vonder", "MTX", "Sparta", "Indfema", "Dynamo", "Leuco", "KWS", "Gmad", "Leo"]'::jsonb,
  4, false
FROM tool_categories WHERE name = 'Serra Circular de Widea';

-- Insert specifications for Fresa
INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'dentes', 'Número de dentes (Z)', 'select', '["2", "3", "4", "5", "6", "8"]'::jsonb, 1, true
FROM tool_categories WHERE name = 'Fresa';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'espessura', 'Espessura da Fresa', 'select', 
  '["até 10mm", "10,1mm a 15mm", "15,1mm a 20mm", "20,1mm a 30mm", "30,1mm a 40mm", "40,1mm a 50mm", "50,1mm a 60mm", "60,1mm a 70mm", "70,1mm a 80mm", "80,1mm a 90mm", "90,1mm a 100mm", "100,1mm a 115mm", "200,1mm a 300mm"]'::jsonb,
  2, true
FROM tool_categories WHERE name = 'Fresa';

-- Insert specifications for Cabeçote Desintegrador
INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'dentes', 'Número de dentes (Z)', 'select', '["2", "3", "4", "5", "6", "8"]'::jsonb, 1, true
FROM tool_categories WHERE name = 'Cabeçote Desintegrador';

INSERT INTO tool_specifications (tool_category_id, spec_key, spec_label, spec_type, options, display_order, is_required)
SELECT id, 'espessura', 'Espessura do Cabeçote', 'select', 
  '["até 30mm", "30,1mm a 40mm", "40,1mm a 50mm", "50,1mm a 60mm", "60,1mm a 70mm", "70,1mm a 80mm", "80,1mm a 90mm", "90,1mm a 100mm", "100,1mm a 130mm", "130,1mm a 160mm", "160,1mm a 200mm"]'::jsonb,
  2, true
FROM tool_categories WHERE name = 'Cabeçote Desintegrador';

-- Create storage bucket for tool photos
INSERT INTO storage.buckets (id, name, public) VALUES ('tool-photos', 'tool-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for tool photos
CREATE POLICY "Anyone can view tool photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'tool-photos');

CREATE POLICY "Authenticated users can upload tool photos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'tool-photos' AND auth.role() = 'authenticated');

CREATE POLICY "Users can update their own tool photos"
ON storage.objects FOR UPDATE
USING (bucket_id = 'tool-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own tool photos"
ON storage.objects FOR DELETE
USING (bucket_id = 'tool-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Add photos column to orders items (will store as array of URLs in the items JSONB)
-- No migration needed as items is already JSONB

-- Create table for order price history (for automatic pricing)
CREATE TABLE public.order_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_tool_id UUID REFERENCES user_tools(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  unit_price NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.order_price_history ENABLE ROW LEVEL SECURITY;

-- Users can view their own price history
CREATE POLICY "Users can view their own price history"
ON public.order_price_history
FOR SELECT
USING (auth.uid() = user_id);

-- Staff can view all price history
CREATE POLICY "Staff can view all price history"
ON public.order_price_history
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- Staff can manage price history
CREATE POLICY "Staff can manage price history"
ON public.order_price_history
FOR ALL
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'))
WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));