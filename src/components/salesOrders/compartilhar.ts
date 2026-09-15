// STUB do RED — só a assinatura, para os testes falharem um a um por falta da feature (e não por
// import que não resolve). O comportamento entra no GREEN.
import type { LeituraDescontosItens } from '@/components/sales/print/descontoCupom';
import type { SalesOrder } from './types';

export function montarCompartilhamento(
  _order: { items: SalesOrder['items'] | null | undefined; total: number | null | undefined },
  _descontos: LeituraDescontosItens,
): never {
  throw new Error('montarCompartilhamento: não implementado');
}
