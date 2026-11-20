import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { Search, User, Loader2, AlertTriangle } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn, decodeHtmlEntities } from '@/lib/utils';
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
  /** A busca falhou (rede/edge) — distinto de "nenhum encontrado". */
  searchFalhou?: boolean;
  onTentarDeNovo?: () => void;
  /** Itens no carrinho: "Trocar" limpa carrinho + OC, então pede confirmação quando > 0. */
  itensNoCarrinho?: number;
}

export function CustomerSearch({
  selectedCustomer, customerUserId, customerSearch, onSearchChange,
  customers, searchingCustomers, loadingCustomer,
  validatingVendedor, vendedorDivergencias,
  onSelectCustomer, onClearCustomer,
  searchFalhou = false, onTentarDeNovo, itensNoCarrinho = 0,
}: CustomerSearchProps) {
  const [confirmarTroca, setConfirmarTroca] = useState(false);
  const termoValido = customerSearch.trim().length >= 2;
  const semResultado = termoValido && !searchingCustomers && !loadingCustomer && !searchFalhou && customers.length === 0;
  const pedirTroca = () => {
    if (itensNoCarrinho > 0) setConfirmarTroca(true);
    else onClearCustomer();
  };
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
                <p className="font-medium text-sm">{decodeHtmlEntities(selectedCustomer.nome_fantasia || selectedCustomer.razao_social)}</p>
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
                {loadingCustomer ? (
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1" role="status">
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Verificando cadastro…
                  </p>
                ) : !customerUserId && <p className="text-xs text-status-warning mt-0.5">Sem cadastro no app</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={pedirTroca} aria-label="Trocar cliente">Trocar</Button>
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                aria-label="Buscar cliente por nome ou CPF/CNPJ"
                placeholder="Nome, fantasia ou CPF/CNPJ do cliente"
                value={customerSearch}
                onChange={e => onSearchChange(e.target.value)}
                autoFocus
                autoComplete="off"
                className="pl-9 h-10"
              />
            </div>
            <div role="status" aria-live="polite" className="empty:hidden">
              {(loadingCustomer || searchingCustomers) ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Buscando…
                </p>
              ) : searchFalhou ? (
                <p className="flex items-center gap-2 text-sm text-status-error">
                  <AlertTriangle className="w-4 h-4" aria-hidden />
                  Não consegui buscar clientes agora.
                  {onTentarDeNovo && <button type="button" className="underline underline-offset-2" onClick={onTentarDeNovo}>Tentar de novo</button>}
                </p>
              ) : semResultado ? (
                <p className="text-sm text-muted-foreground">Nenhum cliente encontrado para “{customerSearch.trim()}”.</p>
              ) : customerSearch.trim().length === 1 ? (
                <p className="text-xs text-muted-foreground">Digite ao menos 2 caracteres.</p>
              ) : null}
            </div>
            {customers.length > 0 && (
              <div className={cn('border rounded-lg divide-y max-h-64 overflow-y-auto transition-opacity', searchingCustomers && 'opacity-50')}>
                {customers.map(c => (
                  <button type="button" key={c.codigo_cliente} className="w-full text-left px-3 py-2 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset transition-colors" onClick={() => onSelectCustomer(c)} disabled={loadingCustomer || searchingCustomers}>
                    <p className="text-sm font-medium">{decodeHtmlEntities(c.nome_fantasia || c.razao_social)}</p>
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">{c.cnpj_cpf || 'Sem documento'}{c.contato ? ` • ${c.contato}` : ''}</span>
                      {c.tags && c.tags.length > 0 && c.tags.map((tag, i) => (
                        <Badge key={i} variant="outline" className="text-[8px] px-1 py-0">{tag}</Badge>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirmarTroca} onOpenChange={setConfirmarTroca}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar de cliente?</AlertDialogTitle>
            <AlertDialogDescription>
              {itensNoCarrinho === 1 ? 'O item do carrinho' : `Os ${itensNoCarrinho} itens do carrinho`} e a ordem de compra serão descartados — os preços são do cliente atual.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar com este cliente</AlertDialogCancel>
            <AlertDialogAction onClick={onClearCustomer}>Trocar e limpar carrinho</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
