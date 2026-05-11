-- E7: Restrict orders / order_messages realtime topics
CREATE POLICY "staff_or_owner_orders_topic"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  topic NOT LIKE 'orders%'
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
  OR topic = 'orders:' || auth.uid()::text
);

CREATE POLICY "staff_or_owner_order_messages_topic"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  topic NOT LIKE 'order_messages%'
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
  OR topic = 'order_messages:' || auth.uid()::text
);