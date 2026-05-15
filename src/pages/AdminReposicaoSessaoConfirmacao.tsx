import { CheckCircle2 } from "lucide-react";
import { EtapaHeader } from "@/components/reposicao/EtapaHeader";
import { EtapaChecklist } from "@/components/reposicao/EtapaChecklist";
import { ConfirmacaoPanel } from "@/components/reposicao/ConfirmacaoPanel";

export default function AdminReposicaoSessaoConfirmacao() {
  return (
    <div className="space-y-6">
      <EtapaHeader
        step={5}
        icon={CheckCircle2}
        title="Confirmação"
        subtitle="Resumo e linha do tempo do ciclo de reposição de hoje"
      />
      <EtapaChecklist step={5} />
      <ConfirmacaoPanel />
    </div>
  );
}
