import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/ui/skeleton';

import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { resolverHomeStaff } from '@/lib/nav/home-por-persona';

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

  // Home por persona: vendedora (farmer/hunter/closer/operacional ou sales-only)
  // aterrissa no Meu Dia — o cockpit de 6 módulos é home de gestor/master/staff
  // genérico. Ambos os hooks são lente-aware ("Ver como" testa o fluxo do alvo).
  const { data: roleComercial, isLoading: roleComercialLoading } = useMyCommercialRole();
  const { displayIsStaff, displayIsSalesOnly, displayLoading } = useDisplayAccess();

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

  // Segura o skeleton até saber o cargo comercial — sem isso a vendedora COM cargo
  // veria o cockpit por um instante (e dispararia os fetches das 6 zonas) antes do
  // redirect. Limitação aceita: sales-only SEM cargo cadastrado ainda flasha o
  // cockpit (useSalesOnlyRestriction retorna false enquanto carrega, sem loading
  // exposto) — caso teórico, toda vendedora real tem commercial_role.
  if (roleComercialLoading || displayLoading) {
    return <HomeSkeleton />;
  }

  // `displayIsStaff` no gate: fora da lente é o próprio isStaff (equivalente); NA
  // lente evita loop com alvo de perfil inconsistente (commercial_role de vendedora
  // mas app_role não-staff → RequireStaff de /meu-dia rebateria pra cá eternamente).
  const homeStaff = resolverHomeStaff({
    commercialRole: roleComercial,
    isSalesOnly: displayIsSalesOnly,
  });
  if (homeStaff && displayIsStaff) {
    return <Navigate to={homeStaff} replace />;
  }

  return (
    <Suspense fallback={<HomeSkeleton />}>
      <StaffDashboard />
    </Suspense>
  );
};

export default Index;
