import { Suspense, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/ui/skeleton';

import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';
import { useMyCommercialRole, type MyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { resolverHomeStaff } from '@/lib/nav/home-por-persona';
import { lazyRota } from '@/lib/preload-rota';
import {
  carregarCustomerDashboard,
  carregarStaffDashboard,
  gravarDicaDashboard,
} from '@/pages/home/dashboards-home';

// Lazy POR PAPEL: o cliente não baixa o cockpit drag-and-drop do staff (~95KB
// de dnd) e o staff não baixa o framer-motion do dashboard do cliente (~124KB).
// Quando o lazy monta, `roleLoading` já resolveu (gate abaixo), então não há
// flash de troca de papel — só o skeleton do Suspense na primeira visita.
// `lazyRota` com os carregadores de `dashboards-home`: o MESMO que o prefetch da rota `/` usa
// (pela dica do último dashboard), então o chunk já pode estar baixando desde o boot (lote 6b).
const CustomerDashboard = lazyRota(carregarCustomerDashboard);
const StaffDashboard = lazyRota(carregarStaffDashboard);

const HomeSkeleton = () => (
  <div className="space-y-4">
    <Skeleton className="h-32 rounded-xl" />
    <Skeleton className="h-24 rounded-xl" />
    <Skeleton className="h-24 rounded-xl" />
  </div>
);

type DecisaoHome = { tipo: 'aguardando' | 'cliente' | 'staff' } | { tipo: 'redirect'; para: string };

function decidirHome(e: {
  roleLoading: boolean;
  isStaff: boolean;
  profileLoading: boolean;
  customerOrdersLoading: boolean;
  roleComercialLoading: boolean;
  displayLoading: boolean;
  roleComercial: MyCommercialRole;
  displayIsSalesOnly: boolean;
  displayIsStaff: boolean;
}): DecisaoHome {
  const {
    roleLoading, isStaff, profileLoading, customerOrdersLoading, roleComercialLoading,
    displayLoading, roleComercial, displayIsSalesOnly, displayIsStaff,
  } = e;
  if (roleLoading || (!isStaff && (profileLoading || customerOrdersLoading))) return { tipo: 'aguardando' };
  if (!isStaff) return { tipo: 'cliente' };
  // Segura o skeleton até saber o cargo comercial — sem isso a vendedora COM cargo
  // veria o cockpit por um instante (e dispararia os fetches das 6 zonas) antes do
  // redirect. Limitação aceita: sales-only SEM cargo cadastrado ainda flasha o
  // cockpit (useSalesOnlyRestriction retorna false enquanto carrega, sem loading
  // exposto) — caso teórico, toda vendedora real tem commercial_role.
  if (roleComercialLoading || displayLoading) return { tipo: 'aguardando' };
  // `displayIsStaff` no gate: fora da lente é o próprio isStaff (equivalente); NA
  // lente evita loop com alvo de perfil inconsistente (commercial_role de vendedora
  // mas app_role não-staff → RequireStaff de /meu-dia rebateria pra cá eternamente).
  const homeStaff = resolverHomeStaff({
    commercialRole: roleComercial,
    isSalesOnly: displayIsSalesOnly,
  });
  if (homeStaff && displayIsStaff) return { tipo: 'redirect', para: homeStaff };
  return { tipo: 'staff' };
}

const Index = () => {
  const { user, isStaff, loading: roleLoading } = useAuth();

  // Profile só do CLIENTE: é prop do CustomerDashboard. A home staff não o usa (aprovação vem do
  // AuthContext), então ele não pode segurar o skeleton do staff (plano v4, lote 5 — C2). O fetch
  // segue em paralelo ao papel, como o dos pedidos, para o cliente não pagar uma viagem a mais.
  const { data: profile, isLoading: profileLoading } =
    useBasicProfile(!isStaff ? user?.id : undefined);
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

  // Decisão ÚNICA da home: o render e a dica do próximo boot leem o mesmo valor.
  const decisao = decidirHome({
    roleLoading, isStaff, profileLoading, customerOrdersLoading, roleComercialLoading,
    displayLoading, roleComercial, displayIsSalesOnly, displayIsStaff,
  });

  // Dica do dashboard para o prefetch do próximo boot (`dashboards-home`). Registra o RAMO
  // escolhido, não que o conteúdo apareceu. Redirect remove a dica: a vendedora não usa nenhum.
  useEffect(() => {
    if (decisao.tipo === 'cliente' || decisao.tipo === 'staff') gravarDicaDashboard(decisao.tipo);
    else if (decisao.tipo === 'redirect') gravarDicaDashboard(null);
  }, [decisao.tipo]);

  if (decisao.tipo === 'aguardando') return <HomeSkeleton />;

  if (decisao.tipo === 'cliente') {
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

  if (decisao.tipo === 'redirect') return <Navigate to={decisao.para} replace />;

  return (
    <Suspense fallback={<HomeSkeleton />}>
      <StaffDashboard />
    </Suspense>
  );
};

export default Index;
