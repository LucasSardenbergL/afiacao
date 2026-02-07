-- First delete category mappings (child table)
DELETE FROM public.category_mappings;

-- Delete user tools referencing old categories
DELETE FROM public.user_tools;

-- Remove all existing tool categories
DELETE FROM public.tool_categories;

-- Insert marcenaria (woodworking) tool categories
INSERT INTO public.tool_categories (name, description, icon, usage_type, suggested_interval_days) VALUES
('Tesoura Profissional', 'Tesoura de precisão para trabalhos em marcenaria', 'scissors', 'industrial', 60),
('Formões', 'Formões para entalhe e acabamento em madeira', 'hammer', 'industrial', 90),
('Faca de Plaina (Estreita)', 'Faca estreita para plaina manual ou elétrica', 'ruler', 'industrial', 45),
('Cabeçote', 'Cabeçote com facas para máquinas de marcenaria', 'settings', 'industrial', 120),
('Faca de Desengrosso', 'Facas para máquina desengrossadeira', 'layers', 'industrial', 60),
('Faca de Plaina Manual', 'Facas para plaina manual tradicional', 'ruler', 'industrial', 90),
('Fresa', 'Fresas para tupia e fresadora', 'cog', 'industrial', 45),
('Serra Circular de Widea', 'Discos de serra circular com pastilhas de widea', 'circle', 'industrial', 120);

-- Create new category mappings
INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'tesoura_profissional', id FROM public.tool_categories WHERE name = 'Tesoura Profissional';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'formoes', id FROM public.tool_categories WHERE name = 'Formões';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'faca_plaina_estreita', id FROM public.tool_categories WHERE name = 'Faca de Plaina (Estreita)';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'cabecote', id FROM public.tool_categories WHERE name = 'Cabeçote';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'faca_desengrosso', id FROM public.tool_categories WHERE name = 'Faca de Desengrosso';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'faca_plaina_manual', id FROM public.tool_categories WHERE name = 'Faca de Plaina Manual';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'fresa', id FROM public.tool_categories WHERE name = 'Fresa';

INSERT INTO public.category_mappings (order_category, tool_category_id)
SELECT 'serra_circular_widea', id FROM public.tool_categories WHERE name = 'Serra Circular de Widea';