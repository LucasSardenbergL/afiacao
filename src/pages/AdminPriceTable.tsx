import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, DollarSign } from 'lucide-react';

interface DefaultPrice {
  id: string;
  tool_category_id: string;
  spec_filter: Record<string, string>;
  price: number;
  description: string | null;
}

interface ToolCategory {
  id: string;
  name: string;
}

const MASTER_CPF = '013.633.836-47';
const MASTER_CPF_CLEAN = '01363383647';

const AdminPriceTable = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [prices, setPrices] = useState<DefaultPrice[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editedPrices, setEditedPrices] = useState<Record<string, string>>({});
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    if (user) checkAuthorization();
  }, [user]);

  useEffect(() => {
    if (authorized) loadData();
  }, [authorized]);

  const checkAuthorization = async () => {
    if (!user) return;

    // Check if user is admin OR has the master CPF
    const { data: profile } = await supabase
      .from('profiles')
      .select('document')
      .eq('user_id', user.id)
      .single();

    const doc = profile?.document?.replace(/\D/g, '') || '';
    
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (doc === MASTER_CPF_CLEAN || roleData?.role === 'admin') {
      setAuthorized(true);
    } else {
      navigate('/', { replace: true });
    }
  };

  const loadData = async () => {
    try {
      const [pricesRes, catsRes] = await Promise.all([
        supabase.from('default_prices').select('*').order('tool_category_id, description'),
        supabase.from('tool_categories').select('id, name').order('name'),
      ]);

      if (pricesRes.data) {
        setPrices(pricesRes.data.map(p => ({
          ...p,
          spec_filter: (p.spec_filter as Record<string, string>) || {},
        })));
        // Initialize edited prices
        const initial: Record<string, string> = {};
        pricesRes.data.forEach(p => {
          initial[p.id] = p.price.toString();
        });
        setEditedPrices(initial);
      }
      if (catsRes.data) setCategories(catsRes.data);
    } catch (error) {
      console.error('Error loading prices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = Object.entries(editedPrices)
        .filter(([id, val]) => {
          const original = prices.find(p => p.id === id);
          return original && parseFloat(val) !== original.price;
        });

      for (const [id, val] of updates) {
        const { error } = await supabase
          .from('default_prices')
          .update({ price: parseFloat(val) })
          .eq('id', id);
        if (error) throw error;
      }

      toast({
        title: 'Tabela atualizada!',
        description: `${updates.length} preço(s) alterado(s)`,
      });

      loadData();
    } catch (error) {
      console.error('Error saving prices:', error);
      toast({
        title: 'Erro ao salvar',
        description: 'Não foi possível atualizar os preços',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const getCategoryName = (id: string) => categories.find(c => c.id === id)?.name || 'Desconhecido';

  const groupedPrices = prices.reduce<Record<string, DefaultPrice[]>>((acc, p) => {
    const catName = getCategoryName(p.tool_category_id);
    if (!acc[catName]) acc[catName] = [];
    acc[catName].push(p);
    return acc;
  }, {});

  const hasChanges = Object.entries(editedPrices).some(([id, val]) => {
    const original = prices.find(p => p.id === id);
    return original && parseFloat(val) !== original.price;
  });

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Tabela de Preços" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!authorized) return null;

  const categoryNames = Object.keys(groupedPrices).sort();

  const renderFormulaPrice = (price: DefaultPrice) => {
    const filter = price.spec_filter;
    if (filter._formula) {
      return (
        <div className="p-3 bg-muted/50 rounded-lg space-y-2">
          <div className="flex justify-between items-center">
            <div>
              <p className="font-medium text-sm">{price.description}</p>
              <p className="text-xs text-muted-foreground">
                Fórmula: R$ {filter._multiplier} × {filter._formula}
              </p>
            </div>
            <div className="w-24">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={editedPrices[price.id] || '0'}
                onChange={(e) => {
                  // For formula prices, we update the multiplier via spec_filter
                  // For simplicity, we show the multiplier as "price"
                  setEditedPrices(prev => ({ ...prev, [price.id]: e.target.value }));
                }}
                className="h-8 text-right text-sm"
                disabled
              />
            </div>
          </div>
          <p className="text-xs text-amber-600">
            ℹ️ Preço calculado automaticamente: R$ {filter._multiplier} × nº de dentes
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Tabela de Preços" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <DollarSign className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">Gestão de Preços Padrão</h2>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Esses preços são aplicados automaticamente quando não há histórico de preço anterior para o cliente.
        </p>

        <Tabs defaultValue={categoryNames[0]} className="mb-6">
          <TabsList className="w-full flex-wrap h-auto gap-1 bg-muted/50 p-1">
            {categoryNames.map(name => (
              <TabsTrigger key={name} value={name} className="text-xs px-2 py-1">
                {name.length > 15 ? name.substring(0, 15) + '...' : name}
              </TabsTrigger>
            ))}
          </TabsList>

          {categoryNames.map(name => (
            <TabsContent key={name} value={name}>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {groupedPrices[name].map(price => {
                    const formulaEl = renderFormulaPrice(price);
                    if (formulaEl) return <div key={price.id}>{formulaEl}</div>;

                    const isFixed = Object.keys(price.spec_filter).length === 0;
                    const changed = parseFloat(editedPrices[price.id] || '0') !== price.price;

                    return (
                      <div key={price.id} className="flex items-center justify-between gap-3 p-2 bg-muted/30 rounded-lg">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {isFixed ? 'Preço fixo' : price.description}
                          </p>
                          {!isFixed && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {Object.entries(price.spec_filter)
                                .filter(([k]) => !k.startsWith('_'))
                                .map(([key, val]) => (
                                  <Badge key={key} variant="outline" className="text-[10px] px-1 py-0">
                                    {key}: {val}
                                  </Badge>
                                ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">R$</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={editedPrices[price.id] || ''}
                            onChange={(e) => setEditedPrices(prev => ({
                              ...prev,
                              [price.id]: e.target.value,
                            }))}
                            className={`h-8 w-20 text-right text-sm ${changed ? 'border-amber-500 bg-amber-50' : ''}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>

        {hasChanges && (
          <div className="fixed bottom-20 left-0 right-0 px-4 max-w-lg mx-auto">
            <Button
              className="w-full"
              size="lg"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Salvar Alterações
            </Button>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminPriceTable;
