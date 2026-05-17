import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/ui/skeleton';

import { CustomerDashboard } from '@/components/CustomerDashboard';
import { StaffDashboard } from '@/components/dashboard/StaffDashboard';

import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';

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
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <CustomerDashboard
        profile={profile}
        pendingOrders={pendingOrders}
        userTools={userTools}
        getGreeting={getGreeting}
      />
    );
  }

  return <StaffDashboard />;
};

export default Index;
