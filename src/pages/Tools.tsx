import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AddToolDialog } from '@/components/AddToolDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Wrench, Calendar, Trash2, Hash, Users } from 'lucide-react';
import { differenceInDays } from 'date-fns';
import { cn } from '@/lib/utils';
import { useUserTools, useToolCategories } from '@/queries/useUserTools';
import { useQueryClient } from '@tanstack/react-query';

const Tools = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isStaff } = useUserRole();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: tools = [], isLoading: loading } = useUserTools(user?.id);
  const { data: categories = [] } = useToolCategories();
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase
        .from('user_tools')
        .delete()
        .eq('id', toolId);

      if (error) throw error;

      toast({ title: 'Ferramenta removida' });
      queryClient.invalidateQueries({ queryKey: ['user-tools', user?.id] });
    } catch (error) {
      console.error('Error deleting tool:', error);
      toast({ title: 'Erro ao remover', variant: 'destructive' });
    }
  };

  const handleToolAdded = () => {
    queryClient.invalidateQueries({ queryKey: ['user-tools', user?.id] });
  };




  const getToolStatus = (tool: typeof tools[number]) => {
    if (!tool.next_sharpening_due) {
      return { status: 'unknown', label: 'Sem data', color: 'text-muted-foreground', bg: 'bg-muted' };
    }
    
    const daysUntilDue = differenceInDays(new Date(tool.next_sharpening_due), new Date());
    
    if (daysUntilDue < 0) {
      return { status: 'overdue', label: 'Atrasado', color: 'text-destructive', bg: 'bg-destructive/10' };
    } else if (daysUntilDue <= 7) {
      return { status: 'soon', label: 'Em breve', color: 'text-amber-600', bg: 'bg-amber-100' };
    } else {
      return { status: 'ok', label: 'Em dia', color: 'text-emerald-600', bg: 'bg-emerald-100' };
    }
  };

  const getToolDisplayName = (tool: typeof tools[number]): string => {
    return tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Minhas Ferramentas" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  // Staff should not manage their own tools - redirect to customer management
  if (isStaff) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Ferramentas" showBack />
        <main className="pt-16 px-4 max-w-lg mx-auto">
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground mb-2">Gestão de Ferramentas</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
              Como funcionário, as ferramentas são cadastradas para os clientes. Acesse a gestão de clientes ou crie um novo pedido.
            </p>
            <div className="space-y-3">
              <Button onClick={() => navigate('/admin/customers')} className="w-full">
                <Users className="w-4 h-4 mr-2" />
                Gestão de Clientes
              </Button>
              <Button variant="outline" onClick={() => navigate('/new-order')} className="w-full">
                <Plus className="w-4 h-4 mr-2" />
                Novo Pedido
              </Button>
            </div>
          </div>
        </main>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title="Minhas Ferramentas" 
        showBack 
        rightElement={
          <Button 
            size="icon" 
            variant="ghost" 
            className="rounded-full"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="w-5 h-5" />
          </Button>
        }
      />

      <AddToolDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onToolAdded={handleToolAdded}
        categories={categories}
      />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-card rounded-xl p-4 border border-border text-center">
            <p className="text-2xl font-bold text-foreground">{tools.length}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </div>
          <div className="bg-card rounded-xl p-4 border border-border text-center">
            <p className="text-2xl font-bold text-amber-600">
              {tools.filter(t => {
                const status = getToolStatus(t);
                return status.status === 'soon' || status.status === 'overdue';
              }).length}
            </p>
            <p className="text-xs text-muted-foreground">Precisam afiar</p>
          </div>
          <div className="bg-card rounded-xl p-4 border border-border text-center">
            <p className="text-2xl font-bold text-emerald-600">
              {tools.filter(t => getToolStatus(t).status === 'ok').length}
            </p>
            <p className="text-xs text-muted-foreground">Em dia</p>
          </div>
        </div>

        {/* Tools list */}
        {tools.length > 0 ? (
          <div className="space-y-3">
            {tools.map((tool) => {
              const status = getToolStatus(tool);
              const daysUntilDue = tool.next_sharpening_due 
                ? differenceInDays(new Date(tool.next_sharpening_due), new Date())
                : null;
              const displayName = getToolDisplayName(tool);

              return (
                <Card 
                  key={tool.id} 
                  className="overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => navigate(`/tools/${tool.id}`)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        'w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0',
                        status.bg
                      )}>
                        <Wrench className={cn('w-6 h-6', status.color)} />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h3 className="font-semibold text-foreground text-sm leading-tight">
                              {displayName}
                            </h3>
                            {tool.generated_name && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {tool.tool_categories?.name}
                              </p>
                            )}
                            {tool.internal_code && (
                              <div className="flex items-center gap-1 mt-0.5">
                                <Hash className="w-3 h-3 text-muted-foreground" />
                                <span className="text-xs font-mono font-semibold text-primary">
                                  {tool.internal_code}
                                </span>
                              </div>
                            )}
                          </div>
                          <span className={cn(
                            'text-xs font-medium px-2 py-1 rounded-full flex-shrink-0',
                            status.bg, status.color
                          )}>
                            {status.label}
                          </span>
                        </div>
                        
                        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                          {tool.quantity && tool.quantity > 1 && (
                            <span>Qtd: {tool.quantity}</span>
                          )}
                          {tool.next_sharpening_due && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {daysUntilDue !== null && daysUntilDue < 0 
                                ? `${Math.abs(daysUntilDue)} dias atrasado`
                                : daysUntilDue === 0 
                                  ? 'Hoje'
                                  : `Em ${daysUntilDue} dias`
                              }
                            </span>
                          )}
                        </div>
                      </div>

                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); handleDeleteTool(tool.id); }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Wrench className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground mb-2">Nenhuma ferramenta cadastrada</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
              Cadastre suas ferramentas para receber lembretes de quando afiar
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Adicionar ferramenta
            </Button>
          </div>
        )}

        {/* Action button */}
        {tools.length > 0 && tools.some(t => {
          const status = getToolStatus(t);
          return status.status === 'soon' || status.status === 'overdue';
        }) && (
          <div className="mt-6">
            <Button className="w-full" onClick={() => navigate('/new-order')}>
              Agendar afiação agora
            </Button>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default Tools;
