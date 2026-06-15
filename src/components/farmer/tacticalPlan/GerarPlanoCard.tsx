// Card "Gerar Plano para Qualquer Cliente" (busca + lista + botões essencial/estratégico).
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import { Plus, Loader2, Zap, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import type { PlanType } from '@/hooks/useTacticalPlan';
import type { CustomerLite } from './types';

interface GerarPlanoCardProps {
  searchTerm: string;
  onSearchChange: (v: string) => void;
  filteredCustomers: CustomerLite[];
  generating: string | null;
  onGenerate: (customerId: string, planType: PlanType) => void;
}

export function GerarPlanoCard({
  searchTerm,
  onSearchChange,
  filteredCustomers,
  generating,
  onGenerate,
}: GerarPlanoCardProps) {
  // Lente "Ver como": gerar plano é write (insert) — desabilitado (o write-guard já
  // bloqueia; o disable evita o erro/ruído).
  const { isImpersonating } = useImpersonation();
  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-xs flex items-center gap-2">
          <Plus className="w-3 h-3" /> Gerar Plano para Qualquer Cliente
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <Input
          placeholder="Buscar cliente..."
          value={searchTerm}
          onChange={e => onSearchChange(e.target.value)}
          className="h-8 text-xs"
        />
        <div className="space-y-1.5 max-h-60 overflow-y-auto">
          {filteredCustomers.map(c => (
            <div key={c.id} className="flex items-center justify-between p-2 rounded-lg border text-xs">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  c.healthScore >= 70 ? 'bg-status-success' :
                  c.healthScore >= 40 ? 'bg-status-warning' : 'bg-status-error'
                }`} />
                <span className="truncate font-medium">{c.name}</span>
                <span className="text-[9px] text-muted-foreground shrink-0">HS:{Math.round(c.healthScore)}</span>
              </div>
              <div className="flex gap-1 shrink-0 ml-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[8px] px-2"
                  disabled={generating === c.id || isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
                  onClick={() => onGenerate(c.id, 'essencial')}
                >
                  {generating === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Zap className="w-2.5 h-2.5 mr-0.5" />Essencial</>}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-[8px] px-2"
                  disabled={generating === c.id || isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
                  onClick={() => onGenerate(c.id, 'estrategico')}
                >
                  {generating === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Layers className="w-2.5 h-2.5 mr-0.5" />Estratégico</>}
                </Button>
              </div>
            </div>
          ))}
          {filteredCustomers.length === 0 && (
            <p className="text-[10px] text-muted-foreground text-center py-4">Nenhum cliente encontrado</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
