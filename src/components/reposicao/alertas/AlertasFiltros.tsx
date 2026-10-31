// Card de filtros + barra de ações em lote dos Alertas de Outlier.
// Extraído de src/pages/AdminReposicaoAlertas.tsx (god-component split).
// Os setters voltam à página 1 por conta própria (uma escrita só na URL — ver a página).
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, CheckCircle2 } from "lucide-react";
import { tipoLabel, tiposDaVisao, type Visao } from "./types";

export function AlertasFiltros({
  visao, busca, setBusca, filtroTipo, setFiltroTipo, filtroSev, setFiltroSev, filtroStatus, setFiltroStatus,
  selecionadosCount, onAceitarLote, onLimparSelecao,
}: {
  visao: Visao;
  busca: string;
  setBusca: (s: string) => void;
  filtroTipo: string;
  setFiltroTipo: (s: string) => void;
  filtroSev: string;
  setFiltroSev: (s: string) => void;
  filtroStatus: string;
  setFiltroStatus: (s: string) => void;
  selecionadosCount: number;
  onAceitarLote: () => void;
  onLimparSelecao: () => void;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <Label className="text-xs">Buscar SKU</Label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                placeholder="Código ou descrição"
                className="pl-8"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
          </div>
          <div className="w-[180px]">
            <Label className="text-xs">Tipo</Label>
            <Select value={filtroTipo} onValueChange={setFiltroTipo}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {tiposDaVisao(visao).map((t) => (
                  <SelectItem key={t} value={t}>{tipoLabel(t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[140px]">
            <Label className="text-xs">Severidade</Label>
            <Select value={filtroSev} onValueChange={setFiltroSev}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas</SelectItem>
                <SelectItem value="critico">Crítico</SelectItem>
                <SelectItem value="atencao">Atenção</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-[140px]">
            <Label className="text-xs">Status</Label>
            <Select value={filtroStatus} onValueChange={setFiltroStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                <SelectItem value="pendente">Pendente</SelectItem>
                <SelectItem value="aceito">Aceito</SelectItem>
                <SelectItem value="resolvido_auto">Resolvido auto</SelectItem>
                <SelectItem value="excluido">Excluído</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {selecionadosCount > 0 && (
          <div className="mt-4 flex gap-2 items-center bg-muted/50 p-3 rounded-md">
            <span className="text-sm font-medium">{selecionadosCount} selecionado(s)</span>
            <Button size="sm" variant="default" onClick={onAceitarLote}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Marcar como revisados
            </Button>
            <Button size="sm" variant="ghost" onClick={onLimparSelecao}>
              Limpar seleção
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
