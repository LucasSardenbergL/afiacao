import { useState, useEffect, Component, type ReactNode } from 'react';
import { Bell, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

class NotificationErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? null : this.props.children; }
}

function NotificationPromptInner() {
  const { isSupported, permission, requestPermission } = usePushNotifications();
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Check if user has already dismissed
    const wasDismissed = localStorage.getItem('notification-prompt-dismissed');
    if (wasDismissed) {
      setDismissed(true);
      return;
    }

    // Show prompt after a short delay
    const timer = setTimeout(() => {
      if (isSupported && permission === 'default') {
        setVisible(true);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [isSupported, permission]);

  const handleDismiss = () => {
    setVisible(false);
    setDismissed(true);
    localStorage.setItem('notification-prompt-dismissed', 'true');
  };

  const handleEnable = async () => {
    const granted = await requestPermission();
    if (granted) {
      setVisible(false);
    }
  };

  if (dismissed || !visible || permission !== 'default') {
    return null;
  }

  return (
    <div
      className={cn(
        'fixed bottom-20 left-4 right-4 z-50 max-w-md mx-auto',
        'bg-card border border-border rounded-xl shadow-lg p-4',
        'animate-in slide-in-from-bottom-4 duration-300'
      )}
    >
      <button
        onClick={handleDismiss}
        className="absolute top-2 right-2 p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Bell className="w-5 h-5 text-primary" />
        </div>
        
        <div className="flex-1">
          <h4 className="font-semibold text-foreground mb-1">
            Ativar notificações?
          </h4>
          <p className="text-sm text-muted-foreground mb-3">
            Receba alertas quando o status do seu pedido mudar
          </p>
          
          <div className="flex gap-2">
            <Button size="sm" onClick={handleEnable}>
              Ativar
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDismiss}>
              Agora não
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NotificationPrompt() {
  return (
    <NotificationErrorBoundary>
      <NotificationPromptInner />
    </NotificationErrorBoundary>
  );
}
