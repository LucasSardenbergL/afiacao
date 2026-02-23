import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Search, RefreshCw, Package, ShoppingCart } from 'lucide-react';

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
}

const SalesProducts = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadProducts();
  }, [isStaff]);

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('omie_products')
        .select('*')
        .eq('ativo', true)
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
          body: { action: 'sync_products', start_page: nextPage },
        });
        if (error) throw error;
        totalSynced += data.totalSynced || 0;
        nextPage = data.nextPage || null;
      }

      toast({
        title: 'Sincronização concluída!',
        description: `${totalSynced} produtos sincronizados do Omie.`,
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

  const filteredProducts = products.filter(
    (p) =>
      p.descricao.toLowerCase().includes(search.toLowerCase()) ||
      p.codigo.toLowerCase().includes(search.toLowerCase())
  );

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Catálogo de Produtos" showBack />
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
        title="Catálogo de Produtos"
        showBack
        rightElement={
          <Button
            size="sm"
            variant="ghost"
            onClick={syncProducts}
            disabled={syncing}
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </Button>
        }
      />

      <main className="pt-16 px-4 max-w-4xl mx-auto">
        {/* Search + New Order */}
        <div className="flex gap-2 mb-4">
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
        <div className="flex gap-3 mb-4">
          <Badge variant="secondary" className="gap-1">
            <Package className="w-3 h-3" />
            {products.length} produtos
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
                      <p className="text-xs text-muted-foreground">
                        Estoque: {product.estoque}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default SalesProducts;
