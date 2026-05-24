
-- Add internal_code to user_tools
ALTER TABLE public.user_tools ADD COLUMN internal_code TEXT UNIQUE;

-- Create a function to auto-generate internal codes
CREATE OR REPLACE FUNCTION public.generate_tool_internal_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  category_prefix TEXT;
  seq_num INTEGER;
  new_code TEXT;
BEGIN
  -- Get first 3 chars of category name uppercased
  SELECT UPPER(LEFT(REGEXP_REPLACE(name, '[^A-Za-z]', '', 'g'), 3))
  INTO category_prefix
  FROM public.tool_categories
  WHERE id = NEW.tool_category_id;

  IF category_prefix IS NULL OR category_prefix = '' THEN
    category_prefix := 'FER';
  END IF;

  -- Count existing tools in this category for sequential numbering
  SELECT COUNT(*) + 1
  INTO seq_num
  FROM public.user_tools
  WHERE tool_category_id = NEW.tool_category_id;

  new_code := category_prefix || '-' || LPAD(seq_num::TEXT, 4, '0');

  -- Handle uniqueness conflicts
  WHILE EXISTS (SELECT 1 FROM public.user_tools WHERE internal_code = new_code) LOOP
    seq_num := seq_num + 1;
    new_code := category_prefix || '-' || LPAD(seq_num::TEXT, 4, '0');
  END LOOP;

  NEW.internal_code := new_code;
  RETURN NEW;
END;
$function$;

-- Create trigger for auto-generating codes on insert
CREATE TRIGGER trg_generate_tool_code
  BEFORE INSERT ON public.user_tools
  FOR EACH ROW
  WHEN (NEW.internal_code IS NULL)
  EXECUTE FUNCTION public.generate_tool_internal_code();

-- Generate codes for existing tools that don't have one
DO $$
DECLARE
  tool_record RECORD;
  category_prefix TEXT;
  seq_num INTEGER;
  new_code TEXT;
BEGIN
  FOR tool_record IN 
    SELECT ut.id, ut.tool_category_id 
    FROM public.user_tools ut 
    WHERE ut.internal_code IS NULL
    ORDER BY ut.created_at
  LOOP
    SELECT UPPER(LEFT(REGEXP_REPLACE(name, '[^A-Za-z]', '', 'g'), 3))
    INTO category_prefix
    FROM public.tool_categories
    WHERE id = tool_record.tool_category_id;

    IF category_prefix IS NULL OR category_prefix = '' THEN
      category_prefix := 'FER';
    END IF;

    seq_num := 1;
    new_code := category_prefix || '-' || LPAD(seq_num::TEXT, 4, '0');
    WHILE EXISTS (SELECT 1 FROM public.user_tools WHERE internal_code = new_code) LOOP
      seq_num := seq_num + 1;
      new_code := category_prefix || '-' || LPAD(seq_num::TEXT, 4, '0');
    END LOOP;

    UPDATE public.user_tools SET internal_code = new_code WHERE id = tool_record.id;
  END LOOP;
END;
$$;

-- Create tool_events table for full history
CREATE TABLE public.tool_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_tool_id UUID NOT NULL REFERENCES public.user_tools(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'sharpening', 'anomaly', 'inspection', 'repair', 'note'
  description TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  performed_by UUID, -- user who performed the action
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- RLS for tool_events
ALTER TABLE public.tool_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view events for their tools"
  ON public.tool_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_tools 
      WHERE user_tools.id = tool_events.user_tool_id 
      AND user_tools.user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all tool events"
  ON public.tool_events FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can manage tool events"
  ON public.tool_events FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Users can insert events for their tools"
  ON public.tool_events FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_tools 
      WHERE user_tools.id = tool_events.user_tool_id 
      AND user_tools.user_id = auth.uid()
    )
  );

-- Public read policy for QR code access (unauthenticated)
CREATE POLICY "Public can view tool events via tool id"
  ON public.tool_events FOR SELECT
  USING (true);
