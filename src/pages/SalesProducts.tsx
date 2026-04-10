import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Search, RefreshCw, Package, ShoppingCart, BarChart3, Building2, ChevronLeft } from 'lucide-react';

type Account = 'oben' | 'colacor';

interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  omie_codigo_produto: number;
  metadata: Record<string, unknown>;
  account?: string;
}

const SalesProducts = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [account, setAccount] = useState<Account>('oben');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingStock, setSyncingStock] = useState(false);
  const [search, setSearch] = useState('');

  const { role } = useAuth();
  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, role, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadProducts();
  }, [isStaff, account]);

  const loadProducts = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('omie_products')
        .select('*')
        .eq('account', account)
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
        .not('familia', 'ilike', 'jumbo%')
        .not('familia', 'ilike', '%material para tingimix%')
        .order('ativo', { ascending: false })
        .order('descricao');

      if (error) throw error;
      setProducts((data || []) as Product[]);
    } catch (error) {
      console.error('Erro ao carregar produtos:', error);
    } finally {
      setLoading(false);
    }
  };

  const syncProducts = async () => {
    setSyncing(true);
    try {
      let nextPage: number | null = 1;
      let totalSynced = 0;
      while (nextPage) {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'sync_products', start_page: nextPage, account },
        });
        if (error) throw error;
        totalSynced += data.totalSynced || 0;
        nextPage = data.nextPage || null;
      }

      toast({
        title: 'Sincronização concluída!',
        description: `${totalSynced} produtos sincronizados (${account === 'oben' ? 'Oben' : 'Colacor'}).`,
      });

      await loadProducts();
    } catch (error: any) {
      console.error('Erro ao sincronizar:', error);
      toast({
        title: 'Erro na sincronização',
        description: error.message || 'Não foi possível sincronizar os produtos.',
        variant: 'destructive',
      });
    } finally {
      setSyncing(false);
    }
  };

  const syncStock = async () => {
    setSyncingStock(true);
    try {
      let nextPage: number | null = 1;
      let totalUpdated = 0;
      while (nextPage) {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'sync_estoque', start_page: nextPage, account },
        });
        if (error) throw error;
        totalUpdated += data.totalUpdated || 0;
        nextPage = data.nextPage || null;
      }
      toast({
        title: 'Estoque atualizado!',
        description: `${totalUpdated} produtos com estoque atualizado (${account === 'oben' ? 'Oben' : 'Colacor'}).`,
      });
      await loadProducts();
    } catch (error: any) {
      console.error('Erro ao sincronizar estoque:', error);
      toast({
        title: 'Erro ao atualizar estoque',
        description: error.message || 'Não foi possível sincronizar o estoque.',
        variant: 'destructive',
      });
    } finally {
      setSyncingStock(false);
    }
  };

  const filteredProducts = products.filter(
    (p) =>
      p.descricao.toLowerCase().includes(search.toLowerCase()) ||
      p.codigo.toLowerCase().includes(search.toLowerCase())
  );

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">Catálogo</h1>
            <p className="text-xs text-muted-foreground">Produtos disponíveis para venda</p>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={syncStock}
            disabled={syncingStock}
            title="Atualizar estoque"
          >
            <BarChart3 className={`w-4 h-4 ${syncingStock ? 'animate-pulse' : ''}`} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={syncProducts}
            disabled={syncing}
            title="Sincronizar produtos"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Account Tabs */}
      <Tabs value={account} onValueChange={(v) => setAccount(v as Account)}>
        <TabsList className="w-full grid grid-cols-2">
          <TabsTrigger value="oben" className="gap-1.5">
            <Building2 className="w-3.5 h-3.5" />
            Oben
          </TabsTrigger>
          <TabsTrigger value="colacor" className="gap-1.5">
            <Building2 className="w-3.5 h-3.5" />
            Colacor
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Search + New Order */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar produto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={() => navigate('/sales/new')} className="gap-2">
          <ShoppingCart className="w-4 h-4" />
          Vender
        </Button>
      </div>

      {/* Stats */}
      <div className="flex gap-3">
        <Badge variant="secondary" className="gap-1">
          <Package className="w-3 h-3" />
          {products.length} produtos
        </Badge>
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Building2 className="w-3 h-3" />
          {account === 'oben' ? 'Oben' : 'Colacor'}
        </Badge>
      </div>

      {/* Products list */}
      {filteredProducts.length === 0 ? (
        <div className="text-center py-12">
          <Package className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">
            {products.length === 0
              ? 'Nenhum produto sincronizado. Clique no botão de atualização.'
              : 'Nenhum produto encontrado para a busca.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredProducts.map((product) => (
            <Card key={product.id} className="overflow-hidden">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground truncate">
                      {product.descricao}
                    </p>
                    {!product.ativo && (
                      <Badge variant="destructive" className="text-[10px] mt-0.5">
                        Inativo
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Cód: {product.codigo} · {product.unidade}
                    </p>
                    {product.metadata?.marca && (
                      <p className="text-xs text-muted-foreground">
                        Marca: {String(product.metadata.marca)}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm text-foreground">
                      R$ {product.valor_unitario.toFixed(2)}
                    </p>
                    <Badge 
                      variant={product.estoque > 10 ? 'secondary' : product.estoque > 0 ? 'outline' : 'destructive'}
                      className="text-[10px] mt-1"
                    >
                      Est: {product.estoque}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default SalesProducts;
