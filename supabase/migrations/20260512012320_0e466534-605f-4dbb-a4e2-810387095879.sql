-- Create table to store WebAuthn challenges for server-side validation
CREATE TABLE public.webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security (access restricted to service_role via edge functions)
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

-- Add index for fast credential_id lookups
CREATE INDEX idx_webauthn_challenges_credential_id ON public.webauthn_challenges(credential_id);