import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, ChevronRight, Check, MapPin, Clock, Loader2, QrCode, Banknote } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { 
  DELIVERY_OPTIONS,
  TIME_SLOTS,
  DELIVERY_FEES,
  DeliveryOption,
} from '@/types';
import { cn } from '@/lib/utils';
import { syncOrderToOmie, listOmieServices, OmieServico } from '@/services/omieService';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

type Step = 'items' | 'delivery' | 'review';
type PaymentMethod = 'pix' | 'on_delivery';

const PIX_KEY = '55.555.305/0001-51';

interface ServiceItem {
  id: string;
  servico?: OmieServico;
  quantity: number;
  brandModel?: string;
  notes?: string;
}

interface ProfileData {
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
}

interface AddressData {
  id: string;
  label: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

const NewOrder = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  
  const [currentStep, setCurrentStep] = useState<Step>('items');
  const [items, setItems] = useState<ServiceItem[]>([{ id: '1', quantity: 1 }]);
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pix');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Serviços do Omie
  const [servicos, setServicos] = useState<OmieServico[]>([]);
  const [loadingServicos, setLoadingServicos] = useState(true);
  
  // User data from database
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    if (user) {
      loadUserData();
      loadServicos();
    }
  }, [user]);

  const loadServicos = async () => {
    try {
      setLoadingServicos(true);
      const result = await listOmieServices();
      if (result.success && result.servicos.length > 0) {
        setServicos(result.servicos);
      }
    } catch (error) {
      console.error('Erro ao carregar serviços:', error);
    } finally {
      setLoadingServicos(false);
    }
  };

  const loadUserData = async () => {
    if (!user) return;
    
    try {
      // Load profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, email, phone, document')
        .eq('user_id', user.id)
        .maybeSingle();

      if (profileData) {
        setProfile(profileData);
      } else {
        setProfile({
          name: user.email?.split('@')[0] || 'Usuário',
          email: user.email || null,
          phone: null,
          document: null,
        });
      }

      // Load addresses
      const { data: addressesData } = await supabase
        .from('addresses')
        .select('*')
        .eq('user_id', user.id)
        .order('is_default', { ascending: false });

      if (addressesData && addressesData.length > 0) {
        const formattedAddresses: AddressData[] = addressesData.map(addr => ({
          id: addr.id,
          label: addr.label,
          street: addr.street,
          number: addr.number,
          complement: addr.complement,
          neighborhood: addr.neighborhood,
          city: addr.city,
          state: addr.state,
          zipCode: addr.zip_code,
        }));
        setAddresses(formattedAddresses);
        setSelectedAddress(formattedAddresses[0].id);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    } finally {
      setLoadingData(false);
    }
  };

  const steps: { id: Step; label: string; number: number }[] = [
    { id: 'items', label: 'Serviços', number: 1 },
    { id: 'delivery', label: 'Entrega', number: 2 },
    { id: 'review', label: 'Revisão', number: 3 },
  ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  const addItem = () => {
    setItems([...items, { id: String(items.length + 1), quantity: 1 }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, field: keyof ServiceItem, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const selectServico = (index: number, codigoServico: number) => {
    const servico = servicos.find(s => s.omie_codigo_servico === codigoServico);
    if (servico) {
      updateItem(index, 'servico', servico);
    }
  };

  // Industrial clients always have free shipping
  const deliveryFee = DELIVERY_FEES[deliveryOption];

  const canProceed = () => {
    switch (currentStep) {
      case 'items':
        return items.every(item => item.servico && item.quantity);
      case 'delivery':
        if (deliveryOption === 'balcao') return true;
        return selectedAddress && selectedTimeSlot;
      default:
        return true;
    }
  };

  const nextStep = () => {
    const idx = currentStepIndex;
    if (idx < steps.length - 1) {
      setCurrentStep(steps[idx + 1].id);
    }
  };

  const prevStep = () => {
    const idx = currentStepIndex;
    if (idx > 0) {
      setCurrentStep(steps[idx - 1].id);
    } else {
      navigate(-1);
    }
  };

  const handleSubmit = async () => {
    if (!user || !profile) {
      toast({
        title: 'Erro',
        description: 'Você precisa estar logado para fazer um pedido',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    
    try {
      const orderId = crypto.randomUUID();
      
      // Montar itens com código do serviço Omie
      const orderItems = items.map(item => ({
        category: item.servico?.descricao || '',
        quantity: item.quantity || 1,
        omie_codigo_servico: item.servico?.omie_codigo_servico,
        brandModel: item.brandModel,
        notes: item.notes,
      }));

      const orderData = {
        items: orderItems,
        service_type: 'padrao',
        subtotal: 0, // Sem preço - será definido após triagem
        delivery_fee: deliveryFee,
        total: deliveryFee, // Apenas frete por enquanto
        notes: items.map(item => item.notes).filter(Boolean).join(' | '),
      };

      const profilePayload = {
        name: profile.name,
        email: profile.email || undefined,
        phone: profile.phone || undefined,
        document: profile.document || undefined,
      };

      const selectedAddressData = addresses.find(a => a.id === selectedAddress);
      const addressPayload = selectedAddressData ? {
        street: selectedAddressData.street,
        number: selectedAddressData.number,
        complement: selectedAddressData.complement || undefined,
        neighborhood: selectedAddressData.neighborhood,
        city: selectedAddressData.city,
        state: selectedAddressData.state,
        zip_code: selectedAddressData.zipCode,
      } : undefined;

      const result = await syncOrderToOmie(orderId, orderData, profilePayload, addressPayload);

      if (result.success) {
        toast({
          title: "Pedido enviado!",
          description: `OS criada no Omie: ${result.omie_os?.cNumOS || 'Processando...'}`,
        });
        navigate('/orders');
      } else {
        console.warn('[NewOrder] Falha ao sincronizar com Omie:', result.error);
        toast({
          title: "Pedido criado",
          description: "Pedido registrado. Sincronização com ERP pendente.",
          variant: "default",
        });
        navigate('/orders');
      }
    } catch (error) {
      console.error('[NewOrder] Erro ao enviar pedido:', error);
      toast({
        title: "Erro ao enviar pedido",
        description: "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadingData || loadingServicos) {
    return (
      <div className="min-h-screen bg-background pb-32">
        <Header title="Novo Pedido" showBack />
        <div className="flex flex-col items-center justify-center pt-32 gap-2">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando serviços...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Novo Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Progress steps */}
        <div className="flex items-center justify-between mb-6 py-4">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all',
                    index < currentStepIndex && 'bg-primary text-primary-foreground',
                    index === currentStepIndex && 'bg-secondary text-secondary-foreground',
                    index > currentStepIndex && 'bg-muted text-muted-foreground'
                  )}
                >
                  {index < currentStepIndex ? <Check className="w-4 h-4" /> : step.number}
                </div>
                <span className="text-[10px] mt-1 text-muted-foreground">{step.label}</span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    'w-16 h-0.5 mx-2 mt-[-12px]',
                    index < currentStepIndex ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="animate-fade-in">
          {/* Step 1: Services */}
          {currentStep === 'items' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Selecionar Serviços</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Escolha os serviços que deseja para suas ferramentas
              </p>

              {servicos.length === 0 ? (
                <div className="bg-muted/50 rounded-lg p-6 text-center">
                  <p className="text-muted-foreground">Nenhum serviço disponível no momento.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={loadServicos}>
                    Tentar novamente
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {items.map((item, index) => (
                    <div key={index} className="bg-card rounded-xl p-4 shadow-soft border border-border">
                      <div className="flex items-start justify-between mb-3">
                        <span className="text-sm font-medium text-muted-foreground">
                          Item {index + 1}
                        </span>
                        {items.length > 1 && (
                          <button
                            onClick={() => removeItem(index)}
                            className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {/* Service select */}
                      <div className="mb-3">
                        <label className="text-sm font-medium mb-2 block">Tipo de serviço</label>
                        <select
                          value={item.servico?.omie_codigo_servico || ''}
                          onChange={(e) => selectServico(index, Number(e.target.value))}
                          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="">Selecione um serviço...</option>
                          {servicos.map((servico) => (
                            <option key={servico.omie_codigo_servico} value={servico.omie_codigo_servico}>
                              {servico.descricao}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Brand/Model */}
                      <div className="mb-3">
                        <label className="text-sm font-medium mb-2 block">Marca/Modelo (opcional)</label>
                        <input
                          type="text"
                          value={item.brandModel || ''}
                          onChange={(e) => updateItem(index, 'brandModel', e.target.value)}
                          placeholder="Ex: Makita, Dewalt..."
                          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>

                      {/* Quantity */}
                      <div className="mb-3">
                        <label className="text-sm font-medium mb-2 block">Quantidade</label>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => updateItem(index, 'quantity', Math.max(1, (item.quantity || 1) - 1))}
                            className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted"
                          >
                            -
                          </button>
                          <span className="w-10 text-center font-semibold">{item.quantity || 1}</span>
                          <button
                            onClick={() => updateItem(index, 'quantity', (item.quantity || 1) + 1)}
                            className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted"
                          >
                            +
                          </button>
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="text-sm font-medium mb-2 block">Observações (opcional)</label>
                        <textarea
                          value={item.notes || ''}
                          onChange={(e) => updateItem(index, 'notes', e.target.value)}
                          placeholder="Descreva danos, lascados, ou instruções especiais..."
                          className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                          rows={2}
                        />
                      </div>
                    </div>
                  ))}

                  <button
                    onClick={addItem}
                    className="w-full py-3 rounded-xl border-2 border-dashed border-border flex items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                  >
                    <Plus className="w-5 h-5" />
                    <span className="font-medium">Adicionar outro serviço</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Delivery */}
          {currentStep === 'delivery' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Entrega</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Como deseja receber suas ferramentas?
              </p>

              {/* Free shipping notice for industrial clients */}
              <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 mb-4">
                <p className="text-sm text-primary font-medium">
                  ✓ Frete grátis em todas as modalidades de entrega
                </p>
              </div>

              {/* Delivery options */}
              <div className="space-y-3 mb-6">
                {Object.entries(DELIVERY_OPTIONS).map(([key, { label, description }]) => {
                  return (
                    <button
                      key={key}
                      onClick={() => setDeliveryOption(key as DeliveryOption)}
                      className={cn(
                        'w-full p-4 rounded-xl border-2 text-left transition-all flex items-start gap-3',
                        deliveryOption === key
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      )}
                    >
                      <div
                        className={cn(
                          'w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5',
                          deliveryOption === key ? 'border-primary' : 'border-muted-foreground'
                        )}
                      >
                        {deliveryOption === key && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                        )}
                      </div>
                      <div className="flex-1">
                        <span className="font-medium block">{label}</span>
                        <span className="text-sm text-muted-foreground">{description}</span>
                      </div>
                      {key !== 'balcao' && (
                        <span className="text-sm font-semibold text-primary">Grátis</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Address selection */}
              {deliveryOption !== 'balcao' && (
                <>
                  <div className="mb-6">
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <MapPin className="w-4 h-4" />
                      Endereço
                    </label>
                    {addresses.length > 0 ? (
                      <div className="space-y-2">
                        {addresses.map((address) => (
                          <button
                            key={address.id}
                            onClick={() => setSelectedAddress(address.id)}
                            className={cn(
                              'w-full p-3 rounded-lg border-2 text-left transition-all',
                              selectedAddress === address.id
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50'
                            )}
                          >
                            <span className="font-medium">{address.label}</span>
                            <p className="text-sm text-muted-foreground">
                              {address.street}, {address.number} - {address.neighborhood}
                            </p>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-muted/50 rounded-lg p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-2">Nenhum endereço cadastrado</p>
                        <Button variant="outline" size="sm" onClick={() => navigate('/addresses')}>
                          Adicionar endereço
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Time slot */}
                  <div>
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Horário preferido
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {TIME_SLOTS.map((slot) => (
                        <button
                          key={slot.id}
                          onClick={() => setSelectedTimeSlot(slot.id)}
                          className={cn(
                            'py-2 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                            selectedTimeSlot === slot.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50'
                          )}
                        >
                          {slot.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 3: Review */}
          {currentStep === 'review' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Revisar Pedido</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Confira os detalhes antes de enviar
              </p>

              {/* Info notice about pricing */}
              <div className="bg-secondary border border-border rounded-lg p-3 mb-4">
                <p className="text-sm text-muted-foreground">
                  💡 O valor será informado após a triagem das ferramentas
                </p>
              </div>

              {/* Items summary */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-3">Serviços Solicitados</h3>
                <div className="space-y-3">
                  {items.map((item, index) => (
                    <div key={index} className="border-b border-border last:border-0 pb-3 last:pb-0">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-medium">
                            {item.quantity}x {item.servico?.descricao || 'Serviço'}
                          </p>
                          {item.brandModel && (
                            <p className="text-sm text-muted-foreground">{item.brandModel}</p>
                          )}
                          {item.notes && (
                            <p className="text-xs text-muted-foreground mt-1 italic">
                              Obs: {item.notes}
                            </p>
                          )}
                        </div>
                        <span className="text-sm text-muted-foreground italic">
                          A orçar
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Delivery summary */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-2">Entrega</h3>
                <p className="text-sm">{DELIVERY_OPTIONS[deliveryOption].label}</p>
                {deliveryOption !== 'balcao' && selectedAddress && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {addresses.find(a => a.id === selectedAddress)?.street}
                    {selectedTimeSlot && ` • ${TIME_SLOTS.find(s => s.id === selectedTimeSlot)?.label}`}
                  </p>
                )}
              </div>

              {/* Payment method selection */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-3">Forma de Pagamento</h3>
                <div className="space-y-3">
                  <button
                    onClick={() => setPaymentMethod('pix')}
                    className={cn(
                      'w-full p-3 rounded-lg border-2 text-left transition-all flex items-center gap-3',
                      paymentMethod === 'pix'
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                        paymentMethod === 'pix' ? 'border-primary' : 'border-muted-foreground'
                      )}
                    >
                      {paymentMethod === 'pix' && (
                        <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                      )}
                    </div>
                    <QrCode className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <span className="font-medium block">PIX</span>
                      <span className="text-xs text-muted-foreground">Chave: {PIX_KEY}</span>
                    </div>
                  </button>

                  <button
                    onClick={() => setPaymentMethod('on_delivery')}
                    className={cn(
                      'w-full p-3 rounded-lg border-2 text-left transition-all flex items-center gap-3',
                      paymentMethod === 'on_delivery'
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                        paymentMethod === 'on_delivery' ? 'border-primary' : 'border-muted-foreground'
                      )}
                    >
                      {paymentMethod === 'on_delivery' && (
                        <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                      )}
                    </div>
                    <Banknote className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <span className="font-medium block">Na Entrega</span>
                      <span className="text-xs text-muted-foreground">Pague ao receber</span>
                    </div>
                  </button>
                </div>
              </div>

              {/* Totals */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Serviços</span>
                    <span className="italic text-muted-foreground">A orçar após triagem</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Frete</span>
                    <span className="text-primary font-medium">Grátis</span>
                  </div>
                  <div className="border-t border-border pt-2 flex justify-between font-semibold text-base">
                    <span>Total</span>
                    <span className="text-muted-foreground italic">A definir</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border p-4 safe-bottom z-50">
          <div className="max-w-lg mx-auto flex gap-3">
            <Button 
              type="button"
              variant="outline" 
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                prevStep();
              }} 
              className="flex-1"
            >
              {currentStepIndex === 0 ? 'Cancelar' : 'Voltar'}
            </Button>
            {currentStep === 'review' ? (
              <Button 
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleSubmit();
                }} 
                className="flex-1"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  'Enviar Pedido'
                )}
              </Button>
            ) : (
              <Button 
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  nextStep();
                }} 
                className="flex-1"
                disabled={!canProceed()}
              >
                Continuar
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default NewOrder;