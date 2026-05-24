
-- Create recurring_schedules table
CREATE TABLE public.recurring_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  tool_ids uuid[] NOT NULL DEFAULT '{}',
  frequency_days integer NOT NULL DEFAULT 30,
  delivery_option text NOT NULL DEFAULT 'retirada',
  time_slot text,
  address_id uuid REFERENCES public.addresses(id),
  next_order_date date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.recurring_schedules ENABLE ROW LEVEL SECURITY;

-- Users can view their own schedules
CREATE POLICY "Users can view their own schedules"
  ON public.recurring_schedules FOR SELECT
  USING (auth.uid() = user_id);

-- Users can create their own schedules
CREATE POLICY "Users can create their own schedules"
  ON public.recurring_schedules FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own schedules
CREATE POLICY "Users can update their own schedules"
  ON public.recurring_schedules FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own schedules
CREATE POLICY "Users can delete their own schedules"
  ON public.recurring_schedules FOR DELETE
  USING (auth.uid() = user_id);

-- Staff can view all schedules
CREATE POLICY "Staff can view all schedules"
  ON public.recurring_schedules FOR SELECT
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

-- Service role policy for the edge function (uses service role key)
CREATE POLICY "Service role can manage all schedules"
  ON public.recurring_schedules FOR ALL
  USING (true)
  WITH CHECK (true);

-- updated_at trigger
CREATE TRIGGER update_recurring_schedules_updated_at
  BEFORE UPDATE ON public.recurring_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
