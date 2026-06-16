// Tipos de view derivados dos hooks do Customer 360 — usados pelos componentes de seção.
// Extraídos de src/pages/Customer360.tsx (god-component split).
import type {
  useCustomerCore, useCustomerAddress, useCustomerMetrics, useCustomerScore,
  useCustomerPreferredItems, useCustomerOrders, useCustomerInteractions,
} from './hooks';
import type { useCustomerContacts } from '@/hooks/useCustomerContacts';

export type Customer = NonNullable<ReturnType<typeof useCustomerCore>['data']>;
export type CustomerMetrics = ReturnType<typeof useCustomerMetrics>['data'];
export type CustomerScore = ReturnType<typeof useCustomerScore>['data'];
export type AddressQuery = ReturnType<typeof useCustomerAddress>;
export type PreferredQuery = ReturnType<typeof useCustomerPreferredItems>;
export type OrdersQuery = ReturnType<typeof useCustomerOrders>;
export type InteractionsQuery = ReturnType<typeof useCustomerInteractions>;
export type ContactsQuery = ReturnType<typeof useCustomerContacts>;

export type RevenueDerived = {
  lifetime: number;
  last12: number;
  orderCount12m: number;
  lastOrderAt: string | null;
};
