import { Loader2 } from 'lucide-react';
import { useMyCommercialRole, type MyCommercialRole } from '@/hooks/useMyCommercialRole';
import { FarmerDashboardV2 } from './FarmerDashboardV2';
import { HunterDashboard } from './HunterDashboard';
import { CloserDashboard } from './CloserDashboard';
import { MasterDashboard } from './MasterDashboard';

/**
 * Shell que renderiza dashboard apropriado baseado em commercial_role do user
 * logado. Default fallback: FarmerDashboardV2.
 *
 * Mapping:
 * - hunter → HunterDashboard
 * - closer → CloserDashboard
 * - master | super_admin → MasterDashboard
 * - farmer | operacional | gerencial | estrategico | null → FarmerDashboardV2
 */
export function CommercialDashboard() {
  const { data: role, isLoading } = useMyCommercialRole();

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const r = (role ?? 'farmer') as MyCommercialRole;

  switch (r) {
    case 'hunter':
      return <HunterDashboard />;
    case 'closer':
      return <CloserDashboard />;
    case 'master':
    case 'super_admin':
      return <MasterDashboard />;
    case 'farmer':
    case 'operacional':
    case 'gerencial':
    case 'estrategico':
    default:
      return <FarmerDashboardV2 />;
  }
}
