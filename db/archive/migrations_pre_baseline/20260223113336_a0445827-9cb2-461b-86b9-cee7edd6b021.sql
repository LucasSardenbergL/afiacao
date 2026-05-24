
-- Add is_approved column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT false;

-- Auto-approve all existing users
UPDATE public.profiles SET is_approved = true;
