
-- ============================================
-- GAMIFICATION SYSTEM TABLES
-- ============================================

-- 1. Sending quality logs (checklist de envio)
CREATE TABLE public.sending_quality_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  is_clean boolean NOT NULL DEFAULT false,
  is_separated boolean NOT NULL DEFAULT false,
  is_identified boolean NOT NULL DEFAULT false,
  is_properly_packed boolean NOT NULL DEFAULT false,
  score integer NOT NULL DEFAULT 0,
  evaluated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sending_quality_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own quality logs" ON public.sending_quality_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Staff can manage all quality logs" ON public.sending_quality_logs
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can view all quality logs" ON public.sending_quality_logs
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 2. Training modules
CREATE TABLE public.training_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  video_url text,
  quiz_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  min_score integer NOT NULL DEFAULT 60,
  points_reward integer NOT NULL DEFAULT 15,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.training_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active training modules" ON public.training_modules
  FOR SELECT USING (true);

CREATE POLICY "Only admins can manage training modules" ON public.training_modules
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3. Training completions
CREATE TABLE public.training_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  module_id uuid NOT NULL REFERENCES public.training_modules(id) ON DELETE CASCADE,
  quiz_score integer NOT NULL DEFAULT 0,
  passed boolean NOT NULL DEFAULT false,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, module_id)
);

ALTER TABLE public.training_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own completions" ON public.training_completions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own completions" ON public.training_completions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff can view all completions" ON public.training_completions
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 4. Referrals
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  referred_email text NOT NULL,
  referred_user_id uuid,
  status text NOT NULL DEFAULT 'pending',
  points_awarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz
);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own referrals" ON public.referrals
  FOR SELECT USING (auth.uid() = referrer_id);

CREATE POLICY "Users can create their own referrals" ON public.referrals
  FOR INSERT WITH CHECK (auth.uid() = referrer_id);

CREATE POLICY "Staff can manage all referrals" ON public.referrals
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can view all referrals" ON public.referrals
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 5. Gamification scores (cached/computed)
CREATE TABLE public.gamification_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  consistency_score numeric NOT NULL DEFAULT 0,
  organization_score numeric NOT NULL DEFAULT 0,
  education_score numeric NOT NULL DEFAULT 0,
  referral_score numeric NOT NULL DEFAULT 0,
  efficiency_score numeric NOT NULL DEFAULT 0,
  total_score numeric NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 1,
  level_name text NOT NULL DEFAULT 'Operacional',
  tool_health_index numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gamification_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own gamification score" ON public.gamification_scores
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all gamification scores" ON public.gamification_scores
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can manage all gamification scores" ON public.gamification_scores
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Users should be able to upsert their own score (computed client-side or via function)
CREATE POLICY "Users can upsert their own score" ON public.gamification_scores
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own score" ON public.gamification_scores
  FOR UPDATE USING (auth.uid() = user_id);
