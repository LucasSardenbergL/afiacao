import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, ChevronRight, Check, MapPin, Clock, Loader2, Wrench, AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { PhotoUpload } from '@/components/PhotoUpload';
import { VoiceServiceInput, IdentifiedItem } from '@/components/VoiceServiceInput';
import { 
  DELIVERY_OPTIONS,
  TIME_SLOTS,
  DELIVERY_FEES,
  DeliveryOption,
} from '@/types';
import { cn } from '@/lib/utils';
import { syncOrderToOmie, OmieServico } from '@/services/omieService';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

type Step = 'items' | 'delivery' | 'review';

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  specifications: Record<string, unknown> | null;
  tool_categories?: {
    name: string;
  };
}

interface ServiceItem {
  id: string;
  userToolId: string; // OBRIGATÓRIO - referência à ferramenta cadastrada
  userTool?: UserTool;
  servico?: OmieServico;
  quantity: number;
  notes?: string;
  photos: string[];
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
  const [items, setItems] = useState<ServiceItem[]>([]);
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Serviços do Omie
  const [servicos, setServicos] = useState<OmieServico[]>([]);
  const [loadingServicos, setLoadingServicos] = useState(true);
  
  // Ferramentas do usuário
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  
  // User data from database
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [showAddressOptions, setShowAddressOptions] = useState(false);

  useEffect(() => {
    if (user) {
      loadUserData();
      loadServicos();
      loadUserTools();
    }
  }, [user]);

