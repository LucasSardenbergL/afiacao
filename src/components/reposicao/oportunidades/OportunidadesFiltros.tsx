// Filtros da tabela de oportunidades (cenários/fornecedor/ordenação/switch).
// Extraído de src/pages/AdminReposicaoOportunidades.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { ChevronRight } from "lucide-react";
import { ALL, CENARIOS, cenarioIcon } from "./shared";
import type { Cenario, OrdemKey } from "./types";

export function OportunidadesFiltros({
  cenariosSelecionados, cenariosLabel, toggleCenario,
  filtroFornecedor, setFiltroFornecedor, fornecedoresUnicos,
  ordenacao, setOrdenacao, apenasComEconomia, setApenasComEconomia,
}: {
  cenariosSelecionados: Set<Cenario>;
  cenariosLabel: string;
  toggleCenario: (c: Cenario, checked: boolean) => void;
  filtroFornecedor: string;
  setFiltroFornecedor: (v: string) => void;
  fornecedoresUnicos: string[];
  ordenacao: OrdemKey;
  setOrdenacao: (v: OrdemKey) => void;
  apenasComEconomia: boolean;
  setApenasComEconomia: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="justify-between">
            {cenariosLabel}
            <ChevronRight className="h-4 w-4 rotate-90 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          {CENARIOS.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.value}
              checked={cenariosSelecionados.has(c.value)}
              onCheckedChange={(checked) => toggleCenario(c.value, !!checked)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="flex items-center gap-2">
                {cenarioIcon(c.value)}
                {c.label}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
        <SelectTrigger>
          <SelectValue placeholder="Fornecedor" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
          {fornecedoresUnicos.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={ordenacao} onValueChange={(v) => setOrdenacao(v as OrdemKey)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="net">Maior ganho líquido (net R$)</SelectItem>
          <SelectItem value="economia">Maior economia bruta</SelectItem>
          <SelectItem value="data_limite">Data limite mais próxima</SelectItem>
          <SelectItem value="desconto">Maior % desconto</SelectItem>
          <SelectItem value="sku">SKU alfabético</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex items-center justify-end gap-2 px-2">
        <Switch
          id="apenas-economia"
          checked={apenasComEconomia}
          onCheckedChange={setApenasComEconomia}
        />
        <Label htmlFor="apenas-economia" className="text-sm cursor-pointer">
          Apenas com economia &gt; 0
        </Label>
      </div>
    </div>
  );
}
