
-- promocao_campanha
DROP POLICY IF EXISTS "Admin/manager editam campanhas" ON public.promocao_campanha;
DROP POLICY IF EXISTS "Staff vê campanhas" ON public.promocao_campanha;

CREATE POLICY "Admin/manager/master editam campanhas"
ON public.promocao_campanha
FOR ALL
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
)
WITH CHECK (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
);

CREATE POLICY "Staff vê campanhas"
ON public.promocao_campanha
FOR SELECT
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
);

-- promocao_item
DROP POLICY IF EXISTS "Admin/manager editam itens" ON public.promocao_item;
DROP POLICY IF EXISTS "Staff vê itens" ON public.promocao_item;

CREATE POLICY "Admin/manager/master editam itens"
ON public.promocao_item
FOR ALL
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
)
WITH CHECK (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
);

CREATE POLICY "Staff vê itens"
ON public.promocao_item
FOR SELECT
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'master'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
);
