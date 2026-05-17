import { AlertTriangle, RefreshCw } from 'lucide-react';

export function CockpitCardError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <AlertTriangle className="w-5 h-5 text-status-error-bold" />
      <p className="text-xs text-muted-foreground">{message ?? 'Erro ao carregar dados.'}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
      >
        <RefreshCw className="w-3 h-3" />
        Tentar novamente
      </button>
    </div>
  );
}
