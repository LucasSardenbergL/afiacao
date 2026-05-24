
-- Table for default pricing rules
CREATE TABLE public.default_prices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tool_category_id UUID REFERENCES public.tool_categories(id),
  spec_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  price NUMERIC NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.default_prices ENABLE ROW LEVEL SECURITY;

-- Anyone can read prices
CREATE POLICY "Anyone can view default prices"
  ON public.default_prices FOR SELECT
  USING (true);

-- Only admins can manage
CREATE POLICY "Only admins can manage default prices"
  ON public.default_prices FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Trigger for updated_at
CREATE TRIGGER update_default_prices_updated_at
  BEFORE UPDATE ON public.default_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
