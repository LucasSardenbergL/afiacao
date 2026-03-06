import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { MapPin, Plus, Loader2, Home, Building, Trash2, Cloud, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  is_from_omie: boolean;
}

const BRAZILIAN_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
];

const formatZipCode = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  return numbers.replace(/(\d{5})(\d)/, '$1-$2');
};

const Addresses = () => {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchingCep, setFetchingCep] = useState(false);
  const { toast } = useToast();

  const [newAddress, setNewAddress] = useState({
    label: '',
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: '',
    zip_code: '',
  });

  const fetchAddressFromCep = async (cep: string) => {
    const cleanCep = cep.replace(/\D/g, '');
    if (cleanCep.length !== 8) return;

    setFetchingCep(true);
    try {
      const response = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
      const data = await response.json();
      
      if (data.erro) {
        toast({ title: 'CEP não encontrado', variant: 'destructive' });
        return;
      }

      setNewAddress(prev => ({
        ...prev,
        street: data.logradouro || prev.street,
        neighborhood: data.bairro || prev.neighborhood,
        city: data.localidade || prev.city,
        state: data.uf || prev.state,
      }));
    } catch (error) {
      console.error('Erro ao buscar CEP:', error);
    } finally {
      setFetchingCep(false);
    }
  };

  const handleCepChange = (value: string) => {
    const formatted = formatZipCode(value);
    setNewAddress(prev => ({ ...prev, zip_code: formatted }));
    
    const cleanCep = value.replace(/\D/g, '');
    if (cleanCep.length === 8) {
      fetchAddressFromCep(cleanCep);
    }
  };

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
      .order('is_from_omie', { ascending: false })
      .order('is_default', { ascending: false });

    if (!error && data) {
      setAddresses(data as Address[]);
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
    const address = addresses.find(a => a.id === addressId);
    if (address?.is_from_omie) {
      toast({
        title: 'Não é possível excluir',
        description: 'Este endereço está sincronizado com o Omie',
        variant: 'destructive',
      });
      return;
    }

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

  const handleAddAddress = async () => {
    if (!newAddress.label || !newAddress.street || !newAddress.number || 
        !newAddress.neighborhood || !newAddress.city || !newAddress.state || !newAddress.zip_code) {
      toast({
        title: 'Preencha todos os campos obrigatórios',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from('addresses')
      .insert({
        user_id: user.id,
        label: newAddress.label,
        street: newAddress.street,
        number: newAddress.number,
        complement: newAddress.complement || null,
        neighborhood: newAddress.neighborhood,
        city: newAddress.city,
        state: newAddress.state.toUpperCase(),
        zip_code: newAddress.zip_code.replace(/\D/g, ''),
        is_default: addresses.length === 0,
        is_from_omie: false,
      });

    setSaving(false);

    if (!error) {
      toast({
        title: 'Endereço adicionado',
      });
      setShowAddDialog(false);
      setNewAddress({
        label: '',
        street: '',
        number: '',
        complement: '',
        neighborhood: '',
        city: '',
        state: '',
        zip_code: '',
      });
      loadAddresses();
    } else {
      toast({
        title: 'Erro ao adicionar endereço',
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
                    address.is_from_omie ? 'bg-secondary' : address.is_default ? 'bg-primary/10' : 'bg-muted'
                  }`}>
                    {address.is_from_omie ? (
                      <Cloud className="w-5 h-5 text-primary" />
                    ) : address.label.toLowerCase().includes('casa') ? (
                      <Home className={`w-5 h-5 ${address.is_default ? 'text-primary' : 'text-muted-foreground'}`} />
                    ) : (
                      <Building className={`w-5 h-5 ${address.is_default ? 'text-primary' : 'text-muted-foreground'}`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{address.label}</h3>
                      {address.is_from_omie && (
                        <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full">
                          Omie
                        </span>
                      )}
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
                      CEP: {address.zip_code.replace(/(\d{5})(\d{3})/, '$1-$2')}
                    </p>
                  </div>
                </div>
                
                <div className="flex gap-2 mt-3 pt-3 border-t border-border">
                  {!address.is_default ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleSetDefault(address.id)}
                    >
                      Usar como padrão para coleta/entrega
                    </Button>
                  ) : (
                    <p className="text-xs text-primary flex-1 flex items-center gap-1">
                      ✓ Endereço padrão para coleta e entrega
                    </p>
                  )}
                  {!address.is_from_omie && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleDelete(address.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
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

        <Button className="w-full" onClick={() => setShowAddDialog(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Adicionar Endereço Extra
        </Button>

        <p className="text-xs text-muted-foreground text-center mt-4">
          Endereços marcados com "Omie" são sincronizados do seu cadastro e não podem ser alterados aqui.
        </p>
      </main>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Adicionar Endereço</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="label">Nome do endereço *</Label>
              <Input
                id="label"
                placeholder="Ex: Casa, Trabalho, Fábrica"
                value={newAddress.label}
                onChange={(e) => setNewAddress(prev => ({ ...prev, label: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="zip_code">CEP *</Label>
              <div className="relative">
                <Input
                  id="zip_code"
                  placeholder="00000-000"
                  value={newAddress.zip_code}
                  onChange={(e) => handleCepChange(e.target.value)}
                  maxLength={9}
                />
                {fetchingCep && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="street">Rua *</Label>
              <Input
                id="street"
                placeholder="Nome da rua"
                value={newAddress.street}
                onChange={(e) => setNewAddress(prev => ({ ...prev, street: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="number">Número *</Label>
                <Input
                  id="number"
                  placeholder="Nº"
                  value={newAddress.number}
                  onChange={(e) => setNewAddress(prev => ({ ...prev, number: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="complement">Complemento</Label>
                <Input
                  id="complement"
                  placeholder="Apto, Sala..."
                  value={newAddress.complement}
                  onChange={(e) => setNewAddress(prev => ({ ...prev, complement: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="neighborhood">Bairro *</Label>
              <Input
                id="neighborhood"
                placeholder="Bairro"
                value={newAddress.neighborhood}
                onChange={(e) => setNewAddress(prev => ({ ...prev, neighborhood: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="city">Cidade *</Label>
                <Input
                  id="city"
                  placeholder="Cidade"
                  value={newAddress.city}
                  onChange={(e) => setNewAddress(prev => ({ ...prev, city: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">UF *</Label>
                <select
                  id="state"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={newAddress.state}
                  onChange={(e) => setNewAddress(prev => ({ ...prev, state: e.target.value }))}
                >
                  <option value="">UF</option>
                  {BRAZILIAN_STATES.map(state => (
                    <option key={state} value={state}>{state}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setShowAddDialog(false)}>
              Cancelar
            </Button>
            <Button className="flex-1" onClick={handleAddAddress} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
};

export default Addresses;
