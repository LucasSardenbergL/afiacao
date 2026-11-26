import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useEffect, useId, useRef, useState } from 'react';
import { Search, User, Loader2, AlertTriangle } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn, decodeHtmlEntities } from '@/lib/utils';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';
import type { EstadoVendedor } from '@/hooks/unifiedOrder/validacao-vendedor';
import type { EstadoCadastro } from '@/hooks/unifiedOrder/cadastro-cliente';

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
  /** 8.1: 'indisponivel' e 'divergente' (com ou sem lista) avisam e bloqueiam o envio; a única saída é "Trocar" (sem revalidar). */
  estadoVendedor?: EstadoVendedor;
  /** 8.2: 'indisponivel' (a busca falhou) → "Revalidar cadastro"; 'sem_cadastro' → "Criar cadastro no app".
   *  Os dois bloqueiam o envio e nenhum limpa o carrinho. */
  estadoCadastro?: EstadoCadastro;
  onRevalidarCadastro?: () => void;
  onCriarCadastro?: () => void;
  criandoCadastro?: boolean;
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
  validatingVendedor, vendedorDivergencias, estadoVendedor,
  estadoCadastro, onRevalidarCadastro, onCriarCadastro, criandoCadastro = false,
  onSelectCustomer, onClearCustomer,
  searchFalhou = false, onTentarDeNovo, itensNoCarrinho = 0,
}: CustomerSearchProps) {
  const [confirmarTroca, setConfirmarTroca] = useState(false);
  // Combobox: ↑/↓ percorrem os resultados sem sair do campo, Enter escolhe, Esc limpa.
  const [ativo, setAtivo] = useState(-1);
  const listaId = useId();
  const listaRef = useRef<HTMLDivElement>(null);
  const bloqueado = loadingCustomer || searchingCustomers;
  // Lista nova (outro termo) → nada pré-destacado: Enter não escolhe às cegas o 1º de uma lista velha.
  useEffect(() => { setAtivo(-1); }, [customers]);
  useEffect(() => {
    if (ativo < 0) return;
    listaRef.current?.querySelector<HTMLElement>(`[data-indice="${ativo}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [ativo]);
  const opcaoId = (c: OmieCustomer) => `${listaId}-${c.codigo_cliente}`;
  const onTeclaBusca = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && customers.length > 0) {
      e.preventDefault(); setAtivo((i) => Math.min(i + 1, customers.length - 1));
    } else if (e.key === 'ArrowUp' && customers.length > 0) {
      e.preventDefault(); setAtivo((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      // Enter sem destaque só escolhe quando há UM resultado (inequívoco).
      const alvo = ativo >= 0 ? customers[ativo] : customers.length === 1 ? customers[0] : undefined;
      if (alvo && !bloqueado) { e.preventDefault(); onSelectCustomer(alvo); }
    } else if (e.key === 'Escape' && customerSearch) {
      e.preventDefault(); onSearchChange('');
    }
  };
  // Teclado físico: foco já na busca. Toque: não abre o teclado virtual sozinho.
  const focoAutomatico = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
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
            {estadoCadastro === 'indisponivel' && (
              <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-3" role="alert" data-testid="cadastro-indisponivel">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" aria-hidden />
                  <div className="flex-1">
                    <p className="text-xs font-semibold">Não foi possível identificar o cliente no app</p>
                    <p className="text-xs text-muted-foreground mt-1">O envio fica bloqueado até o cadastro ser confirmado. O carrinho é mantido.</p>
                  </div>
                  {onRevalidarCadastro && (
                    <Button variant="outline" size="sm" onClick={onRevalidarCadastro}>Revalidar cadastro</Button>
                  )}
                </div>
              </div>
            )}
            {estadoCadastro === 'sem_cadastro' && (
              <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-3" role="alert" data-testid="cadastro-ausente">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" aria-hidden />
                  <div className="flex-1">
                    <p className="text-xs font-semibold">Cliente sem cadastro no app</p>
                    <p className="text-xs text-muted-foreground mt-1">Crie o cadastro para enviar o pedido no nome do cliente. O carrinho é mantido.</p>
                  </div>
                  {onCriarCadastro && (
                    <Button variant="outline" size="sm" onClick={onCriarCadastro} disabled={criandoCadastro}>
                      {criandoCadastro ? 'Criando…' : 'Criar cadastro no app'}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {estadoVendedor === 'indisponivel' && (
              <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-3" role="alert">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" aria-hidden />
                  <div className="flex-1">
                    <p className="text-xs font-semibold">Não foi possível validar o vendedor</p>
                    <p className="text-xs text-muted-foreground mt-1">O envio fica bloqueado. Use “Trocar” e selecione o cliente de novo.</p>
                    {/* SEM "Tentar de novo" (4ª rodada do Codex, P0; decisão do founder: só Trocar): a resposta que chega
                        depois do prazo é descartada, e na 2ª consulta a conta divergente que falha some da comparação
                        (lacuna da edge, Onda 3) → liberaria divergência real; e revalidar não recarrega os códigos de
                        vendedor da seleção. Só a seleção nova recarrega tudo. */}
                  </div>
                </div>
              </div>
            )}
            {(vendedorDivergencias.length > 0 || estadoVendedor === 'divergente') && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3" data-testid="vendedor-divergente">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-destructive">Vendedor divergente entre contas Omie</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {vendedorDivergencias.length > 0
                        ? 'Corrija no Omie antes de prosseguir:'
                        : 'O Omie apontou divergência sem detalhar as contas. Corrija no Omie antes de prosseguir.'}
                    </p>
                    {vendedorDivergencias.length > 0 && (
                      <ul className="text-xs mt-1 space-y-0.5">
                        {vendedorDivergencias.map((d, i) => (
                          <li key={i} className="text-destructive font-medium">• {d}</li>
                        ))}
                      </ul>
                    )}
                    {/* SEM "Revalidar" aqui (3ª rodada do Codex, 2 P0): a revalidação não recarrega os códigos de
                        vendedor da seleção (a OS sairia com o antigo) e uma conta que falha some da comparação
                        (lacuna da edge, Onda 3) — liberaria divergência real. Só a seleção nova recarrega tudo. */}
                    <p className="text-xs text-muted-foreground mt-1">Depois de corrigir, use “Trocar” e selecione o cliente de novo.</p>
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
                role="combobox"
                data-atalho="busca-cliente"
                aria-label="Buscar cliente por nome ou CPF/CNPJ"
                aria-autocomplete="list"
                aria-expanded={customers.length > 0}
                aria-controls={listaId}
                aria-activedescendant={ativo >= 0 && customers[ativo] ? opcaoId(customers[ativo]) : undefined}
                placeholder="Nome, fantasia ou CPF/CNPJ do cliente"
                value={customerSearch}
                onChange={e => onSearchChange(e.target.value)}
                onKeyDown={onTeclaBusca}
                autoFocus={focoAutomatico}
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
              <div
                id={listaId}
                ref={listaRef}
                role="listbox"
                aria-label="Clientes encontrados"
                className={cn('border rounded-lg divide-y max-h-64 overflow-y-auto transition-opacity', searchingCustomers && 'opacity-50')}
              >
                {customers.map((c, i) => (
                  <div
                    key={c.codigo_cliente}
                    id={opcaoId(c)}
                    data-indice={i}
                    role="option"
                    aria-selected={i === ativo}
                    aria-disabled={bloqueado || undefined}
                    // mousedown não rouba o foco do campo (o combobox segue no teclado).
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setAtivo(i)}
                    onClick={() => { if (!bloqueado) onSelectCustomer(c); }}
                    className={cn(
                      'w-full cursor-pointer text-left px-3 py-2 transition-colors [@media(pointer:coarse)]:py-3',
                      i === ativo ? 'bg-muted' : 'hover:bg-muted/50',
                      bloqueado && 'cursor-wait',
                    )}
                  >
                    <p className="text-sm font-medium">{decodeHtmlEntities(c.nome_fantasia || c.razao_social)}</p>
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">{c.cnpj_cpf || 'Sem documento'}{c.contato ? ` • ${c.contato}` : ''}</span>
                      {c.tags && c.tags.length > 0 && c.tags.map((tag, i) => (
                        <Badge key={i} variant="outline" className="text-[8px] px-1 py-0">{tag}</Badge>
                      ))}
                    </div>
                  </div>
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
