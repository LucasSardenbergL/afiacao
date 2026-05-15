import { Navigate, useSearchParams } from "react-router-dom";

const TAB_TO_ROUTE: Record<string, string> = {
  ciclohoje: "/admin/reposicao/sessao/pedidos",
  aplicaromie: "/admin/reposicao/sessao/aplicacao",
  confirmacao: "/admin/reposicao/sessao/confirmacao",
  anteriores: "/admin/reposicao/sessao/historico",
  oportunidades: "/admin/reposicao/oportunidades",
};

export default function LegacyCockpitRedirect() {
  const [params] = useSearchParams();
  const tab = params.get("tab");
  const dest = (tab && TAB_TO_ROUTE[tab]) || "/admin/reposicao/sessao";
  return <Navigate to={dest} replace />;
}
