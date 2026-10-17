import { useSyncExternalStore } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  aplicarAtualizacao,
  assinarEstadoAtualizacao,
  faseDoIndicador,
  obterEstadoAtualizacao,
} from '@/lib/pwa-atualizacao';

/**
 * Indicador de atualização no topbar — aparece SÓ quando há algo a comunicar (o padrão do
 * `NetworkStatusIndicator`): `baixando` (o build novo está vindo) e `pronta` (é só clicar).
 * Some no estado normal. Clicar em "Atualizar" é o único jeito de recarregar — o modo
 * `prompt` fica intacto.
 */
export function IndicadorAtualizacao() {
  const estado = useSyncExternalStore(assinarEstadoAtualizacao, obterEstadoAtualizacao);
  const fase = faseDoIndicador(estado.fase);
  if (!fase) return null;

  const pronta = fase === 'pronta';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted transition-colors',
            pronta ? 'text-status-info-bold' : 'text-muted-foreground',
          )}
          aria-label={pronta ? 'Nova versão pronta para atualizar' : 'Baixando nova versão'}
        >
          {pronta ? <RefreshCw className="w-4 h-4" /> : <ArrowDownToLine className="w-4 h-4 animate-pulse" />}
          {pronta && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-status-info" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 space-y-2 text-sm">
        <p className="font-medium">{pronta ? 'Nova versão pronta' : 'Baixando nova versão…'}</p>
        <p className="text-xs text-muted-foreground">
          {pronta
            ? 'Atualize quando terminar a tarefa atual. O app recarrega; operações offline ficam guardadas.'
            : 'Quando terminar, o aviso para atualizar aparece aqui.'}
        </p>
        {pronta && (
          <Button size="sm" className="w-full" onClick={() => aplicarAtualizacao()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Atualizar agora
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
