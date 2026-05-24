-- Add column to track if address is synced from Omie
ALTER TABLE public.addresses 
ADD COLUMN is_from_omie boolean NOT NULL DEFAULT false;

-- Update existing "Principal" addresses to mark as from Omie
UPDATE public.addresses 
SET is_from_omie = true 
WHERE label = 'Principal' AND is_default = true;