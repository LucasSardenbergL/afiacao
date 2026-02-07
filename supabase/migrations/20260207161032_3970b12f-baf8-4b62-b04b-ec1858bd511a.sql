-- Create table to store WebAuthn credentials for biometric authentication
CREATE TABLE public.webauthn_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    device_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    last_used_at TIMESTAMP WITH TIME ZONE
);

-- Enable Row Level Security
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own credentials"
ON public.webauthn_credentials
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own credentials"
ON public.webauthn_credentials
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own credentials"
ON public.webauthn_credentials
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own credentials"
ON public.webauthn_credentials
FOR UPDATE
USING (auth.uid() = user_id);

-- Create index for faster lookups by credential_id
CREATE INDEX idx_webauthn_credentials_credential_id ON public.webauthn_credentials(credential_id);
CREATE INDEX idx_webauthn_credentials_user_id ON public.webauthn_credentials(user_id);