  const loadUserTools = async () => {
    if (!user) return;
    
    try {
      setLoadingTools(true);
      const { data, error } = await supabase
        .from('user_tools')
        .select(`
          id,
          tool_category_id,
          generated_name,
          custom_name,
          quantity,
          specifications,
          tool_categories (name)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setUserTools((data || []) as UserTool[]);
    } catch (error) {
      console.error('Erro ao carregar ferramentas:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const loadServicos = async () => {
    try {
      setLoadingServicos(true);
      
      const { data: servicosData, error } = await supabase
        .from('omie_servicos')
        .select('omie_codigo_servico, omie_codigo_integracao, descricao')
        .eq('inativo', false)
        .order('descricao');
      
      if (error) {
        console.error('Erro ao carregar serviços do banco:', error);
      } else if (servicosData && servicosData.length > 0) {
        const servicosFormatados: OmieServico[] = servicosData.map(s => ({
          omie_codigo_servico: s.omie_codigo_servico,
          omie_codigo_integracao: s.omie_codigo_integracao || '',
          descricao: s.descricao,
          codigo_lc116: '',
          codigo_servico_municipio: '',
          valor_unitario: 0,
          unidade: 'UN',
        }));
        setServicos(servicosFormatados);
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

  const addItem = (toolId: string) => {
    const tool = userTools.find(t => t.id === toolId);
    if (!tool) return;
    
    // Verificar se já existe item com essa ferramenta
    if (items.some(item => item.userToolId === toolId)) {
      toast({
        title: 'Ferramenta já adicionada',
        description: 'Esta ferramenta já está no pedido',
        variant: 'default',
      });
      return;
    }
    
    setItems([...items, { 
      id: String(items.length + 1), 
      userToolId: toolId,
      userTool: tool,
      quantity: 1, 
      photos: [] 
    }]);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof ServiceItem, value: unknown) => {
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

  // Handler para itens identificados pela IA
  const handleVoiceItemsIdentified = (identifiedItems: IdentifiedItem[]) => {
    const newItems: ServiceItem[] = identifiedItems.map((item, idx) => {
      const tool = userTools.find(t => t.id === item.userToolId);
      const servico = servicos.find(s => s.omie_codigo_servico === item.omie_codigo_servico);
      
      return {
        id: String(items.length + idx + 1),
        userToolId: item.userToolId,
        userTool: tool,
        servico: servico,
        quantity: item.quantity,
        notes: item.notes,
        photos: [],
      };
    });

    // Filtrar itens que já existem no pedido
    const filteredNewItems = newItems.filter(
      newItem => !items.some(existing => existing.userToolId === newItem.userToolId)
    );

    if (filteredNewItems.length === 0) {
      toast({
        title: 'Ferramentas já adicionadas',
        description: 'Todas as ferramentas identificadas já estão no pedido.',
        variant: 'default',
      });
      return;
    }

    setItems([...items, ...filteredNewItems]);
  };

  // Filtra serviços baseado no nome da categoria da ferramenta (sem especificações)
  const getFilteredServicos = (tool: UserTool | undefined): OmieServico[] => {
    if (!tool) return [];
    
    // Usa o nome da categoria base da ferramenta (ex: "Faca Circular", "Serra")
    const categoryName = tool.tool_categories?.name?.toLowerCase().trim();
    if (!categoryName) return [];
    
    // Filtra serviços que contenham o nome da categoria na descrição
    return servicos.filter(servico => {
      const descricaoLower = servico.descricao.toLowerCase();
      return descricaoLower.includes(categoryName);
    });
  };

  const deliveryFee = DELIVERY_FEES[deliveryOption];

  const canProceed = () => {
    switch (currentStep) {
      case 'items':
        // Cada item deve ter ferramenta e serviço selecionados
        return items.length > 0 && items.every(item => item.userToolId && item.servico && item.quantity > 0);
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
      
      const orderItems = items.map(item => ({
        category: item.servico?.descricao || '',
        quantity: item.quantity || 1,
        omie_codigo_servico: item.servico?.omie_codigo_servico,
        userToolId: item.userToolId,
        toolName: item.userTool?.generated_name || item.userTool?.custom_name || item.userTool?.tool_categories?.name || '',
        notes: item.notes,
        photos: item.photos || [],
      }));

      // Build notes with tool specifications
      const buildToolInfo = (item: ServiceItem): string => {
        const parts: string[] = [];
        const toolName = item.userTool?.generated_name || item.userTool?.custom_name || item.userTool?.tool_categories?.name || '';
        if (toolName) parts.push(toolName);
        
        // Add specifications
        const specs = item.userTool?.specifications;
        if (specs && typeof specs === 'object') {
          const specEntries = Object.entries(specs).filter(([, v]) => v);
          if (specEntries.length > 0) {
            parts.push(specEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
          }
        }
        
        if (item.notes) parts.push(item.notes);
        return parts.join(' | ');
      };

      const orderData = {
        items: orderItems,
        service_type: 'padrao',
        subtotal: 0,
        delivery_fee: deliveryFee,
        total: deliveryFee,
        notes: items.map(buildToolInfo).filter(Boolean).join(' || '),
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

  const getToolDisplayName = (tool: UserTool) => {
    return tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  };

  if (loadingData || loadingServicos || loadingTools) {
    return (
      <div className="min-h-screen bg-background pb-32">
        <Header title="Novo Pedido" showBack />
        <div className="flex flex-col items-center justify-center pt-32 gap-2">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  // Ferramentas disponíveis (não selecionadas ainda)
  const availableTools = userTools.filter(tool => !items.some(item => item.userToolId === tool.id));

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
              <h2 className="font-display font-bold text-xl mb-1">Selecionar Ferramentas</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Escolha suas ferramentas cadastradas e o serviço desejado
              </p>

              {/* Assistente por voz/texto */}
              {userTools.length > 0 && (
                <div className="mb-6">
                  <VoiceServiceInput
                    userTools={userTools}
                    onItemsIdentified={handleVoiceItemsIdentified}
                    isLoading={isSubmitting}
                  />
                </div>
              )}

              {/* Ferramentas sem cadastro */}
              {userTools.length === 0 ? (
                <div className="bg-muted/50 rounded-xl p-6 text-center">
                  <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <h3 className="font-semibold mb-2">Nenhuma ferramenta cadastrada</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Você precisa cadastrar suas ferramentas antes de solicitar um serviço
                  </p>
                  <Button onClick={() => navigate('/tools')}>
                    <Wrench className="w-4 h-4 mr-2" />
                    Cadastrar Ferramentas
                  </Button>
                </div>
              ) : (
                <>
                  {/* Itens adicionados */}
                  {items.length > 0 && (
                    <div className="space-y-4 mb-6">
                      {items.map((item, index) => (
                        <div key={index} className="bg-card rounded-xl p-4 shadow-soft border border-border">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Wrench className="w-4 h-4 text-primary" />
                              <span className="font-medium">
                                {getToolDisplayName(item.userTool!)}
                              </span>
                            </div>
                            <button
                              onClick={() => removeItem(index)}
                              className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Seleção de serviço - filtrado pelo nome da ferramenta */}
                          <div className="mb-3">
                            <label className="text-sm font-medium mb-2 block">Tipo de serviço *</label>
                            {(() => {
                              const filteredServicos = getFilteredServicos(item.userTool);
                              return filteredServicos.length > 0 ? (
                                <select
                                  value={item.servico?.omie_codigo_servico || ''}
                                  onChange={(e) => selectServico(index, Number(e.target.value))}
                                  className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                >
                                  <option value="">Selecione um serviço...</option>
                                  {filteredServicos.map((servico) => (
                                    <option key={servico.omie_codigo_servico} value={servico.omie_codigo_servico}>
                                      {servico.descricao}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div className="bg-muted/50 rounded-lg p-3 text-sm text-muted-foreground">
                                  <AlertCircle className="w-4 h-4 inline mr-2" />
                                  Nenhum serviço disponível para "{getToolDisplayName(item.userTool!)}"
                                </div>
                              );
                            })()}
                          </div>

                          {/* Quantidade */}
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

                          {/* Observações */}
                          <div className="mb-3">
                            <label className="text-sm font-medium mb-2 block">Observações (opcional)</label>
                            <textarea
                              value={item.notes || ''}
                              onChange={(e) => updateItem(index, 'notes', e.target.value)}
                              placeholder="Descreva danos, lascados, ou instruções especiais..."
                              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                              rows={2}
                            />
                          </div>

                          {/* Fotos */}
                          {user && (
                            <div>
                              <label className="text-sm font-medium mb-2 block">Fotos (opcional)</label>
                              <PhotoUpload
                                photos={item.photos || []}
                                onPhotosChange={(photos) => updateItem(index, 'photos', photos)}
                                userId={user.id}
                                maxPhotos={3}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Adicionar ferramentas */}
                  {availableTools.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground mb-3">
                        {items.length > 0 ? 'Adicionar mais ferramentas:' : 'Suas ferramentas cadastradas:'}
                      </h3>
                      <div className="space-y-2">
                        {availableTools.map((tool) => (
                          <button
                            key={tool.id}
                            onClick={() => addItem(tool.id)}
                            className="w-full p-3 rounded-xl border-2 border-dashed border-border flex items-center gap-3 text-left hover:border-primary hover:bg-primary/5 transition-colors"
                          >
                            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                              <Wrench className="w-5 h-5 text-muted-foreground" />
                            </div>
                            <div className="flex-1">
                              <p className="font-medium">{getToolDisplayName(tool)}</p>
                              <p className="text-xs text-muted-foreground">
                                {tool.tool_categories?.name}
                              </p>
                            </div>
                            <Plus className="w-5 h-5 text-primary" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Link para cadastrar mais */}
                  <Button
                    variant="ghost"
                    className="w-full mt-4"
                    onClick={() => navigate('/tools')}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Cadastrar nova ferramenta
                  </Button>
                </>
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

              <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 mb-4">
                <p className="text-sm text-primary font-medium">
                  ✓ Frete grátis em todas as modalidades de entrega
                </p>
              </div>

              <div className="space-y-3 mb-6">
                {Object.entries(DELIVERY_OPTIONS).map(([key, { label, description }]) => (
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
                ))}
              </div>

              {deliveryOption !== 'balcao' && (
                <>
                  <div className="mb-6">
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <MapPin className="w-4 h-4" />
                      Endereço de coleta/entrega
                    </label>
                    
                    {addresses.length > 0 ? (
                      <>
                        {(() => {
                          const defaultAddr = addresses.find(a => a.id === selectedAddress);
                          if (!defaultAddr) return null;
                          
                          return (
                            <div className="bg-card rounded-xl p-4 border-2 border-primary mb-3">
                              <div className="flex items-start justify-between">
                                <div>
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="font-semibold">{defaultAddr.label}</span>
                                    <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                      Selecionado
                                    </span>
                                  </div>
                                  <p className="text-sm text-muted-foreground">
                                    {defaultAddr.street}, {defaultAddr.number}
                                    {defaultAddr.complement && ` - ${defaultAddr.complement}`}
                                  </p>
                                  <p className="text-sm text-muted-foreground">
                                    {defaultAddr.neighborhood} - {defaultAddr.city}/{defaultAddr.state}
                                  </p>
                                </div>
                                <Check className="w-5 h-5 text-primary mt-1" />
                              </div>
                            </div>
                          );
                        })()}

                        {!showAddressOptions && addresses.length > 1 && (
                          <Button 
                            variant="outline" 
                            size="sm" 
                            className="w-full"
                            onClick={() => setShowAddressOptions(true)}
                          >
                            Alterar endereço
                          </Button>
                        )}

                        {showAddressOptions && (
                          <div className="space-y-2 mt-3">
                            <p className="text-sm font-medium text-muted-foreground">Outros endereços:</p>
                            {addresses
                              .filter(a => a.id !== selectedAddress)
                              .map((address) => (
                                <button
                                  key={address.id}
                                  onClick={() => {
                                    setSelectedAddress(address.id);
                                    setShowAddressOptions(false);
                                  }}
                                  className="w-full p-3 rounded-lg border border-border text-left hover:border-primary/50 transition-all"
                                >
                                  <span className="font-medium">{address.label}</span>
                                  <p className="text-sm text-muted-foreground">
                                    {address.street}, {address.number} - {address.neighborhood}
                                  </p>
                                </button>
                              ))}
                            
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              className="w-full mt-2"
                              onClick={() => navigate('/addresses')}
                            >
                              <Plus className="w-4 h-4 mr-2" />
                              Adicionar novo endereço
                            </Button>
                            
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              className="w-full text-muted-foreground"
                              onClick={() => setShowAddressOptions(false)}
                            >
                              Cancelar
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="bg-muted/50 rounded-lg p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-2">Nenhum endereço cadastrado</p>
                        <Button variant="outline" size="sm" onClick={() => navigate('/addresses')}>
                          Adicionar endereço
                        </Button>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Horário preferido
                    </label>
                    <div className="grid grid-cols-2 gap-2">
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

              <div className="bg-secondary border border-border rounded-lg p-3 mb-4">
                <p className="text-sm text-muted-foreground">
                  💡 O valor será informado após a triagem das ferramentas
                </p>
              </div>

              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-3">Serviços Solicitados</h3>
                <div className="space-y-3">
                  {items.map((item, index) => (
                    <div key={index} className="border-b border-border last:border-0 pb-3 last:pb-0">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-medium">
                            {getToolDisplayName(item.userTool!)}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {item.quantity}x {item.servico?.descricao || 'Serviço'}
                          </p>
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
