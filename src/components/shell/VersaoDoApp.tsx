import { useSyncExternalStore } from 'react';
import { RefreshCw, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import {
  aplicarAtualizacao,
  assinarEstadoAtualizacao,
  descreverEstadoAtualizacao,
  obterEstadoAtualizacao,
  podeReparar,
  repararApp,
  verificarAtualizacaoAgora,
} from '@/lib/pwa-atualizacao';

/** "17/10 14:32" — quando ESTE build foi gerado (o carimbo do build mínimo). */
function formatarCarimbo(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Itens do menu do usuário: em que BUILD este aparelho está e a fase da
 * atualização — com "Verificar agora" (checa o servidor ignorando o throttle)
 * ou "Atualizar agora" quando há versão pronta. Existe porque a adoção do build
 * pelo staff destrava migrations (#3072/#3084) e, até aqui, ninguém conseguia
 * dizer em que build estava sem DevTools — o iPhone ficou 7 dias preso calado.
 */
export function VersaoDoApp() {
  const estado = useSyncExternalStore(assinarEstadoAtualizacao, obterEstadoAtualizacao);
  const { build, situacao } = descreverEstadoAtualizacao(estado);

  const verificar = async () => {
    const fase = await verificarAtualizacaoAgora();
    if (fase === 'em_dia') {
      const e = obterEstadoAtualizacao();
      if (e.buildServidor && e.buildServidor !== e.buildId) {
        toast.warning('Este aparelho não está no build do servidor', {
          description: 'A versão nova ainda não foi encontrada. Feche e reabra o app com internet.',
        });
      } else {
        toast.success('App na versão mais recente');
      }
    } else if (fase === 'baixando') {
      toast('Baixando a nova versão…', { description: 'O aviso para atualizar aparece quando terminar.' });
    } else if (fase === 'falhou') {
      toast.error('Não consegui baixar a nova versão', { description: 'Tente de novo com uma conexão melhor.' });
    }
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        <span className="block">Versão {build}{estado.buildEm ? ` · ${formatarCarimbo(estado.buildEm)}` : ''}</span>
        <span className="block">{situacao}</span>
      </DropdownMenuLabel>
      {estado.fase === 'pronta' ? (
        <DropdownMenuItem onClick={() => aplicarAtualizacao()}>
          <RefreshCw className="w-4 h-4 mr-2" /> Atualizar agora
        </DropdownMenuItem>
      ) : estado.fase !== 'inativo' ? (
        <DropdownMenuItem onClick={() => void verificar()} disabled={estado.fase === 'verificando'}>
          <RefreshCw className="w-4 h-4 mr-2" /> Verificar atualização
        </DropdownMenuItem>
      ) : null}
      {/* Install do build novo morreu: o caminho normal não sai do lugar. Reparar = tirar o SW
          e os caches e recarregar pela rede (clique explícito; a fila offline fica). */}
      {podeReparar(estado.fase) && (
        <DropdownMenuItem onClick={() => void repararApp()}>
          <Wrench className="w-4 h-4 mr-2" /> Reparar app
        </DropdownMenuItem>
      )}
    </>
  );
}
