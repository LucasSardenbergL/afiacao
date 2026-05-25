// Card "Inadimplência Crítica — Top 5".
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
import { fmt } from './format';
import type { InadimplenteRow } from './types';

interface TopInadimplentesProps {
  inadimplentes: InadimplenteRow[];
}

export function TopInadimplentes({ inadimplentes }: TopInadimplentesProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-status-error" />
          Inadimplência Crítica — Top 5
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {inadimplentes.map((i, idx) => (
            <div key={idx} className="flex items-center justify-between py-2 border-b last:border-0">
              <div>
                <p className="font-medium text-sm">{i.nome || (i.cnpj ? `CNPJ: ${i.cnpj}` : 'Cliente não identificado')}</p>
                <p className="text-xs text-muted-foreground">{i.qtd_titulos} título(s)</p>
              </div>
              <span className="font-bold text-status-error">{fmt(i.total_vencido)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
