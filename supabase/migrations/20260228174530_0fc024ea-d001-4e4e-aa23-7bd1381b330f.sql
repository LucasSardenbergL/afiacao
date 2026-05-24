ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS lunch_start text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lunch_end text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS preferred_delivery_time text DEFAULT NULL;