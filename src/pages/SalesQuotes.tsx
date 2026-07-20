import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, Send, FileText, ChevronLeft, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { findInvalidPricedOmieItems, invalidOmieItemPriceMessage } from '@/services/orderSubmission/priceGuard';
import { cn } from '@/lib/utils';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type SalesOrder = Tables<'sales_orders'>;

interface QuoteItem {
  omie_codigo_produto?: string;
  quantidade: number;
  valor_unitario: number;
  descricao: string;
  tint_cor_id?: string;
  tint_nome_cor?: string;
  // Fase 3: metadados de precificação persistidos no orçamento (podem estar
  // ausentes em orçamento legado — o gate usa o piso min(fontes) nesse caso)
  tint_formula_id?: string;
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
}

const SalesQuotes = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [converting, setConverting] = useState<string | null>(null);
  // Orçamento destacado por ter item de produto a preço ≤ 0 (guard money-path da conversão).
  const [invalidQuoteId, setInvalidQuoteId] = useState<string | null>(null);

  const { data: quotes, isLoading } = useQuery({
    queryKey: ['sales-quotes'],
    queryFn: async () => {
      // Colunas explícitas (PR0.0-bis): omie_payload/omie_response foram fechados à leitura
      // de `authenticated` — um `.select('*')` daria 42501 (o * inteiro cai). Esta tela não
      // usa payload, então basta enumerar o que consome.
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, customer_user_id, account, items, total, notes, created_at, status')
        .eq('status', 'orcamento')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SalesOrder[];
    },
    enabled: !!user,
  });

  // Fetch customer names from profiles
  const customerIds = [...new Set((quotes || []).map(q => q.customer_user_id))];
  const { data: profiles } = useQuery({
    queryKey: ['quote-profiles', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      const { data } = await supabase.from('profiles').select('user_id, name').in('user_id', customerIds);
      return data || [];
    },
    enabled: customerIds.length > 0,
  });

  const getCustomerName = (userId: string) => {
    const profile = profiles?.find(p => p.user_id === userId);
    return profile?.name || userId.slice(0, 8);
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('sales_orders').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      toast.success('Orçamento excluído');
    },
    onError: (e: Error) => toast.error('Erro ao excluir: ' + e.message),
  });

  const convertToOrder = async (quote: SalesOrder) => {
    // ── Guard money-path (4ª via) ──
    // A conversão orçamento→pedido NÃO passa por submitOrder/submitQuote — vai direto ao
    // edge omie-vendas-sync (criar_pedido). Um orçamento com produto a preço ≤ 0 (criado
    // antes do guard, ou por qualquer outra via) viraria um PV COBRADO no Omie. Bloqueia
    // ANTES do update de status e da chamada ao edge (fail-closed). O edge também rejeita
    // (defense-in-depth). Orçamento só tem produto (afiação tem fluxo próprio), então
    // preço ≤ 0 / NaN / Infinity é sempre erro — mesmo predicado do guard do carrinho.
    const quoteItems = (quote.items as unknown as QuoteItem[]) || [];
    const invalidPriced = findInvalidPricedOmieItems(quoteItems);
    if (invalidPriced.length > 0) {
      setInvalidQuoteId(quote.id);
      toast.error(invalidOmieItemPriceMessage(invalidPriced));
      return;
    }
    setInvalidQuoteId(null);
    setConverting(quote.id);
    try {
      // ── Identidade Omie: derivada na FRONTEIRA (edge criar_pedido), P0-B ──
      // O edge prova a identidade AUTORITATIVA do documento do pedido (customer_document) por-conta —
      // prova positiva imune ao espelho parcial (oben = 0 linhas, que fail-closava TODA conversão oben) e
      // ao fallback customer_user_id. Passamos só sales_order_id + account + items; o fail-closed vive no
      // edge. Await (não fire-and-forget) p/ saber o desfecho e NÃO deixar status órfão numa falha.
      const account = quote.account || 'oben';
      const items = ((quote.items as unknown as QuoteItem[]) || []).map((i: QuoteItem) => ({
        omie_codigo_produto: i.omie_codigo_produto,
        quantidade: i.quantidade,
        valor_unitario: i.valor_unitario,
        descricao: i.descricao,
        ...(i.tint_cor_id ? {
          tint_cor_id: i.tint_cor_id,
          tint_nome_cor: i.tint_nome_cor,
          // Fase 3: o gate da fronteira revalida a fonte declarada no orçamento
          ...(i.tint_formula_id ? { tint_formula_id: i.tint_formula_id } : {}),
          ...(i.tint_price_source ? {
            tint_price_source: i.tint_price_source,
            tint_discount_pct: i.tint_discount_pct ?? 0,
            ...(i.tint_preco_sem_desconto != null ? { tint_preco_sem_desconto: i.tint_preco_sem_desconto } : {}),
          } : {}),
        } : {}),
      }));

      toast.info('Enviando pedido para o Omie...');
      const { data: omieData, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'criar_pedido', account, sales_order_id: quote.id, items, observacao: quote.notes },
      });
      if (omieError) {
        // Inclui o fail-closed da derivação (identidade não provada). Orçamento intacto p/ retry.
        toast.error('Não foi possível enviar ao Omie: ' + (omieError.message || 'erro desconhecido'));
        return;
      }
      if ((omieData as { blocked?: string } | null)?.blocked === 'credito') {
        toast.warning('Conversão bloqueada por crédito', {
          description: 'Um gestor pode aprovar uma exceção para este pedido; depois é só reconverter.',
        });
        return;
      }
      if ((omieData as { blocked?: string } | null)?.blocked === 'tint_preco') {
        // Gate tint Fase 3: o preço da tinta no orçamento ficou obsoleto (ou a
        // fórmula mudou/morreu) desde que ele foi salvo. Orçamento intacto.
        const bloqueios = (omieData as { bloqueios?: Array<{ cor_id?: string; detalhe?: string }> }).bloqueios;
        const cores = [...new Set((bloqueios ?? []).map(b => b.cor_id).filter(Boolean))].join(', ');
        setInvalidQuoteId(quote.id);
        toast.error('Conversão bloqueada: preço de tinta desatualizado', {
          description:
            `${cores ? `Cor ${cores}: ` : ''}o preço/fórmula mudou desde que o orçamento foi salvo. ` +
            'Refaça o item de tinta num pedido novo (o balcão recalcula) ou atualize o orçamento.',
          duration: 12000,
        });
        return;
      }

      // Sucesso: marca como pedido (sai da lista de orçamentos). Só AQUI — falha do edge deixa o
      // orçamento intacto, sem status órfão.
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({ status: 'rascunho' })
        .eq('id', quote.id);
      if (updateError) throw updateError;
      queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      toast.success('Orçamento convertido em pedido!');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Erro ao converter: ' + message);
    } finally {
      setConverting(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-20">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Orçamentos</h1>
          <p className="text-xs text-muted-foreground">Gerencie seus orçamentos salvos</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : !quotes?.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Nenhum orçamento encontrado</p>
            <Button variant="outline" className="mt-4" onClick={() => navigate('/sales/new')}>
              Criar novo pedido/orçamento
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {quotes.map(q => {
            const items = (q.items as unknown as QuoteItem[]) || [];
            const itemCount = items.length;
            return (
              <Card key={q.id} className={cn(invalidQuoteId === q.id && 'border-status-error ring-1 ring-status-error')}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{getCustomerName(q.customer_user_id)}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {q.account === 'colacor' ? 'Colacor' : 'Oben'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(q.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        {' · '}{itemCount} {itemCount === 1 ? 'item' : 'itens'}
                      </p>
                      <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                        {items.slice(0, 3).map((item: QuoteItem, idx: number) => (
                          <div key={idx} className="truncate">
                            {item.quantidade}x {item.descricao} – {fmt(item.valor_unitario)}
                          </div>
                        ))}
                        {items.length > 3 && <div className="text-muted-foreground/60">+{items.length - 3} mais...</div>}
                      </div>
                      <p className="text-sm font-semibold mt-2">{fmt(q.total)}</p>
                      {invalidQuoteId === q.id && (
                        <p className="mt-2 text-xs text-status-error flex items-center gap-1">
                          <AlertCircle className="w-3 h-3 shrink-0" />
                          Item com preço R$ 0 ou inválido — edite o orçamento antes de enviar.
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => convertToOrder(q)}
                        disabled={converting === q.id || deleteMutation.isPending}
                      >
                        {converting === q.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        Enviar Pedido
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="gap-1.5"
                            disabled={converting === q.id || deleteMutation.isPending}
                          >
                            {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            Excluir
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Excluir orçamento?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Esta ação irá excluir o orçamento permanentemente. Não é possível desfazer.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteMutation.mutate(q.id)}>Excluir</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SalesQuotes;
