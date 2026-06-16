// Card de filtros da revisão (empresa, status, busca, classe consolidada).
// Extraído verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type StatusFilterValue } from "@/lib/reposicao/sku-param";
import { CLASSE_OPTIONS } from "./types";

interface FiltrosCardProps {
  empresa: string;
  statusFilter: StatusFilterValue;
  onStatusChange: (v: StatusFilterValue) => void;
  search: string;
  onSearchChange: (v: string) => void;
  classes: string[];
  toggleClasse: (c: string) => void;
  clearClasses: () => void;
}

export function FiltrosCard({
  empresa,
  statusFilter,
  onStatusChange,
  search,
  onSearchChange,
  classes,
  toggleClasse,
  clearClasses,
}: FiltrosCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Filtros</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <Label className="text-xs">Empresa</Label>
            <Select value={empresa} disabled>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OBEN">OBEN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(v: StatusFilterValue) => onStatusChange(v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="aguardando_fornecedor">
                  Aguardando habilitação de fornecedor
                </SelectItem>
                <SelectItem value="primeira_compra">
                  Candidatos a 1ª compra
                </SelectItem>
                <SelectItem value="descontinuados">
                  Descontinuados
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Busca (código ou descrição)</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                value={search}
                placeholder="Ex: 12345 ou TINTA BASE"
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div>
          <Label className="text-xs">Classe consolidada</Label>
          <div className="flex flex-wrap gap-2 mt-1">
            {CLASSE_OPTIONS.map((c) => (
              <Badge
                key={c}
                variant={classes.includes(c) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => toggleClasse(c)}
              >
                {c}
              </Badge>
            ))}
            {classes.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearClasses}>
                Limpar
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
