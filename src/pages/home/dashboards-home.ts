/**
 * Dashboards da home (`/`) e a dica de qual deles pré-carregar (plano v5, lote 6b).
 *
 * O `Index` escolhe o dashboard POR PAPEL, e cada um é um chunk próprio: o cliente não baixa o
 * dnd do staff e o staff não baixa o framer-motion do cliente. Esse chunk só começava a baixar
 * depois do auth e das consultas do `Index`. Agora o `App.tsx` registra
 * `prefetchJunto: carregadorDaDica` na rota do `Index`, e o prefetch da rota (boot e sidebar)
 * baixa também o dashboard que a home renderizou da ÚLTIMA vez neste aparelho.
 *
 * A dica só escolhe entre os dois imports fixos abaixo. Dica errada, adulterada ou de outro
 * usuário custa um download, nunca um render: quem renderiza continua sendo o `Index`, atrás do
 * auth. Sem dica (1ª visita, storage bloqueado), nada é pré-carregado.
 *
 * Estes carregadores são os MESMOS que o `Index` passa ao `lazyRota`; assim o render espera o
 * prefetch em voo e trata a falha dele (ver `src/lib/preload-rota.ts`).
 */
export const carregarStaffDashboard = () =>
  import('@/components/dashboard/StaffDashboard').then((m) => ({ default: m.StaffDashboard }));

export const carregarCustomerDashboard = () =>
  import('@/components/CustomerDashboard').then((m) => ({ default: m.CustomerDashboard }));

export type DashboardHome = 'staff' | 'cliente';

export const CHAVE_DICA_DASHBOARD = 'home-dashboard-dica';

export function lerDicaDashboard(): DashboardHome | null {
  try {
    const valor = localStorage.getItem(CHAVE_DICA_DASHBOARD);
    return valor === 'staff' || valor === 'cliente' ? valor : null;
  } catch {
    return null;
  }
}

/** `null` remove a dica (a home redirecionou: nenhum dashboard será usado). */
export function gravarDicaDashboard(dashboard: DashboardHome | null): void {
  try {
    if (dashboard) localStorage.setItem(CHAVE_DICA_DASHBOARD, dashboard);
    else localStorage.removeItem(CHAVE_DICA_DASHBOARD);
  } catch {
    // storage indisponível: sem dica, a home carrega o dashboard sob demanda
  }
}

export function carregadorDaDica() {
  const dica = lerDicaDashboard();
  if (dica === 'staff') return carregarStaffDashboard;
  if (dica === 'cliente') return carregarCustomerDashboard;
  return null;
}
