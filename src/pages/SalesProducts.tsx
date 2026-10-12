import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Search, RefreshCw, Package, ShoppingCart, BarChart3, Building2, ChevronLeft } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { fetchAllPages } from '@/lib/postgrest';
import { desatualizado, estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';

type Account = 'oben' | 'colacor';

interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  metadata: Record<string, unknown>;
}

/** Só o que a tela mostra — `select('*')` puxava o `metadata` inteiro de ~4k SKUs à toa. */
const COLUNAS_CATALOGO = 'id, codigo, descricao, unidade, valor_unitario, estoque, ativo, metadata';

/**
 * O catálogo INTEIRO da conta (M-12). Era um `select('*')` single-shot: o PostgREST capa em 1.000
 * linhas sem erro, e com 3.715 SKUs na Oben e 4.339 na Colacor a tela listava 1.000 e dizia
 * "1000 produtos". `fetchAllPages` pagina até a página curta e REJEITA se uma página falha
 * (página perdida ≠ fim do catálogo). A paginação ordena SÓ por `id` (imutável): ordenar por
 * `ativo`/`descricao` no servidor deixaria um produto que o sync inativa entre duas páginas mudar de
 * posição — relido numa página, outro SKU pulado, sem erro (Codex, revisão do M-12). A ordem de
 * exibição (ativos primeiro, depois descrição) é aplicada no cliente, sobre o catálogo completo.
 */
export async function buscarCatalogoVendas(account: Account): Promise<Product[]> {
  const linhas = await fetchAllPages<Product>(
    (de, ate) =>
      supabase
        .from('omie_products')
        .select(COLUNAS_CATALOGO)
        .eq('account', account)
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
        .not('familia', 'ilike', 'jumbo%')
        .not('familia', 'ilike', '%material para tingimix%')
        .order('id')
        .range(de, ate) as unknown as PromiseLike<{ data: Product[] | null; error: unknown }>,
    'omie_products/catalogo-vendas',
  );
  // Um DELETE/INSERT entre páginas ainda pode reler uma linha: o mesmo `id` aparece uma vez só.
  const porId = new Map(linhas.map((p) => [p.id, p]));
  return [...porId.values()].sort(ordemDeExibicao);
}

// A ordem que o servidor dava: ativos primeiro, depois descrição (ambas NOT NULL em prod).
function ordemDeExibicao(a: Product, b: Product): number {
  if (a.ativo !== b.ativo) return a.ativo ? -1 : 1;
  return a.descricao.localeCompare(b.descricao, 'pt-BR');
}

const chaveCatalogo = (account: Account) => ['catalogo-vendas', account] as const;

const SalesProducts = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();

  const queryClient = useQueryClient();
  const [account, setAccount] = useState<Account>('oben');
  const [syncing, setSyncing] = useState(false);
  const [syncingStock, setSyncingStock] = useState(false);
  const [search, setSearch] = useState('');

  const { role } = useAuth();
  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, role, isStaff, navigate]);

  // Uma chave POR CONTA: a lista exibida é sempre a da aba atual, e a resposta de uma leitura
  // antiga (sync da outra conta que termina depois da troca de aba) só toca o cache DELA — antes
  // um `setProducts` atrasado punha o catálogo da Colacor sob a aba Oben (Codex, desenho do M-12).
  const catalogo = useQuery({
    queryKey: chaveCatalogo(account),
    queryFn: () => buscarCatalogoVendas(account),
    enabled: isStaff,
  });
  const products = catalogo.data ?? [];
  const estado = estadoDeLeitura(catalogo);
  const avisoCache = desatualizado(catalogo, catalogo.data !== undefined);

  const syncProducts = async () => {
    setSyncing(true);
    try {
      let nextPage: number | null = 1;
      let totalSynced = 0;
      while (nextPage) {
        const res = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'sync_products', start_page: nextPage, account },
        });
        if (res.error) throw res.error;
        const payload = (res.data ?? {}) as { totalSynced?: number; nextPage?: number | null };
        totalSynced += payload.totalSynced || 0;
        nextPage = payload.nextPage || null;
      }

      toast.success('Sincronização concluída!', {
        description: `${totalSynced} produtos sincronizados (${account === 'oben' ? 'Oben' : 'Colacor'}).`,
      });

      await queryClient.invalidateQueries({ queryKey: chaveCatalogo(account) });
    } catch (error) {
      console.error('Erro ao sincronizar:', error);
      toast.error('Erro na sincronização', {
        description: error instanceof Error ? error.message : 'Não foi possível sincronizar os produtos.',
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
        const res = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'sync_estoque', start_page: nextPage, account },
        });
        if (res.error) throw res.error;
        const payload = (res.data ?? {}) as { totalUpdated?: number; nextPage?: number | null };
        totalUpdated += payload.totalUpdated || 0;
        nextPage = payload.nextPage || null;
      }
      toast.success('Estoque atualizado!', {
        description: `${totalUpdated} produtos com estoque atualizado (${account === 'oben' ? 'Oben' : 'Colacor'}).`,
      });
      await queryClient.invalidateQueries({ queryKey: chaveCatalogo(account) });
    } catch (error) {
      console.error('Erro ao sincronizar estoque:', error);
      toast.error('Erro ao atualizar estoque', {
        description: error instanceof Error ? error.message : 'Não foi possível sincronizar o estoque.',
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

  // 'desabilitada' = papel ainda não resolvido (não-staff é redirecionado acima): esqueleto, não "0 produtos".
  if (authLoading || estado === 'carregando' || estado === 'desabilitada') {
    return (
      <PageSkeleton variant="list" />
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
            <p className="text-xs text-muted-foreground">Catálogo de produtos (inclui inativos)</p>
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

      {/* Leitura que NÃO aconteceu: sem catálogo em mãos, nem contador nem "Nenhum produto
          sincronizado" — os dois afirmariam um catálogo vazio que ninguém leu. */}
      {naoConsegui(estado) && catalogo.data === undefined ? (
        <AvisoLeituraFalhou oque={`o catálogo da ${account === 'oben' ? 'Oben' : 'Colacor'}`} estado={estado} variante="bloco" />
      ) : (
      <>
      {avisoCache && (
        <AvisoLeituraFalhou
          oque={`o catálogo atualizado da ${account === 'oben' ? 'Oben' : 'Colacor'} — a lista abaixo é da última leitura`}
          estado={avisoCache}
        />
      )}

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
                    {!!product.metadata?.marca && (
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
      </>
      )}
    </div>
  );
};

export default SalesProducts;
