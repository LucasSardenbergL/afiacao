-- Bucket privado para PDFs/imagens de promoções
INSERT INTO storage.buckets (id, name, public)
VALUES ('promocoes', 'promocoes', false)
ON CONFLICT (id) DO NOTHING;

-- Staff (admin/manager/employee) pode ler arquivos do bucket
DROP POLICY IF EXISTS "Staff lê promocoes" ON storage.objects;
CREATE POLICY "Staff lê promocoes" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'promocoes' AND (
      has_role(auth.uid(), 'admin'::app_role)
      OR has_role(auth.uid(), 'manager'::app_role)
      OR has_role(auth.uid(), 'employee'::app_role)
    )
  );

-- Apenas service_role escreve (edge function)
DROP POLICY IF EXISTS "Service role escreve promocoes" ON storage.objects;
CREATE POLICY "Service role escreve promocoes" ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'promocoes');