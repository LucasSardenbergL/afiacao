
ALTER TABLE public.farmer_bundle_recommendations 
ADD COLUMN IF NOT EXISTS approach_type text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS argument_phone text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS argument_whatsapp text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS argument_technical text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS customer_profile text DEFAULT 'misto',
ADD COLUMN IF NOT EXISTS argument_effectiveness numeric DEFAULT NULL;
