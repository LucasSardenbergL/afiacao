import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AddToolDialog } from '@/components/AddToolDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Wrench, Trash2, Search, User, Phone, FileText, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Customer {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
}

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories: ToolCategory;
}

const AdminCustomers = () => {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();
  
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingTools, setLoadingTools] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadCustomers();
      loadCategories();
    }
  }, [user, isStaff]);

  useEffect(() => {
    if (customerId && customers.length > 0) {
      const customer = customers.find(c => c.user_id === customerId);
      if (customer) {
        setSelectedCustomer(customer);
        loadCustomerTools(customerId);
      }
    }
  }, [customerId, customers]);

  const loadCategories = async () => {
    const { data } = await supabase
      .from('tool_categories')
      .select('*')
      .order('name');
    if (data) setCategories(data);
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document')
        .eq('is_employee', false)
        .order('name');

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadCustomerTools = async (userId: string) => {
    setLoadingTools(true);
    try {
      const { data, error } = await supabase
        .from('user_tools')
        .select(`
          *,
          tool_categories (*)
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCustomerTools(data as unknown as UserTool[]);
    } catch (error) {
      console.error('Error loading customer tools:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    loadCustomerTools(customer.user_id);
    navigate(`/admin/customers/${customer.user_id}`);
  };

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase
        .from('user_tools')
        .delete()
        .eq('id', toolId);

      if (error) throw error;

      toast({ title: 'Ferramenta removida' });
      setCustomerTools(prev => prev.filter(t => t.id !== toolId));
    } catch (error) {
      console.error('Error deleting tool:', error);
      toast({
        title: 'Erro ao remover',
        variant: 'destructive',
      });
    }
  };

  const handleToolAdded = () => {
    if (selectedCustomer) {
      loadCustomerTools(selectedCustomer.user_id);
    }
  };

  const filteredCustomers = customers.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.document?.includes(searchQuery) ||
    c.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDocument = (doc: string | null) => {
    if (!doc) return '-';
    if (doc.length === 11) {
      return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    if (doc.length === 14) {
      return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return doc;
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Clientes" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!isStaff) return null;

  // Customer detail view
  if (selectedCustomer) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header 
          title={selectedCustomer.name}
          showBack
          rightElement={
            <Button 
              size="icon" 
              variant="ghost" 
              className="rounded-full"
              onClick={() => setAddToolDialogOpen(true)}
            >
              <Plus className="w-5 h-5" />
            </Button>
          }
        />

        <AddToolDialog
          open={addToolDialogOpen}
          onOpenChange={setAddToolDialogOpen}
          onToolAdded={handleToolAdded}
          categories={categories}
          targetUserId={selectedCustomer.user_id}
        />

        <main className="pt-16 px-4 max-w-lg mx-auto">
          <button
            onClick={() => {
              setSelectedCustomer(null);
              navigate('/admin/customers');
            }}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
          >
            <ChevronLeft className="w-4 h-4" />
            Voltar para clientes
          </button>

          {/* Customer info */}
          <Card className="mb-6">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span>{formatDocument(selectedCustomer.document)}</span>
              </div>
              {selectedCustomer.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <span>{selectedCustomer.phone}</span>
                </div>
              )}
              {selectedCustomer.email && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {selectedCustomer.email}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tools section */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-foreground">Ferramentas cadastradas</h2>
            <Badge variant="secondary">{customerTools.length}</Badge>
          </div>

          {loadingTools ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : customerTools.length > 0 ? (
            <div className="space-y-3">
              {customerTools.map((tool) => (
                <Card key={tool.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Wrench className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-foreground text-sm truncate">
                          {tool.generated_name || tool.custom_name || tool.tool_categories?.name}
                        </h3>
                        {tool.generated_name && (
                          <p className="text-xs text-muted-foreground">
                            {tool.tool_categories?.name}
                          </p>
                        )}
                        {tool.quantity && tool.quantity > 1 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Quantidade: {tool.quantity}
                          </p>
                        )}
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeleteTool(tool.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Wrench className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>Nenhuma ferramenta cadastrada</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-4"
                onClick={() => setAddToolDialogOpen(true)}
              >
                <Plus className="w-4 h-4 mr-2" />
                Adicionar ferramenta
              </Button>
            </div>
          )}
        </main>

        <BottomNav />
      </div>
    );
  }

  // Customer list view
  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Clientes" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CPF/CNPJ ou e-mail..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Customer list */}
        <div className="space-y-3">
          {filteredCustomers.map((customer) => (
            <Card 
              key={customer.user_id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => handleSelectCustomer(customer)}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <User className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-foreground truncate">{customer.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {formatDocument(customer.document)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {filteredCustomers.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              {searchQuery ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
            </div>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminCustomers;
