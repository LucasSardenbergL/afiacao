// Tipos de view derivados dos hooks do Customer 360 — usados pelos componentes de seção.
// Extraídos de src/pages/Customer360.tsx (god-component split).
import type {
  useCustomerCore, useCustomerAddress, useCustomerMetrics, useCustomerScore,
  useCustomerPreferredItems, useCustomerOrders, useCustomerInteractions, useCustomerFaturamento12m,
} from './hooks';
import type { useCustomerContacts } from '@/hooks/useCustomerContacts';
import type { EstadoLeitura, EstadoSemLeitura } from '@/lib/leitura/estado-de-leitura';

export type Customer = NonNullable<ReturnType<typeof useCustomerCore>['data']>;
export type CustomerMetrics = ReturnType<typeof useCustomerMetrics>['data'];
export type CustomerScore = ReturnType<typeof useCustomerScore>['data'];
export type AddressQuery = ReturnType<typeof useCustomerAddress>;
export type PreferredQuery = ReturnType<typeof useCustomerPreferredItems>;
export type OrdersQuery = ReturnType<typeof useCustomerOrders>;
export type InteractionsQuery = ReturnType<typeof useCustomerInteractions>;
export type ContactsQuery = ReturnType<typeof useCustomerContacts>;

/** Faturamento 12m no universo canônico (`useCustomerFaturamento12m`). */
export type Faturamento12m = NonNullable<ReturnType<typeof useCustomerFaturamento12m>['data']>;

/**
 * Uma leitura como a faixa de KPIs a enxerga (montada por `leituraDaQuery`). São DOIS ramos, e o
 * que os separa é ter valor em mãos: sem valor, o MOTIVO (carregando, falha, sem rede); com valor,
 * se a última tentativa de atualizá-lo falhou. O react-query guarda o último sucesso depois de um
 * refetch que falha — `isError && !data` deixava esse valor velho na tela como se fosse recém-lido.
 */
export type LeituraKpi<T> =
  | { emMaos: false; motivo: Exclude<EstadoLeitura, 'pronta'> }
  | { emMaos: true; valor: T; desatualizado: EstadoSemLeitura | null; lidoEm: number };
