import { History } from "lucide-react";
import { EtapaHeader } from "@/components/reposicao/EtapaHeader";
import { HistoricoComChart } from "@/components/reposicao/HistoricoComChart";

export default function AdminReposicaoSessaoHistorico() {
  return (
    <div className="space-y-6">
      <EtapaHeader
        step={0}
        icon={History}
        title="Histórico"
        subtitle="Ciclos anteriores, comparativo e drill-down"
      />
      <HistoricoComChart />
    </div>
  );
}
