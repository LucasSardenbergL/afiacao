import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, User, Loader2, AlertTriangle } from 'lucide-react';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

interface CustomerSearchProps {
  selectedCustomer: OmieCustomer | null;
  customerUserId: string | null;
  customerSearch: string;
  onSearchChange: (v: string) => void;
  customers: OmieCustomer[];
  searchingCustomers: boolean;
  loadingCustomer: boolean;
  validatingVendedor: boolean;
  vendedorDivergencias: string[];
  onSelectCustomer: (c: OmieCustomer) => void;
  onClearCustomer: () => void;
}

export function CustomerSearch({
  selectedCustomer, customerUserId, customerSearch, onSearchChange,
  customers, searchingCustomers, loadingCustomer,
  validatingVendedor, vendedorDivergencias,
  onSelectCustomer, onClearCustomer,
}: CustomerSearchProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><User className="w-4 h-4" /> Cliente</CardTitle>
      </CardHeader>
      <CardContent>
        {selectedCustomer ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{selectedCustomer.nome_fantasia || selectedCustomer.razao_social}</p>
                <p className="text-xs text-muted-foreground">{selectedCustomer.cnpj_cpf}{selectedCustomer.contato ? ` • ${selectedCustomer.contato}` : ''}</p>
                {selectedCustomer.tags && selectedCustomer.tags.length > 0 && (
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {selectedCustomer.tags.map((tag, i) => (
                      <Badge key={i} variant="outline" className="text-[9px] px-1.5 py-0">{tag}</Badge>
                    ))}
                  </div>
                )}
                {selectedCustomer.atividade && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Atividade: {selectedCustomer.atividade}</p>
                )}
                {!customerUserId && <p className="text-xs text-amber-600 mt-0.5">Sem cadastro no app</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={onClearCustomer}>Trocar</Button>
            </div>
            {validatingVendedor && (
              <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Validando vendedor nos 3 Omies...</p>
              </div>
            )}
            {vendedorDivergencias.length > 0 && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-destructive">Vendedor divergente entre contas Omie</p>
                    <p className="text-xs text-muted-foreground mt-1">Corrija no Omie antes de prosseguir:</p>
                    <ul className="text-xs mt-1 space-y-0.5">
                      {vendedorDivergencias.map((d, i) => (
                        <li key={i} className="text-destructive font-medium">• {d}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Buscar por nome ou CPF/CNPJ..." value={customerSearch} onChange={e => onSearchChange(e.target.value)} className="pl-9 h-9" />
            </div>
            {(loadingCustomer || searchingCustomers) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Buscando...
              </div>
            )}
            {customers.length > 0 && (
              <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                {customers.map(c => (
                  <button key={c.codigo_cliente} className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors" onClick={() => onSelectCustomer(c)} disabled={loadingCustomer}>
                    <p className="text-sm font-medium">{c.nome_fantasia || c.razao_social}</p>
                    <p className="text-xs text-muted-foreground">{c.cnpj_cpf || 'Sem documento'}{c.contato ? ` • ${c.contato}` : ''}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
