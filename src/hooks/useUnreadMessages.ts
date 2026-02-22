import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export function useUnreadMessages() {
  const { user, isStaff } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) return;

    loadUnreadCount();

    // Subscribe to new messages
    const channel = supabase
      .channel('unread-messages-global')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_messages',
        },
        (payload) => {
          const msg = payload.new as any;
          // If the message is not from us, increment
          if (msg.sender_id !== user.id) {
            setUnreadCount(prev => prev + 1);
            // Play notification sound
            try {
              const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHjqIu9jLfVE3OIe90+G7aEAqN3q20NvTf00sJHKlzt3jnmQ+HkWSx93sqnRLGzaGvNjxw4BXNC5jmMTJ3bWQcTQmVYOy3+3i8tiLP0NLZKvL5cqOQT49S3u3m7NlNiMqW5/I3tKdcnw=');
              audio.volume = 0.3;
              audio.play().catch(() => {});
            } catch {}
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const loadUnreadCount = async () => {
    if (!user) return;

    try {
      // Get orders that belong to the user (or all if staff)
      const ordersQuery = supabase.from('orders').select('id');
      if (!isStaff) {
        ordersQuery.eq('user_id', user.id);
      }
      const { data: orders } = await ordersQuery;
      if (!orders || orders.length === 0) {
        setUnreadCount(0);
        return;
      }

      const orderIds = orders.map(o => o.id);

      // Count unread messages (not sent by us, not read)
      const { count, error } = await (supabase as any)
        .from('order_messages')
        .select('*', { count: 'exact', head: true })
        .in('order_id', orderIds)
        .neq('sender_id', user.id)
        .is('read_at', null);

      if (!error && count !== null) {
        setUnreadCount(count);
      }
    } catch (err) {
      console.error('Error loading unread count:', err);
    }
  };

  return { unreadCount, refreshUnread: loadUnreadCount };
}
