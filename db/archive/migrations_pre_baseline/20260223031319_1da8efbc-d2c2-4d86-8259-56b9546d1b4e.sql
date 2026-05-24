
-- Copilot sessions: tracks each realtime copilot session during a call
CREATE TABLE public.farmer_copilot_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id UUID NOT NULL,
  customer_user_id UUID,
  call_id UUID REFERENCES public.farmer_calls(id),
  bundle_recommendation_id UUID REFERENCES public.farmer_bundle_recommendations(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  final_direction TEXT DEFAULT 'neutral',
  final_intent TEXT,
  final_phase TEXT,
  suggestions_shown INTEGER DEFAULT 0,
  suggestions_used INTEGER DEFAULT 0,
  result TEXT DEFAULT 'em_andamento',
  revenue_generated NUMERIC DEFAULT 0,
  margin_generated NUMERIC DEFAULT 0,
  transcript_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Copilot events: each detected intent, phase change, suggestion shown
CREATE TABLE public.farmer_copilot_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.farmer_copilot_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'intent', 'phase', 'suggestion', 'direction', 'objection'
  event_data JSONB DEFAULT '{}'::jsonb,
  transcript_snippet TEXT,
  suggestion_text TEXT,
  suggestion_used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE public.farmer_copilot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_copilot_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage copilot sessions" ON public.farmer_copilot_sessions
  FOR ALL USING (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  ) WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  );

CREATE POLICY "Staff can manage copilot events" ON public.farmer_copilot_events
  FOR ALL USING (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  ) WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  );
