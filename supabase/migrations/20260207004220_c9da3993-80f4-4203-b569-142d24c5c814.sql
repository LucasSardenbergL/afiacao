-- Create a function to update user tools when an order is delivered
CREATE OR REPLACE FUNCTION public.update_user_tools_on_order_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  item jsonb;
  tool_category_name text;
  matched_category_id uuid;
  tool_interval integer;
BEGIN
  -- Only run when status changes to 'entregue'
  IF NEW.status = 'entregue' AND OLD.status != 'entregue' THEN
    -- Loop through order items
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      -- Get the category from the item
      tool_category_name := item->>'category';
      
      -- Try to match with tool_categories table (map order category to tool category)
      SELECT id, suggested_interval_days INTO matched_category_id, tool_interval
      FROM tool_categories
      WHERE 
        LOWER(name) LIKE '%' || REPLACE(tool_category_name, '_', ' ') || '%'
        OR LOWER(name) LIKE '%' || REPLACE(REPLACE(tool_category_name, '_', '%'), 'facas', 'faca') || '%'
      LIMIT 1;
      
      -- If we found a matching category, update or create user_tools entry
      IF matched_category_id IS NOT NULL THEN
        -- Check if user already has this tool
        IF EXISTS (
          SELECT 1 FROM user_tools 
          WHERE user_id = NEW.user_id AND tool_category_id = matched_category_id
        ) THEN
          -- Update existing tool with new sharpening date
          UPDATE user_tools
          SET 
            last_sharpened_at = now(),
            next_sharpening_due = now() + (COALESCE(sharpening_interval_days, tool_interval, 90) * interval '1 day'),
            updated_at = now()
          WHERE user_id = NEW.user_id AND tool_category_id = matched_category_id;
        ELSE
          -- Insert new tool for user
          INSERT INTO user_tools (
            user_id,
            tool_category_id,
            last_sharpened_at,
            next_sharpening_due,
            sharpening_interval_days
          ) VALUES (
            NEW.user_id,
            matched_category_id,
            now(),
            now() + (tool_interval * interval '1 day'),
            tool_interval
          );
        END IF;
      END IF;
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Create trigger on orders table
DROP TRIGGER IF EXISTS trigger_update_user_tools_on_order_complete ON orders;
CREATE TRIGGER trigger_update_user_tools_on_order_complete
AFTER UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_user_tools_on_order_complete();

-- Also create a mapping table to help match order categories to tool categories
CREATE TABLE IF NOT EXISTS public.category_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_category text NOT NULL UNIQUE,
  tool_category_id uuid REFERENCES tool_categories(id)
);

-- Enable RLS
ALTER TABLE public.category_mappings ENABLE ROW LEVEL SECURITY;

-- Anyone can view category mappings
CREATE POLICY "Anyone can view category mappings" 
ON public.category_mappings 
FOR SELECT 
USING (true);

-- Insert mappings between order categories and tool categories
INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'facas_cozinha', id FROM tool_categories WHERE name = 'Facas de Cozinha' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'tesouras', id FROM tool_categories WHERE name = 'Tesouras' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'ferramentas_jardinagem', id FROM tool_categories WHERE name = 'Ferramentas de Jardinagem' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'laminas_industriais', id FROM tool_categories WHERE name = 'Lâminas Industriais' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'serras', id FROM tool_categories WHERE name = 'Serras Circulares' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'brocas', id FROM tool_categories WHERE name = 'Brocas' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'formoes', id FROM tool_categories WHERE name = 'Formões e Plainas' LIMIT 1;

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'plainas', id FROM tool_categories WHERE name = 'Formões e Plainas' LIMIT 1;

-- Update the function to use the mapping table
CREATE OR REPLACE FUNCTION public.update_user_tools_on_order_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  item jsonb;
  order_category text;
  matched_category_id uuid;
  tool_interval integer;
BEGIN
  -- Only run when status changes to 'entregue'
  IF NEW.status = 'entregue' AND OLD.status != 'entregue' THEN
    -- Loop through order items
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      -- Get the category from the item
      order_category := item->>'category';
      
      -- Use the mapping table to find the tool category
      SELECT cm.tool_category_id, tc.suggested_interval_days 
      INTO matched_category_id, tool_interval
      FROM category_mappings cm
      JOIN tool_categories tc ON tc.id = cm.tool_category_id
      WHERE cm.order_category = order_category
      LIMIT 1;
      
      -- If we found a matching category, update or create user_tools entry
      IF matched_category_id IS NOT NULL THEN
        -- Check if user already has this tool
        IF EXISTS (
          SELECT 1 FROM user_tools 
          WHERE user_id = NEW.user_id AND tool_category_id = matched_category_id
        ) THEN
          -- Update existing tool with new sharpening date
          UPDATE user_tools
          SET 
            last_sharpened_at = now(),
            next_sharpening_due = now() + (COALESCE(sharpening_interval_days, tool_interval, 90) * interval '1 day'),
            updated_at = now()
          WHERE user_id = NEW.user_id AND tool_category_id = matched_category_id;
        ELSE
          -- Insert new tool for user
          INSERT INTO user_tools (
            user_id,
            tool_category_id,
            last_sharpened_at,
            next_sharpening_due,
            sharpening_interval_days
          ) VALUES (
            NEW.user_id,
            matched_category_id,
            now(),
            now() + (tool_interval * interval '1 day'),
            tool_interval
          );
        END IF;
      END IF;
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$function$;