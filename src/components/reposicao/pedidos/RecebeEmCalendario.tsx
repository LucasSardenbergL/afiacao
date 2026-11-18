import { CalendarClock } from 'lucide-react';
import { rotuloPreviaRecebeEm, rotuloRecebeEm, STATUS_PREVIA_RECEBIMENTO } from '@/lib/reposicao/calendario/grade';
import { useLtFornecedores, usePrevisaoPedido } from '@/hooks/useCalendarioOperacao';
import type { PedidoSugerido } from './types';

type PedidoRecebeEm = Pick<
  PedidoSugerido,
  'recebimento_ajustado_calendario' | 'data_recebimento_prevista' | 'status' | 'empresa' | 'fornecedor_nome' | 'portal_data_entrega'
>;

/**
 * "recebe em DD/MM" na lista de pedidos.
 * - Disparado: as colunas gravadas pela edge — só quando o calendário EMPURROU a chegada (`ajustado === true`).
 * - Ainda NÃO disparado (pendente / aprovado aguardando / bloqueado): prévia pela RPC `calendario_previsao_pedido`
 *   (a mesma regra da edge) — "recebe em DD/MM (prévia)" se a empresa estiver fechada na promessa, e "previsão
 *   indisponível" se a RPC falhar ou não conseguir calcular. Nunca silêncio no lugar de "não sei".
 */
export function RecebeEmCalendario({ pedido }: { pedido: PedidoRecebeEm }) {
  if (STATUS_PREVIA_RECEBIMENTO.includes(pedido.status)) return <PreviaRecebeEm pedido={pedido} />;
  const rotulo = rotuloRecebeEm(pedido);
  if (!rotulo) return null;
  return (
    <div
      className="mt-0.5 inline-flex items-center gap-1 text-xs text-status-warning"
      data-testid="recebe-em-calendario"
      title="Data de recebimento ajustada pelo calendário de operação (recesso ou dia fechado)"
    >
      <CalendarClock className="h-3 w-3" />
      {rotulo}
    </div>
  );
}

function PreviaRecebeEm({ pedido }: { pedido: PedidoRecebeEm }) {
  const lts = useLtFornecedores(pedido.empresa);
  const portal = pedido.portal_data_entrega ?? null;
  const lt = lts.data ? (lts.data.get(pedido.fornecedor_nome) ?? null) : null;
  const previsao = usePrevisaoPedido({
    empresa: pedido.empresa,
    fornecedor: pedido.fornecedor_nome,
    portalData: portal,
    lt,
    // Com data do portal o LT não entra: não espera a leitura dele.
    enabled: portal !== null || lts.isSuccess,
  });
  const falhou = previsao.isError || (portal === null && lts.isError);
  if (!falhou && !previsao.data) return null; // carregando
  const r = rotuloPreviaRecebeEm(falhou ? 'erro' : (previsao.data ?? 'erro'));
  if (!r) return null;
  if (r.tipo === 'indisponivel') {
    return (
      <div
        className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground"
        data-testid="previa-recebe-em-indisponivel"
        title="Não foi possível calcular a data de recebimento pelo calendário de operação (sem LT, sem calendário ou erro de leitura)"
      >
        <CalendarClock className="h-3 w-3" />
        {r.texto}
      </div>
    );
  }
  return (
    <div
      className="mt-0.5 inline-flex items-center gap-1 text-xs text-status-warning"
      data-testid="previa-recebe-em"
      title="Prévia: a empresa está fechada na data prometida pelo fornecedor (recesso ou dia fechado). A data definitiva é gravada no disparo."
    >
      <CalendarClock className="h-3 w-3" />
      {r.texto}
    </div>
  );
}
