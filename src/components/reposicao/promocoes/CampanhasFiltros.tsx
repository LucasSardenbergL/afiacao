// Filtros (estado/fornecedor/busca) da lista de campanhas (Promoções).
// Extraído de src/pages/AdminReposicaoPromocoes.tsx (god-component split).
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search } from "lucide-react";
import { ESTADOS, ALL } from "./types";

export function CampanhasFiltros({
  filtroEstado, setFiltroEstado, filtroFornecedor, setFiltroFornecedor, busca, setBusca, fornecedores,
}: {
  filtroEstado: string;
  setFiltroEstado: (v: string) => void;
  filtroFornecedor: string;
  setFiltroFornecedor: (v: string) => void;
  busca: string;
  setBusca: (v: string) => void;
  fornecedores: string[];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <Select value={filtroEstado} onValueChange={setFiltroEstado}>
        <SelectTrigger>
          <SelectValue placeholder="Estado" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os estados</SelectItem>
          {ESTADOS.map((e) => (
            <SelectItem key={e.value} value={e.value}>
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
        <SelectTrigger>
          <SelectValue placeholder="Fornecedor" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
          {fornecedores.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="md:col-span-2 relative">
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome…"
          className="pl-9"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>
    </div>
  );
}
