import { Upload } from "lucide-react";
import { EtapaHeader } from "@/components/reposicao/EtapaHeader";
import { EtapaChecklist } from "@/components/reposicao/EtapaChecklist";
import AdminReposicaoAplicacao from "./AdminReposicaoAplicacao";

export default function AdminReposicaoSessaoAplicacao() {
  return (
    <div className="space-y-6">
      <EtapaHeader
        step={4}
        icon={Upload}
        title="Aplicação Omie"
        subtitle="Aplicação dos parâmetros aprovados na integração com o Omie"
      />
      <EtapaChecklist step={4} />
      <AdminReposicaoAplicacao />
    </div>
  );
}
