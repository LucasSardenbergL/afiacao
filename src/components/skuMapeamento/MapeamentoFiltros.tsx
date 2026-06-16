// Card de filtros do Mapeamento SKU (empresa/fornecedor/status/busca).
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search } from 'lucide-react';

interface MapeamentoFiltrosProps {
  filtroEmpresa: string;
  onFiltroEmpresaChange: (v: string) => void;
  filtroFornecedor: string;
  onFiltroFornecedorChange: (v: string) => void;
  filtroAtivo: string;
  onFiltroAtivoChange: (v: string) => void;
  busca: string;
  onBuscaChange: (v: string) => void;
  empresas: string[];
  fornecedores: string[];
}

export function MapeamentoFiltros({
  filtroEmpresa,
  onFiltroEmpresaChange,
  filtroFornecedor,
  onFiltroFornecedorChange,
  filtroAtivo,
  onFiltroAtivoChange,
  busca,
  onBuscaChange,
  empresas,
  fornecedores,
}: MapeamentoFiltrosProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filtros</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Select value={filtroEmpresa} onValueChange={onFiltroEmpresaChange}>
          <SelectTrigger><SelectValue placeholder="Empresa" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todas as empresas</SelectItem>
            {empresas.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filtroFornecedor} onValueChange={onFiltroFornecedorChange}>
          <SelectTrigger><SelectValue placeholder="Fornecedor" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos os fornecedores</SelectItem>
            {fornecedores.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filtroAtivo} onValueChange={onFiltroAtivoChange}>
          <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos</SelectItem>
            <SelectItem value="ativos">Apenas ativos</SelectItem>
            <SelectItem value="inativos">Apenas inativos</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar SKU ou descrição"
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            className="pl-9"
          />
        </div>
      </CardContent>
    </Card>
  );
}
