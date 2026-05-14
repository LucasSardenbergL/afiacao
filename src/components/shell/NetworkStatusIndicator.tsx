import { useEffect, useState } from 'react';
import { Wifi, WifiOff, Cloud, CloudOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { cn } from '@/lib/utils';
import { getOfflineQueueDepth, subscribeToOfflineQueue } from '@/lib/offline-queue';

/**
 * Indicador de rede com presença CONDICIONAL (Vercel/Linear pattern):
 *  - Online + queue vazia: NÃO renderiza nada (limpa o topbar)
 *  - Online + queue pendente: badge sutil com contador
 *  - Slow: ícone Cloud + ring expanding pulsante
 *  - Offline: ícone WifiOff + shake animation curta + estilo bold
 *
 * Hover: popover com detalhes de RTT, tipo, fila.
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

  // Online + queue vazia = limpa visual (não renderiza nada)
  if (status.quality === 'online' && queueDepth === 0) return null;

  const tone =
    status.quality === 'offline'
      ? { label: 'Offline', icon: WifiOff, tint: 'text-status-error-bold', ring: 'ring-status-error/20', dot: 'bg-status-error' }
      : status.quality === 'slow'
        ? { label: 'Conexão lenta', icon: Cloud, tint: 'text-status-warning-bold', ring: 'ring-status-warning/20', dot: 'bg-status-warning' }
        : { label: 'Online · fila pendente', icon: Wifi, tint: 'text-status-info-bold', ring: 'ring-status-info/20', dot: 'bg-status-info' };

  const Icon = tone.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted transition-colors',
            tone.tint,
            status.quality === 'offline' && 'animate-shake',
          )}
          aria-label={`Status da conexão: ${tone.label}`}
        >
          <Icon className="w-4 h-4 relative z-10" />
          {/* Pulse ring expanding pra slow + offline */}
          {(status.quality === 'slow' || status.quality === 'offline') && (
            <span className={cn(
              'absolute inset-0 rounded-md ring-2 animate-ping-slow',
              tone.ring,
            )} />
          )}
          {queueDepth > 0 && (
            <span className="absolute -bottom-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center tabular-nums">
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
