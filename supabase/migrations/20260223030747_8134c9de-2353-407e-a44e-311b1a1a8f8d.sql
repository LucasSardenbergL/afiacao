
-- Table to track diagnostic questions usage and effectiveness
CREATE TABLE IF NOT EXISTS public.farmer_diagnostic_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bundle_recommendation_id uuid REFERENCES public.farmer_bundle_recommendations(id),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  question_type text NOT NULL, -- situacao, problema, implicacao, direcionamento
  question_text text NOT NULL,
  alt_question_text text, -- variação alternativa por perfil
  customer_profile text DEFAULT 'misto',
  response_type text, -- interesse, objecao, indiferenca
  response_notes text,
  was_bundle_offered boolean DEFAULT false,
  bundle_result text, -- aceito_total, aceito_parcial, rejeitado
  margin_generated numeric DEFAULT 0,
  time_spent_seconds integer DEFAULT 0,
  effectiveness_score numeric, -- calculated from outcomes
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.farmer_diagnostic_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage diagnostic questions"
  ON public.farmer_diagnostic_questions
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
