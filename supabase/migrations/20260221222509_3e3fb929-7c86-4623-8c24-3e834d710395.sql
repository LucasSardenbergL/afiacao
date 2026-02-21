
-- 1. Reviews/ratings table
CREATE TABLE public.order_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  user_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.order_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create reviews for their orders" ON public.order_reviews
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND
    EXISTS (SELECT 1 FROM public.orders WHERE orders.id = order_reviews.order_id AND orders.user_id = auth.uid())
  );

CREATE POLICY "Users can view their own reviews" ON public.order_reviews
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all reviews" ON public.order_reviews
  FOR SELECT USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

-- Unique constraint: one review per order
CREATE UNIQUE INDEX idx_order_reviews_unique ON public.order_reviews(order_id);

-- 2. Order messages (chat) table
CREATE TABLE public.order_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  sender_id UUID NOT NULL,
  message TEXT NOT NULL,
  is_staff BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.order_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can send messages on their orders" ON public.order_messages
  FOR INSERT WITH CHECK (
    auth.uid() = sender_id AND (
      EXISTS (SELECT 1 FROM public.orders WHERE orders.id = order_messages.order_id AND orders.user_id = auth.uid())
      OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee')
    )
  );

CREATE POLICY "Users can view messages on their orders" ON public.order_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.orders WHERE orders.id = order_messages.order_id AND orders.user_id = auth.uid())
    OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee')
  );

CREATE POLICY "Users can update read status" ON public.order_messages
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.orders WHERE orders.id = order_messages.order_id AND orders.user_id = auth.uid())
    OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee')
  );

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.order_messages;
