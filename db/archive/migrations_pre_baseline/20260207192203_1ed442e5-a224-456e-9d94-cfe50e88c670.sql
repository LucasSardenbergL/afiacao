-- Create enum for user roles
CREATE TYPE public.app_role AS ENUM ('admin', 'employee', 'customer');

-- Create user_roles table (following security best practices - never store roles on profiles)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'customer',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Function to get user role
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id UUID)
RETURNS app_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1
$$;

-- RLS policies for user_roles
CREATE POLICY "Users can view their own roles"
ON public.user_roles
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins and employees can view all roles"
ON public.user_roles
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Only admins can manage roles"
ON public.user_roles
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Store master company CNPJ configuration
CREATE TABLE public.company_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on company_config
ALTER TABLE public.company_config ENABLE ROW LEVEL SECURITY;

-- Insert master CNPJ (Colacor S.C)
INSERT INTO public.company_config (key, value) VALUES 
  ('master_cnpj', '55555305000151');

-- RLS policies for company_config
CREATE POLICY "Anyone can read company config"
ON public.company_config
FOR SELECT
USING (true);

CREATE POLICY "Only admins can manage company config"
ON public.company_config
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Add employee_omie_tag to track which tag identifies employees
INSERT INTO public.company_config (key, value) VALUES 
  ('employee_omie_tag', 'FUNCIONARIO');

-- Add is_employee and employee_code to profiles for employees
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS is_employee BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS employee_code TEXT;

-- Create trigger to auto-assign role when profile is created
CREATE OR REPLACE FUNCTION public.auto_assign_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  master_cnpj_value TEXT;
  profile_doc TEXT;
BEGIN
  -- Get master CNPJ from config
  SELECT value INTO master_cnpj_value FROM public.company_config WHERE key = 'master_cnpj';
  
  -- Get profile document (clean)
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  
  -- Check if this is the master account
  IF profile_doc = master_cnpj_value THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on profiles
CREATE TRIGGER on_profile_created_assign_role
AFTER INSERT ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.auto_assign_user_role();

-- Update trigger for when is_employee changes
CREATE TRIGGER on_profile_updated_assign_role
AFTER UPDATE OF is_employee, document ON public.profiles
FOR EACH ROW
WHEN (OLD.is_employee IS DISTINCT FROM NEW.is_employee OR OLD.document IS DISTINCT FROM NEW.document)
EXECUTE FUNCTION public.auto_assign_user_role();

-- Add policies for employees to manage orders
CREATE POLICY "Employees can view all orders"
ON public.orders
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Employees can update all orders"
ON public.orders
FOR UPDATE
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- Add policies for employees to manage user tools
CREATE POLICY "Employees can view all user tools"
ON public.user_tools
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Employees can manage all user tools"
ON public.user_tools
FOR ALL
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'))
WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- Add policies for employees to view all profiles
CREATE POLICY "Employees can view all profiles"
ON public.profiles
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- Add policies for employees to view all addresses  
CREATE POLICY "Employees can view all addresses"
ON public.addresses
FOR SELECT
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));