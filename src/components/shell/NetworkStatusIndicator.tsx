import { useEffect, useState } from 'react';
import { Wifi, WifiOff, Cloud, CloudOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { cn } from '@/lib/utils';
import { getOfflineQueueDepth, subscribeToOfflineQueue } from '@/lib/offline-queue';

/**
 * Indicador de rede sempre visível — sinal contínuo de saúde do sistema.
 *
 * Em B2B operacional, ver o status da conexão a qualquer momento é mais
 * importante do que minimalismo visual. Por isso renderiza sempre:
 *  - Online + queue vazia: ícone Wifi sutil em verde, sem ruído
 *  - Online + queue pendente: ícone Wifi + badge com contador
 *  - Slow: ícone Cloud em amarelo, ring expanding pulsante
 *  - Offline: ícone WifiOff em vermelho, shake animation curta, estilo bold
 *
 * Hover: popover com detalhes de RTT, tipo, fila.
 */
export function NetworkStatusIndicator() {
  const status = useNetworkStatus();
  // Tipo de conexão (4g) e RTT em ms são jargão de engenharia — úteis p/ staff
  // diagnosticar, ruído p/ vendedora/cliente. Lente-aware: na lente "como
  // vendedora", o popover técnico some. O ícone e o status legível (Online /
  // Offline / fila) ficam p/ todos — a persona offline é justamente a vendedora.
  const { displayIsStaff } = useDisplayAccess();
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
      ? { label: 'Offline', icon: WifiOff, tint: 'text-status-error-bold', ring: 'ring-status-error/20', dot: 'bg-status-error' }
      : status.quality === 'slow'
        ? { label: 'Conexão lenta', icon: Cloud, tint: 'text-status-warning-bold', ring: 'ring-status-warning/20', dot: 'bg-status-warning' }
        : queueDepth > 0
          ? { label: 'Online · fila pendente', icon: Wifi, tint: 'text-status-info-bold', ring: 'ring-status-info/20', dot: 'bg-status-info' }
          : { label: 'Online', icon: Wifi, tint: 'text-status-success opacity-70 hover:opacity-100', ring: 'ring-status-success/15', dot: 'bg-status-success' };

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
          {displayIsStaff && status.effectiveType && (
            <div className="flex justify-between">
              <dt>Tipo</dt>
              <dd className="font-mono text-foreground">{status.effectiveType}</dd>
            </div>
          )}
          {displayIsStaff && status.rttMs !== null && (
            <div className="flex justify-between">
              <dt>RTT estimado</dt>
              <dd className="font-mono text-foreground">{status.rttMs}ms</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Operações pendentes</dt>
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
