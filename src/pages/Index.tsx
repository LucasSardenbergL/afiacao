import { lazy, Suspense } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/ui/skeleton';

import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';

// Lazy POR PAPEL: o cliente não baixa o cockpit drag-and-drop do staff (~95KB
// de dnd) e o staff não baixa o framer-motion do dashboard do cliente (~124KB).
// Quando o lazy monta, `roleLoading` já resolveu (gate abaixo), então não há
// flash de troca de papel — só o skeleton do Suspense na primeira visita.
const CustomerDashboard = lazy(() =>
  import('@/components/CustomerDashboard').then((m) => ({ default: m.CustomerDashboard })),
);
const StaffDashboard = lazy(() =>
  import('@/components/dashboard/StaffDashboard').then((m) => ({ default: m.StaffDashboard })),
);

const HomeSkeleton = () => (
  <div className="space-y-4">
    <Skeleton className="h-32 rounded-xl" />
    <Skeleton className="h-24 rounded-xl" />
    <Skeleton className="h-24 rounded-xl" />
  </div>
);

const Index = () => {
  const { user, isStaff, loading: roleLoading } = useAuth();

  const { data: profile, isLoading: profileLoading } = useBasicProfile(user?.id);
  const { data: pendingOrders = [], isLoading: customerOrdersLoading } =
    useCustomerPendingOrders(!isStaff ? user?.id : undefined);
  const { data: userTools = [] } =
    useUserToolsSummary(!isStaff ? user?.id : undefined, !isStaff && !roleLoading);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  };

  if (roleLoading || profileLoading || (!isStaff && customerOrdersLoading)) {
    return <HomeSkeleton />;
  }

  if (!isStaff) {
    return (
      <Suspense fallback={<HomeSkeleton />}>
        <CustomerDashboard
          profile={profile ?? null}
          pendingOrders={pendingOrders}
          userTools={userTools}
          getGreeting={getGreeting}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<HomeSkeleton />}>
      <StaffDashboard />
    </Suspense>
  );
};

export default Index;
