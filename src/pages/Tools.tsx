import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Wrench, Calendar, Trash2, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  suggested_interval_days: number | null;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  custom_name: string | null;
  quantity: number | null;
  sharpening_interval_days: number | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  tool_categories: ToolCategory;
}

const Tools = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  
  const [tools, setTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  
  // Form state
  const [selectedCategory, setSelectedCategory] = useState('');
  const [customName, setCustomName] = useState('');
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    
    try {
      // Load categories
      const { data: categoriesData } = await supabase
        .from('tool_categories')
        .select('*')
        .order('name');
      
      if (categoriesData) {
        setCategories(categoriesData);
      }

      // Load user tools
      const { data: toolsData } = await supabase
        .from('user_tools')
        .select(`
          *,
          tool_categories (*)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (toolsData) {
        setTools(toolsData as unknown as UserTool[]);
      }
    } catch (error) {
      console.error('Error loading tools:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTool = async () => {
    if (!user || !selectedCategory) return;
    
    setIsAddingTool(true);
    try {
      const category = categories.find(c => c.id === selectedCategory);
      
      // Don't set next_sharpening_due - it will be calculated automatically
      // based on order history when the user makes their first order
      const { error } = await supabase.from('user_tools').insert({
        user_id: user.id,
        tool_category_id: selectedCategory,
        custom_name: customName || null,
        quantity,
      });

      if (error) throw error;

      toast({
        title: 'Ferramenta adicionada!',
        description: `${category?.name} foi adicionada ao seu inventário. O intervalo de afiação será calculado com base nos seus pedidos.`,
      });

      // Reset form
      setSelectedCategory('');
      setCustomName('');
      setQuantity(1);
      setDialogOpen(false);
      
      // Reload data
      loadData();
    } catch (error) {
      console.error('Error adding tool:', error);
      toast({
        title: 'Erro ao adicionar',
        description: 'Não foi possível adicionar a ferramenta',
        variant: 'destructive',
      });
    } finally {
      setIsAddingTool(false);
    }
  };

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase
        .from('user_tools')
        .delete()
        .eq('id', toolId);

      if (error) throw error;

      toast({
        title: 'Ferramenta removida',
      });

      setTools(tools.filter(t => t.id !== toolId));
    } catch (error) {
      console.error('Error deleting tool:', error);
      toast({
        title: 'Erro ao remover',
        variant: 'destructive',
      });
    }
  };

  const getToolStatus = (tool: UserTool) => {
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

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title="Minhas Ferramentas" 
        showBack 
        rightElement={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="icon" variant="ghost" className="rounded-full">
                <Plus className="w-5 h-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm mx-4">
              <DialogHeader>
                <DialogTitle className="font-display">Adicionar Ferramenta</DialogTitle>
              </DialogHeader>
              
              <div className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>Tipo de ferramenta</Label>
                  <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione..." />
                    </SelectTrigger>
                    <SelectContent className="bg-popover">
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {cat.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Nome personalizado (opcional)</Label>
                  <Input 
                    placeholder="Ex: Faca do chef principal"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Quantidade</Label>
                  <Input 
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </div>

                <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
                  💡 O intervalo de afiação será calculado automaticamente com base na frequência dos seus pedidos.
                </p>

                <Button 
                  className="w-full" 
                  onClick={handleAddTool}
                  disabled={!selectedCategory || isAddingTool}
                >
                  {isAddingTool ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  Adicionar
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
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

              return (
                <Card key={tool.id} className="overflow-hidden">
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
                          <div>
                            <h3 className="font-semibold text-foreground truncate">
                              {tool.custom_name || tool.tool_categories?.name}
                            </h3>
                            {tool.custom_name && (
                              <p className="text-xs text-muted-foreground">
                                {tool.tool_categories?.name}
                              </p>
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
                        onClick={() => handleDeleteTool(tool.id)}
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
