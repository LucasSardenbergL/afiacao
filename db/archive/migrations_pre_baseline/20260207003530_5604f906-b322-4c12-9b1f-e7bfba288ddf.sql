-- Add customer_type field to profiles (industrial or domestic)
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS customer_type text DEFAULT 'domestic',
ADD COLUMN IF NOT EXISTS cnae text;

-- Create table for available tools/equipment types
CREATE TABLE public.tool_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  icon text,
  usage_type text NOT NULL DEFAULT 'domestic', -- 'industrial' or 'domestic' or 'both'
  suggested_interval_days integer DEFAULT 90, -- default sharpening interval
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tool_categories ENABLE ROW LEVEL SECURITY;

-- Anyone can view tool categories
CREATE POLICY "Anyone can view tool categories" 
ON public.tool_categories 
FOR SELECT 
USING (true);

-- Insert default tool categories
INSERT INTO public.tool_categories (name, description, icon, usage_type, suggested_interval_days) VALUES
('Facas de Cozinha', 'Facas chef, santoku, paring, etc.', 'chef-hat', 'both', 60),
('Tesouras', 'Tesouras domésticas e profissionais', 'scissors', 'both', 90),
('Tesouras de Cabelo', 'Tesouras para cabeleireiros', 'scissors', 'industrial', 30),
('Alicates de Cutícula', 'Alicates para manicure', 'hand', 'industrial', 30),
('Ferramentas de Jardinagem', 'Tesouras de poda, podões, etc.', 'flower', 'both', 120),
('Lâminas Industriais', 'Lâminas de corte industrial', 'factory', 'industrial', 45),
('Serras Circulares', 'Discos e serras circulares', 'circle', 'industrial', 60),
('Brocas', 'Brocas de metal e madeira', 'drill', 'both', 120),
('Formões e Plainas', 'Ferramentas de marcenaria', 'hammer', 'both', 90),
('Facas de Açougue', 'Facas profissionais de corte', 'beef', 'industrial', 14),
('Máquinas de Corte', 'Lâminas de máquinas de corte', 'cog', 'industrial', 30),
('Guilhotinas', 'Lâminas de guilhotinas', 'file', 'industrial', 60);

-- Create table for user's selected tools (their inventory)
CREATE TABLE public.user_tools (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  tool_category_id uuid NOT NULL REFERENCES public.tool_categories(id),
  custom_name text, -- optional custom description
  quantity integer DEFAULT 1,
  last_sharpened_at timestamp with time zone,
  next_sharpening_due timestamp with time zone,
  sharpening_interval_days integer, -- user can customize
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_tools ENABLE ROW LEVEL SECURITY;

-- Users can manage their own tools
CREATE POLICY "Users can view their own tools" 
ON public.user_tools 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own tools" 
ON public.user_tools 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tools" 
ON public.user_tools 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tools" 
ON public.user_tools 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create trigger for updating timestamps
CREATE TRIGGER update_user_tools_updated_at
BEFORE UPDATE ON public.user_tools
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add index for faster queries
CREATE INDEX idx_user_tools_user_id ON public.user_tools(user_id);
CREATE INDEX idx_user_tools_next_sharpening ON public.user_tools(next_sharpening_due);