-- PR4: Persistência de sessão de chamada
-- Estende farmer_calls com transcript, análises do copilot, entidades extraídas
-- e metadados de auto-save (backend usado, telefone discado).

-- 1. Permite customer_user_id ser null (auto-save antes de vincular cliente)
ALTER TABLE public.farmer_calls
  ALTER COLUMN customer_user_id DROP NOT NULL;

-- 2. Novas colunas
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS transcript jsonb,
  ADD COLUMN IF NOT EXISTS analyses jsonb,
  ADD COLUMN IF NOT EXISTS entities_extracted jsonb,
  ADD COLUMN IF NOT EXISTS call_backend text,
  ADD COLUMN IF NOT EXISTS phone_dialed text;

-- 3. Constraint de check pro call_backend (valores permitidos)
ALTER TABLE public.farmer_calls
  DROP CONSTRAINT IF EXISTS farmer_calls_call_backend_check;
ALTER TABLE public.farmer_calls
  ADD CONSTRAINT farmer_calls_call_backend_check
    CHECK (call_backend IS NULL OR call_backend IN ('nvoip', 'webrtc', 'manual'));

-- 4. Index parcial: chamadas com transcript (consultas de copilot history)
CREATE INDEX IF NOT EXISTS idx_farmer_calls_has_transcript
  ON public.farmer_calls (farmer_id, started_at DESC)
  WHERE transcript IS NOT NULL;

-- 5. Comentários (documentação no banco)
COMMENT ON COLUMN public.farmer_calls.transcript IS
  'Array de TranscriptTurnLite: [{ speaker, text, isFinal, startedAt }]. Capturado do PR2 (Deepgram).';
COMMENT ON COLUMN public.farmer_calls.analyses IS
  'Array de SpinAnalysis snapshots ao longo da chamada (cada vez que useSpinAnalysis disparou). Capturado do PR3+PR3.5.';
COMMENT ON COLUMN public.farmer_calls.entities_extracted IS
  'Array deduplicado de ExtractedEntity agregando todas as análises. Pronto pra alimentar perfil 360 do cliente (PR5).';
COMMENT ON COLUMN public.farmer_calls.call_backend IS
  'Qual backend foi usado: nvoip | webrtc | manual.';
COMMENT ON COLUMN public.farmer_calls.phone_dialed IS
  'Telefone normalizado (dígitos apenas) que foi discado. Útil quando customer_user_id ainda é NULL.';
