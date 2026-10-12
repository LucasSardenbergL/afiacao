import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { canonicalizarRota } from "@/lib/analytics-rota-canonica";
import { MODULOS } from "@/lib/modulos/manifesto";
import { ROTA_DESTINO, formatarDataCongelamento, rotaCongelada } from "@/lib/modulos/congelamento";

/**
 * Rota de módulo congelado (M-41) volta para a home com aviso — o código segue no repo.
 * Envolve TODAS as rotas autenticadas no App.tsx (o gate confere). O evento é o sensor do
 * descongelamento: alguém tentou abrir = sinal de uso que a decisão de congelar não tinha.
 */
export function GuardModuloCongelado() {
  const { pathname } = useLocation();
  const congelada = rotaCongelada(pathname, MODULOS);

  useEffect(() => {
    if (!congelada) return;
    toast.info(`${congelada.moduloNome} está congelado até ${formatarDataCongelamento(congelada.ate)}`, {
      description: "Sem uso nos últimos 90 dias. Se precisar dele, avise o Lucas.",
    });
    track("modulo.congelado_acesso", { modulo: congelada.moduloId, rota: canonicalizarRota(pathname) });
    // pathname basta: `congelada` é função pura dele
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (congelada) return <Navigate to={ROTA_DESTINO} replace />;
  return <Outlet />;
}
