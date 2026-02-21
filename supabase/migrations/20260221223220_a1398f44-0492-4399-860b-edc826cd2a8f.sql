
-- Drop the overly permissive service role policy
DROP POLICY "Service role can manage all schedules" ON public.recurring_schedules;
