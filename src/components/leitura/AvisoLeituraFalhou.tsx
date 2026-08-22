import { CloudOff, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EstadoLeitura } from '@/lib/leitura/estado-de-leitura';

/**
 * O que uma tela mostra quando a leitura NÃO ACONTECEU — o oposto de sumir.
 *
 * Existe para que a correção da classe "erro colapsado em vazio" seja a mesma em todo
 * lugar (docs/historico/fase-sem-sinal.md). A frase que carrega o peso é a última:
 * sem ela o usuário lê "deu erro num widget" e seguem valendo as conclusões que ele
 * tirou da tela — que é o dano que a classe causa.
 *
 * NÃO tem botão de "tentar de novo" por padrão: o react-query já refaz sozinho
 * (retry 2 + refetch por intervalo nos consumidores que o configuram), e um botão que
 * não conserta ensina o usuário a clicar e concluir que está tudo bem.
 */
export function AvisoLeituraFalhou({
  oque,
  estado,
  variante = 'inline',
  className,
}: {
  /** o que não pôde ser lido, em minúscula e no meio da frase: "os alertas de fluxo de caixa" */
  oque: string;
  estado: Extract<EstadoLeitura, 'erro' | 'sem-rede'>;
  variante?: 'inline' | 'bloco';
  className?: string;
}) {
  const semRede = estado === 'sem-rede';
  const Icon = semRede ? CloudOff : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        'bg-status-warning-bg border-status-warning/30 text-status-warning',
        variante === 'bloco' ? 'p-4' : 'mb-3',
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <span>
        {semRede ? 'Sem conexão — não foi possível verificar ' : 'Não foi possível carregar '}
        {oque}.{' '}
        <strong className="font-medium">Isto não quer dizer que está tudo certo</strong> — a
        informação não chegou, então não decida por esta tela.
      </span>
    </div>
  );
}
