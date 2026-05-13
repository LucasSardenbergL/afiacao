import { useEffect, useState } from 'react';
import { Wifi, WifiOff, Cloud, CloudOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { cn } from '@/lib/utils';
import { getOfflineQueueDepth, subscribeToOfflineQueue } from '@/lib/offline-queue';

/**
 * Substitui o `Bell` ornamental do topbar antigo. Mostra:
 *  - Dot verde (online) / âmbar (lento) / vermelho (offline)
 *  - Hover: popover com RTT, tipo de conexão, # mutações na fila
 *
 * Quando o offline-queue (#20) registrar mutações pendentes, o badge vai mostrar count.
 */
export function NetworkStatusIndicator() {
  const status = useNetworkStatus();
  const [queueDepth, setQueueDepth] = useState(0);

  useEffect(() => {
    let mounted = true;
    getOfflineQueueDepth().then((d) => mounted && setQueueDepth(d));
    const unsub = subscribeToOfflineQueue((depth) => {
      if (mounted) setQueueDepth(depth);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const tone =
    status.quality === 'offline'
      ? { dot: 'bg-status-error', label: 'Offline', icon: WifiOff, tint: 'text-status-error' }
      : status.quality === 'slow'
        ? { dot: 'bg-status-warning', label: 'Conexão lenta', icon: Cloud, tint: 'text-status-warning' }
        : { dot: 'bg-status-success', label: 'Online', icon: Wifi, tint: 'text-status-success' };

  const Icon = tone.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label={`Status da conexão: ${tone.label}`}
        >
          <Icon className={cn('w-4 h-4', tone.tint)} />
          <span
            className={cn(
              'absolute top-1.5 right-1.5 w-2 h-2 rounded-full ring-2 ring-card',
              tone.dot,
              status.quality === 'slow' && 'animate-pulse',
            )}
          />
          {queueDepth > 0 && (
            <span className="absolute -bottom-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
              {queueDepth > 99 ? '99+' : queueDepth}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-2 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <span className={cn('inline-block w-2 h-2 rounded-full', tone.dot)} />
          {tone.label}
        </div>
        <dl className="text-xs text-muted-foreground space-y-1">
          {status.effectiveType && (
            <div className="flex justify-between">
              <dt>Tipo</dt>
              <dd className="font-mono text-foreground">{status.effectiveType}</dd>
            </div>
          )}
          {status.rttMs !== null && (
            <div className="flex justify-between">
              <dt>RTT estimado</dt>
              <dd className="font-mono text-foreground">{status.rttMs}ms</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Mutações na fila</dt>
            <dd className={cn('font-mono', queueDepth > 0 ? 'text-status-warning' : 'text-foreground')}>
              {queueDepth}
            </dd>
          </div>
        </dl>
        {status.quality === 'offline' && (
          <p className="text-xs text-status-error pt-1 border-t border-border">
            <CloudOff className="inline w-3 h-3 mr-1" />
            Trabalhando offline. Operações serão sincronizadas quando a conexão voltar.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
