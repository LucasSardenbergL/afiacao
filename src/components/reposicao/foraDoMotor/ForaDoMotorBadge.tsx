import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronRight, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { REPOSICAO_EMPRESA } from "@/hooks/useReposicaoSessao";
import { contarForaDoMotor } from "./api";

export const ROTA_FORA_DO_MOTOR = "/admin/reposicao/sessao/parametros?tab=ajuste&filtro=fora_do_motor";

/**
 * Aviso do cockpit: SKUs que VENDEM e que o motor não sugere porque a reposição automática deles está
 * desligada sem que ninguém tenha decidido isso (inativação no Omie que não religou na volta, ou linha
 * que nasceu com o default false). O cockpit só mostra o que o motor gera — sem este aviso, esses SKUs
 * somem daqui em silêncio (FCA.7090QT, com 6 un em pedido aberto, em 2026-09-29).
 *
 * Irmão do BaixoGiroBadge (atalho discreto), com uma diferença de propósito: se o sensor falhar, ele
 * DIZ que não conseguiu consultar em vez de sumir — sumir calado é exatamente o defeito que ele vigia.
 */
export function ForaDoMotorBadge() {
  const navigate = useNavigate();
  const { data: n, isError } = useQuery({
    queryKey: ["reposicao-fora-do-motor", "contagem", REPOSICAO_EMPRESA],
    queryFn: () => contarForaDoMotor(REPOSICAO_EMPRESA),
  });

  if (!isError && !n) return null; // carregando, ou nenhum SKU fora do motor

  const abrir = () => {
    track("reposicao.fora_do_motor_aberto", { skus: n ?? null });
    navigate(ROTA_FORA_DO_MOTOR);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={abrir}
      className={
        isError
          ? "w-fit text-muted-foreground hover:text-foreground"
          : "w-fit border-status-warning/40 text-status-warning hover:text-status-warning"
      }
      title={
        isError
          ? "Não consegui consultar os SKUs fora do motor — abra a Revisão para conferir"
          : "Vendem, mas a reposição automática está desligada: o motor não os sugere nem abaixo do ponto de pedido"
      }
    >
      <EyeOff className="h-4 w-4 mr-1.5" />
      Fora do motor
      <span className="mx-1.5 opacity-40" aria-hidden="true">·</span>
      {isError ? (
        <span>não consegui consultar</span>
      ) : (
        <span className="font-medium tabular-nums">
          {n} {n === 1 ? "SKU vende e não é sugerido" : "SKUs vendem e não são sugeridos"}
        </span>
      )}
      <ChevronRight className="h-4 w-4 ml-1.5 opacity-60" />
    </Button>
  );
}
