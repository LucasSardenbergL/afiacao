
-- Loyalty points table
CREATE TABLE public.loyalty_points (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  order_id uuid REFERENCES public.orders(id),
  points integer NOT NULL DEFAULT 0,
  type text NOT NULL DEFAULT 'earn', -- 'earn' or 'redeem'
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.loyalty_points ENABLE ROW LEVEL SECURITY;

-- Users can view their own points
CREATE POLICY "Users can view their own points"
  ON public.loyalty_points FOR SELECT
  USING (auth.uid() = user_id);

-- Staff can view all points
CREATE POLICY "Staff can view all points"
  ON public.loyalty_points FOR SELECT
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

-- Staff can manage points
CREATE POLICY "Staff can manage all points"
  ON public.loyalty_points FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

-- Users can insert their own earn records (for automatic earning on order completion)
CREATE POLICY "Users can earn points"
  ON public.loyalty_points FOR INSERT
  WITH CHECK (auth.uid() = user_id AND type = 'earn');

-- Trigger: auto-award points when order is delivered
CREATE OR REPLACE FUNCTION public.award_loyalty_points()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'entregue' AND OLD.status != 'entregue' THEN
    INSERT INTO public.loyalty_points (user_id, order_id, points, type, description)
    VALUES (
      NEW.user_id,
      NEW.id,
      GREATEST(FLOOR(NEW.total)::integer, 10),
      'earn',
      'Pontos por pedido entregue #' || LEFT(NEW.id::text, 8)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_award_loyalty_points
  AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.award_loyalty_points();
