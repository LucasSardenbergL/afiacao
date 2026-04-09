import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, Send, FileText, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const SalesQuotes = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [converting, setConverting] = useState<string | null>(null);

  const { data: quotes, isLoading } = useQuery({
    queryKey: ['sales-quotes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .eq('status', 'orcamento')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  // Fetch customer names
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
  const { data: omieClientes } = useQuery({
    queryKey: ['quote-omie-clientes', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      const { data } = await supabase.from('omie_clientes').select('user_id, razao_social').in('user_id', customerIds);
      return data || [];
    },
    enabled: customerIds.length > 0,
  });

  const getCustomerName = (userId: string) => {
    const omie = omieClientes?.find(c => c.user_id === userId);
    if (omie?.razao_social) return omie.razao_social;
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
    onError: (e: any) => toast.error('Erro ao excluir: ' + e.message),
  });

  const convertToOrder = async (quote: any) => {
    setConverting(quote.id);
    try {
      // Determine customer info from omie_clientes
      const { data: omieClient } = await supabase
        .from('omie_clientes')
        .select('codigo_cliente, codigo_vendedor, codigo_cliente_colacor, codigo_vendedor_colacor')
        .eq('user_id', quote.customer_user_id)
        .maybeSingle();

      const account = quote.account || 'oben';
      const isColacor = account === 'colacor';
      const codigoCliente = isColacor
        ? (omieClient?.codigo_cliente_colacor || omieClient?.codigo_cliente)
        : omieClient?.codigo_cliente;
      const codigoVendedor = isColacor
        ? (omieClient?.codigo_vendedor_colacor ?? omieClient?.codigo_vendedor)
        : omieClient?.codigo_vendedor;

      if (!codigoCliente) {
        toast.error('Cliente não encontrado no Omie. Verifique o cadastro.');
        return;
      }

      // Update status to rascunho
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({ status: 'rascunho' } as any)
        .eq('id', quote.id);
      if (updateError) throw updateError;

      // Send to Omie in background
      const items = (quote.items as any[]).map(i => ({
        omie_codigo_produto: i.omie_codigo_produto,
        quantidade: i.quantidade,
        valor_unitario: i.valor_unitario,
        descricao: i.descricao,
        ...(i.tint_cor_id ? { tint_cor_id: i.tint_cor_id, tint_nome_cor: i.tint_nome_cor } : {}),
      }));

      toast.info('Enviando pedido para o Omie...');

      supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_pedido',
          account,
          sales_order_id: quote.id,
          codigo_cliente: codigoCliente,
          codigo_vendedor: codigoVendedor,
          items,
          observacao: quote.notes,
        },
      }).then(({ error: omieError }) => {
        if (omieError) {
          toast.error('Erro ao sincronizar com Omie: ' + omieError.message);
        } else {
          toast.success('Pedido enviado ao Omie com sucesso!');
        }
        queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      });

      queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      toast.success('Orçamento convertido em pedido!');
    } catch (e: any) {
      toast.error('Erro ao converter: ' + e.message);
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
            const items = (q.items as any[]) || [];
            const itemCount = items.length;
            return (
              <Card key={q.id}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{getCustomerName(q.customer_user_id)}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {(q as any).account === 'colacor' ? 'Colacor' : 'Oben'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(q.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        {' · '}{itemCount} {itemCount === 1 ? 'item' : 'itens'}
                      </p>
                      <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                        {items.slice(0, 3).map((item: any, idx: number) => (
                          <div key={idx} className="truncate">
                            {item.quantidade}x {item.descricao} – {fmt(item.valor_unitario)}
                          </div>
                        ))}
                        {items.length > 3 && <div className="text-muted-foreground/60">+{items.length - 3} mais...</div>}
                      </div>
                      <p className="text-sm font-semibold mt-2">{fmt(q.total)}</p>
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
