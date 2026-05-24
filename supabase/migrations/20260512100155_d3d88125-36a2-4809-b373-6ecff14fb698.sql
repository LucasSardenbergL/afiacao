CREATE POLICY "No client access to webauthn_challenges"
ON public.webauthn_challenges
FOR ALL
TO authenticated, anon
USING (false)
WITH CHECK (false);