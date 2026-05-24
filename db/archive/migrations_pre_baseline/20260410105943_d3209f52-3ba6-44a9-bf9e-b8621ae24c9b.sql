-- Add customer SELECT policy on order_items so customers can view their own order items
CREATE POLICY "Customers can view their own order items"
  ON public.order_items
  FOR SELECT
  TO authenticated
  USING (auth.uid() = customer_user_id);