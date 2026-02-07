import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

// Status labels in Portuguese
const ORDER_STATUS_LABELS: Record<string, string> = {
  pedido_recebido: 'Pedido Recebido',
  aguardando_coleta: 'Aguardando Coleta',
  em_triagem: 'Coletado e na Empresa',
  em_rota: 'A Caminho da Entrega',
  entregue: 'Entregue',
};

export function usePushNotifications() {
  const { user } = useAuth();
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    // Check if notifications are supported
    const supported = 'Notification' in window && 'serviceWorker' in navigator;
    setIsSupported(supported);

    if (supported) {
      setPermission(Notification.permission);
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      console.log('Push notifications not supported');
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === 'granted';
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      return false;
    }
  }, [isSupported]);

  const showNotification = useCallback((title: string, options?: NotificationOptions) => {
    if (permission !== 'granted') {
      console.log('Notification permission not granted');
      return;
    }

    try {
      // Try to use service worker notification first (works in background)
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((registration) => {
          registration.showNotification(title, {
            icon: '/pwa-192x192.png',
            badge: '/pwa-192x192.png',
            ...options,
          });
        });
      } else {
        // Fallback to regular notification
        new Notification(title, {
          icon: '/pwa-192x192.png',
          ...options,
        });
      }
    } catch (error) {
      console.error('Error showing notification:', error);
    }
  }, [permission]);

  // Subscribe to order status changes
  const subscribeToOrderUpdates = useCallback(() => {
    if (!user) return () => {};

    const channel = supabase
      .channel('order-status-changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const oldStatus = (payload.old as { status?: string })?.status;
          const newStatus = (payload.new as { status?: string })?.status;

          if (oldStatus !== newStatus && newStatus) {
            const statusLabel = ORDER_STATUS_LABELS[newStatus] || newStatus;
            
            showNotification('Atualização do Pedido', {
              body: `Seu pedido foi atualizado para: ${statusLabel}`,
              tag: `order-${(payload.new as { id?: string })?.id}`,
              requireInteraction: newStatus === 'entregue',
              data: {
                url: `/orders/${(payload.new as { id?: string })?.id}`,
              },
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, showNotification]);

  // Auto-subscribe when user is logged in
  useEffect(() => {
    if (user && permission === 'granted') {
      const unsubscribe = subscribeToOrderUpdates();
      return unsubscribe;
    }
  }, [user, permission, subscribeToOrderUpdates]);

  return {
    isSupported,
    permission,
    requestPermission,
    showNotification,
    subscribeToOrderUpdates,
  };
}
