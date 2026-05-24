ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS business_hours_open TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS business_hours_close TEXT DEFAULT NULL;