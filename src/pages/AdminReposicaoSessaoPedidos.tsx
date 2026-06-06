import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck, ExternalLink } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { CicloHojePanel, ALL } from "@/components/reposicao/CicloHojePanel";
import { useColumnConfig } from "@/components/reposicao/ColumnConfig";
import { useItensDoDia } from "@/hooks/useReposicaoSessao";
import { EtapaHeader } from "@/components/reposicao/EtapaHeader";
import { EtapaChecklist } from "@/components/reposicao/EtapaChecklist";

export default function AdminReposicaoSessaoPedidos() {
  const { user } = useAuth();
  const { data: itensDia = [], isLoading } = useItensDoDia();
  const { cols, update: updateCol } = useColumnConfig();

  const [reviewMode, setReviewMode] = useState(false);
  const [filters, setFilters] = useState({ search: "", fornecedor: ALL, status: ALL });

  const fornecedores = useMemo(
    () =>
      Array.from(new Set(itensDia.map((i) => i.fornecedor_nome).filter((x): x is string => !!x))).sort(),
    [itensDia],
  );
  const statuses = useMemo(
    () => Array.from(new Set(itensDia.map((i) => i.status).filter((x): x is string => !!x))).sort(),
    [itensDia],
  );

  const filteredItems = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return itensDia.filter((i) => {
      if (filters.fornecedor !== ALL && i.fornecedor_nome !== filters.fornecedor) return false;
      if (filters.status !== ALL && i.status !== filters.status) return false;
      if (q) {
        const hay = [i.fornecedor_nome, i.grupo_codigo, i.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [itensDia, filters]);

  return (
    <div className="space-y-6">
      <EtapaHeader
        step={3}
        icon={ClipboardCheck}
        title="Pedidos"
        subtitle="Revisão e aprovação dos pedidos sugeridos para o ciclo de hoje"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/reposicao/pedidos">
              Gerir pedidos (detalhes · conciliar · disparar)
              <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
            </Link>
          </Button>
        }
      />
      <EtapaChecklist step={3} />
      <CicloHojePanel
        user={user}
        reviewMode={reviewMode}
        setReviewMode={setReviewMode}
        filters={filters}
        setFilters={setFilters}
        filteredItems={filteredItems}
        fornecedores={fornecedores}
        statuses={statuses}
        isLoading={isLoading}
        cols={cols}
        onColChange={updateCol}
      />
    </div>
  );
}
