import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { MapPin, Plus, Loader2, Home, Building, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Address {
  id: string;
  label: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zip_code: string;
  is_default: boolean;
}

const Addresses = () => {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadAddresses();
  }, []);

  const loadAddresses = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false });

    if (!error && data) {
      setAddresses(data);
    }
    setLoading(false);
  };

  const handleSetDefault = async (addressId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // First, unset all defaults
    await supabase
      .from('addresses')
      .update({ is_default: false })
      .eq('user_id', user.id);

    // Then set the new default
    await supabase
      .from('addresses')
      .update({ is_default: true })
      .eq('id', addressId);

    toast({
      title: 'Endereço padrão atualizado',
    });
    
    loadAddresses();
  };

  const handleDelete = async (addressId: string) => {
    const { error } = await supabase
      .from('addresses')
      .delete()
      .eq('id', addressId);

    if (!error) {
      toast({
        title: 'Endereço removido',
      });
      loadAddresses();
    } else {
      toast({
        title: 'Erro ao remover endereço',
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meus Endereços" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {addresses.length > 0 ? (
          <div className="space-y-3 mb-6">
            {addresses.map((address) => (
              <div
                key={address.id}
                className={`bg-card rounded-xl p-4 border ${
                  address.is_default ? 'border-primary' : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    address.is_default ? 'bg-primary/10' : 'bg-muted'
                  }`}>
                    {address.label.toLowerCase().includes('casa') ? (
                      <Home className={`w-5 h-5 ${address.is_default ? 'text-primary' : 'text-muted-foreground'}`} />
                    ) : (
                      <Building className={`w-5 h-5 ${address.is_default ? 'text-primary' : 'text-muted-foreground'}`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{address.label}</h3>
                      {address.is_default && (
                        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          Padrão
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {address.street}, {address.number}
                      {address.complement && ` - ${address.complement}`}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {address.neighborhood} - {address.city}/{address.state}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      CEP: {address.zip_code}
                    </p>
                  </div>
                </div>
                
                <div className="flex gap-2 mt-3 pt-3 border-t border-border">
                  {!address.is_default && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleSetDefault(address.id)}
                    >
                      Definir como padrão
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(address.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <MapPin className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-2">Nenhum endereço cadastrado</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Adicione um endereço para facilitar suas coletas e entregas
            </p>
          </div>
        )}

        <Button className="w-full">
          <Plus className="w-4 h-4 mr-2" />
          Adicionar Endereço
        </Button>
      </main>

      <BottomNav />
    </div>
  );
};

export default Addresses;
