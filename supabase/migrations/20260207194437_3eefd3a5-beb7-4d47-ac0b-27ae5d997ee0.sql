-- Enable realtime for orders table to support push notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;