import { CommercialDashboard } from '@/components/dashboard/CommercialDashboard';

/**
 * Página "Meu dia" — dashboard adaptativo por commercial_role.
 * Farmer / Hunter / Closer / Master vêem telas diferentes (PR-MULTIVENDOR-4-ROLES).
 */
export default function MeuDia() {
  return <CommercialDashboard />;
}
