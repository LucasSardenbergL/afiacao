import { useEffect, useRef } from 'react';
import { AlertTriangle, CircleHelp } from 'lucide-react';
import { track } from '@/lib/analytics';
import { seloReceita, ErroSituacaoReceita } from '@/lib/receita/situacao-cliente';
import { useSituacaoReceitaCliente } from '@/lib/receita/useSituacaoReceitaCliente';

export type SuperficieSituacaoReceita = 'ficha' | 'pedido';

/**
 * Selo "CNPJ baixado/inapto/suspenso na Receita" (Frente 5 do Radar) — ficha do cliente e passo de
 * cliente do pedido. SÓ ALERTA: não bloqueia nada.
 *
 * Ausente ≠ ativa: só `irregular` mostra selo; ativa/sem dado/sem CNPJ não mostram nada (nunca selo
 * verde). Leitura que FALHOU (erro, offline) não pode virar silêncio — "não consultei" seria lido
 * como "nada consta" —, então aparece uma linha neutra "indisponível". Fora da carteira: silêncio.
 * No pedido, cliente sem cadastro vinculado (sem user_id) diz que a consulta não foi feita.
 *
 * Sensor (sem CNPJ nem motivo): `cliente.situacao_receita_lida` 1x por (superfície, cliente) montado,
 * com o desfecho — é o denominador; `cliente.situacao_receita_irregular_exibida` quando o selo rende.
 */
export function SeloSituacaoReceita({
  customerUserId,
  superficie,
}: {
  customerUserId: string | null | undefined;
  superficie: SuperficieSituacaoReceita;
}) {
  const q = useSituacaoReceitaCliente(customerUserId);
  const leitura = q.data;
  const offline = q.fetchStatus === 'paused' && leitura === undefined;
  const falhou = q.status === 'error' || offline;
  const selo = leitura?.tipo === 'ok' ? seloReceita(leitura.dado) : null;

  const desfecho: string | null = !customerUserId
    ? 'sem_vinculo'
    : offline
      ? 'offline'
      : q.status === 'error'
        ? q.error instanceof ErroSituacaoReceita && q.error.motivo === 'contrato'
          ? 'erro_contrato'
          : 'erro'
        : leitura === undefined
          ? null
          : leitura.tipo === 'sem_acesso'
            ? 'sem_acesso'
            : leitura.dado.estado;

  const lidaKey = useRef<string | null>(null);
  useEffect(() => {
    if (!desfecho) return;
    const chave = `${superficie}:${customerUserId ?? '-'}`;
    if (lidaKey.current === chave) return;
    lidaKey.current = chave;
    track('cliente.situacao_receita_lida', { superficie, estado: desfecho });
  }, [desfecho, superficie, customerUserId]);

  const exibidaKey = useRef<string | null>(null);
  const situacao = leitura?.tipo === 'ok' ? leitura.dado.situacao : null;
  useEffect(() => {
    if (!selo || !customerUserId) return;
    const chave = `${superficie}:${customerUserId}`;
    if (exibidaKey.current === chave) return;
    exibidaKey.current = chave;
    track('cliente.situacao_receita_irregular_exibida', { superficie, situacao, confirmado: selo.confirmado });
  }, [selo, situacao, superficie, customerUserId]);

  if (!customerUserId) {
    if (superficie !== 'pedido') return null;
    return (
      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="situacao-receita-nao-consultada">
        <CircleHelp className="w-3.5 h-3.5 flex-shrink-0" />
        Situação na Receita não consultada (cliente sem cadastro vinculado no app).
      </p>
    );
  }

  if (falhou) {
    return (
      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="situacao-receita-indisponivel">
        <CircleHelp className="w-3.5 h-3.5 flex-shrink-0" />
        {superficie === 'pedido'
          ? 'Situação na Receita indisponível agora — confirme o CNPJ antes de vender a prazo.'
          : 'Não consegui consultar a situação na Receita.'}
      </p>
    );
  }

  if (!selo) return null;

  return (
    <div
      className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-3"
      data-testid="selo-situacao-receita"
      data-confirmado={selo.confirmado ? 'sim' : 'nao'}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-semibold text-status-warning">{selo.titulo}</p>
          <p className="text-muted-foreground mt-0.5">{selo.detalhe}</p>
          {superficie === 'pedido' && (
            <p className="text-muted-foreground mt-1">
              Venda a prazo: confirme a situação com o financeiro antes de faturar. Este aviso não bloqueia o pedido.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
