import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Send, Loader2, FileText, CloudOff, AlertCircle } from 'lucide-react';
import { findInvalidPricedProductItems } from '@/services/orderSubmission/priceGuard';
import { motivosEnvioBloqueado, envioBloqueado, type EntradaMotivosEnvio } from './motivos-envio';
import { rotuloTotal } from './rotulo-total';

export interface BarraEnvioPedidoProps extends EntradaMotivosEnvio {
  submitting: boolean;
  totalEstimated: number;
  /** Serviços sem preço ("a orçar") — o rótulo vira "Subtotal conhecido" (B4). */
  servicosAOrcar: number;
  onSubmit: () => void;
  onSubmitQuote?: () => void;
  /** Quando true, o botão vira "salvar rascunho" (vendedor offline). */
  offline?: boolean;
}

/**
 * C1/C2/C5 (rodada 2): total + Enviar SEMPRE à vista. É `sticky bottom-0` como filho direto da
 * página (não da coluna do carrinho): o bloco que o contém é a página inteira, então a barra fica
 * presa ao fim da tela no celular E no desktop, e — por ocupar lugar no fluxo, ao contrário de
 * `fixed` — nunca cobre o último item do carrinho ao fim da rolagem (o próprio espaço da barra é
 * o padding compensatório). `env(safe-area-inset-bottom)` afasta do indicador de início do iPhone.
 *
 * Enviar cinza diz POR QUÊ: os motivos saem da mesma função que calcula o `disabled`.
 */
export function BarraEnvioPedido(props: BarraEnvioPedidoProps) {
  const {
    submitting, totalEstimated, servicosAOrcar, onSubmit, onSubmitQuote, offline = false,
    temCliente, obenProductItems, colacorProductItems, serviceItems,
  } = props;
  const motivos = motivosEnvioBloqueado(props);
  const desabilitado = envioBloqueado(submitting, motivos);
  const total = rotuloTotal(totalEstimated, servicosAOrcar);

  const hasOnlyProducts = (obenProductItems.length > 0 || colacorProductItems.length > 0) && serviceItems.length === 0;
  // Orçamento: mesma regra de antes — barra só preço inválido (não grava codigo_parcela).
  const hasInvalidPrice = useMemo(
    () => findInvalidPricedProductItems([...obenProductItems, ...colacorProductItems]).length > 0,
    [obenProductItems, colacorProductItems],
  );
  const nPedidos = (obenProductItems.length > 0 ? 1 : 0) + (colacorProductItems.length > 0 ? 1 : 0) + (serviceItems.length > 0 ? 1 : 0);

  return (
    <div
      role="region"
      aria-label="Envio do pedido"
      data-testid="barra-envio-pedido"
      className="sticky bottom-0 z-20 -mx-4 border-t bg-card/95 px-4 pt-3 shadow-[0_-4px_12px_-8px_hsl(var(--foreground)/0.25)] backdrop-blur supports-[backdrop-filter]:bg-card/85 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:mx-0 lg:rounded-lg lg:border"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{total.rotulo}</p>
          <p className="text-lg font-semibold tabular-nums leading-tight" data-testid="barra-envio-total">{total.valor}</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          {temCliente && hasOnlyProducts && onSubmitQuote && (
            <Button variant="outline" size="touch" aria-label="Salvar como orçamento" className="flex-1 gap-2 sm:flex-none" onClick={onSubmitQuote} disabled={submitting || hasInvalidPrice}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <FileText className="w-4 h-4" aria-hidden />}
              Orçamento
            </Button>
          )}
          <Button
            size="touch"
            className="flex-1 gap-2 sm:flex-none"
            onClick={onSubmit}
            disabled={desabilitado}
            aria-describedby={motivos.length > 0 ? 'motivo-envio-bloqueado' : undefined}
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            ) : offline ? (
              <CloudOff className="w-4 h-4" aria-hidden />
            ) : (
              <Send className="w-4 h-4" aria-hidden />
            )}
            {offline ? 'Sem conexão — salvar rascunho' : 'Enviar pedido'}
            {!offline && nPedidos > 1 && <span className="text-[10px] opacity-70">({nPedidos} pedidos)</span>}
          </Button>
        </div>
      </div>
      {motivos.length > 0 && (
        <p id="motivo-envio-bloqueado" role="status" className="mt-2 flex items-start gap-1 text-xs text-status-warning">
          <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>{motivos.map(m => m.texto).join(' · ')}</span>
        </p>
      )}
    </div>
  );
}
