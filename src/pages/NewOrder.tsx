import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, ChevronRight, Check, MapPin, Clock, Loader2, Wrench, AlertCircle, Camera, Search, User } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhotoUpload } from '@/components/PhotoUpload';
import { VoiceServiceInput, IdentifiedItem } from '@/components/VoiceServiceInput';
import { AddToolDialog } from '@/components/AddToolDialog';
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
import { useUserRole } from '@/hooks/useUserRole';
import { supabase } from '@/integrations/supabase/client';
import { ToolImageIdentifier } from '@/components/ToolImageIdentifier';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';

type Step = 'customer' | 'items' | 'delivery' | 'review';

const PAYMENT_OPTIONS = [
  { id: 'a_vista', label: 'À vista', parcelas: 1, description: 'PIX ou pagamento presencial na entrega/retirada' },
  { id: '30dd', label: '30 dias', parcelas: 1, description: 'Vencimento em 30 dias' },
  { id: '30_60dd', label: '30/60 dias', parcelas: 2, description: '2 parcelas: 30 e 60 dias' },
  { id: '30_60_90dd', label: '30/60/90 dias', parcelas: 3, description: '3 parcelas: 30, 60 e 90 dias' },
  { id: '28dd', label: '28 dias', parcelas: 1, description: 'Vencimento em 28 dias' },
  { id: '28_56dd', label: '28/56 dias', parcelas: 2, description: '2 parcelas: 28 e 56 dias' },
  { id: '28_56_84dd', label: '28/56/84 dias', parcelas: 3, description: '3 parcelas: 28, 56 e 84 dias' },
] as const;

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
  userToolId: string;
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

interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string | null;
  nome_fantasia: string | null;
  cnpj_cpf: string | null;
  email: string | null;
  telefone: string | null;
  cidade: string | null;
  estado: string | null;
  endereco: string | null;
  endereco_numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cep: string | null;
  codigo_vendedor: number | null;
  // Mapped local user_id (if exists in app)
  local_user_id?: string | null;
}

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

const NewOrder = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const { isStaff, loading: roleLoading } = useUserRole();
  
  // For staff: customer selection from Omie
  const [selectedOmieCustomer, setSelectedOmieCustomer] = useState<OmieCustomer | null>(null);
  const [omieCustomers, setOmieCustomers] = useState<OmieCustomer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  
  // The effective user ID for the order (customer's local user_id if mapped, otherwise null)
  const effectiveUserId = isStaff ? (selectedOmieCustomer?.local_user_id || null) : user?.id;

  const [currentStep, setCurrentStep] = useState<Step>('items');

  // Update initial step once role is known
  useEffect(() => {
    if (!roleLoading && isStaff && !selectedOmieCustomer) {
      setCurrentStep('customer');
    }
  }, [roleLoading, isStaff]);
  const [items, setItems] = useState<ServiceItem[]>([]);
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('a_vista');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Serviços do Omie
  const [servicos, setServicos] = useState<OmieServico[]>([]);
  const [loadingServicos, setLoadingServicos] = useState(true);
  
  // Ferramentas do usuário (customer's tools)
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);

  // Categorias de ferramentas
  const [toolCategories, setToolCategories] = useState<ToolCategory[]>([]);
  
  // Add tool dialog for staff
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false);
  
  // User data from database
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [showAddressOptions, setShowAddressOptions] = useState(false);

  // Pricing engine
  const { loadDefaultPrices, calculatePrice } = usePricingEngine();
  const { loadPriceHistory, getLastPrice } = usePriceHistory(effectiveUserId || undefined);

  // Debounced Omie customer search
  useEffect(() => {
    if (!isStaff) return;
    if (searchTimer) clearTimeout(searchTimer);
    
    if (customerSearch.trim().length >= 3) {
      const timer = setTimeout(() => {
        searchOmieCustomers(customerSearch.trim());
      }, 500);
      setSearchTimer(timer);
    } else {
      setOmieCustomers([]);
    }
    
    return () => {
      if (searchTimer) clearTimeout(searchTimer);
    };
  }, [customerSearch, isStaff]);

  // Load data when effective user is determined
  useEffect(() => {
    if (effectiveUserId) {
      loadUserData();
      loadUserTools();
      loadDefaultPrices();
      loadPriceHistory();
    } else if (isStaff && selectedOmieCustomer) {
      // Customer exists in Omie but not in the app - set profile from Omie data
      setProfile({
        name: selectedOmieCustomer.nome_fantasia || selectedOmieCustomer.razao_social || 'Cliente',
        email: selectedOmieCustomer.email || null,
        phone: selectedOmieCustomer.telefone || null,
        document: selectedOmieCustomer.cnpj_cpf || null,
      });
      setAddresses([]);
      setUserTools([]);
      setLoadingData(false);
      setLoadingTools(false);
    }
  }, [effectiveUserId, selectedOmieCustomer]);

  // Load services and categories once
  useEffect(() => {
    if (user) {
      loadServicos();
      loadCategories();
    }
  }, [user]);

  // For non-staff, set loading to false immediately for customers
  useEffect(() => {
    if (!isStaff) {
      setLoadingData(false);
    }
  }, [isStaff]);

  const searchOmieCustomers = async (query: string) => {
    setLoadingCustomers(true);
    try {
      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: { action: 'pesquisar_clientes', query },
      });

      if (error) throw error;

      const clientes: OmieCustomer[] = (data?.clientes || []).map((c: any) => ({
        codigo_cliente: c.codigo_cliente,
        razao_social: c.razao_social,
        nome_fantasia: c.nome_fantasia,
        cnpj_cpf: c.cnpj_cpf,
        email: c.email,
        telefone: c.telefone,
        cidade: c.cidade,
        estado: c.estado,
        codigo_vendedor: c.codigo_vendedor || null,
      }));

      // Try to find local user_ids via omie_clientes mapping
      if (clientes.length > 0) {
        const codigosCliente = clientes.map(c => c.codigo_cliente);
        const { data: mappings } = await supabase
          .from('omie_clientes')
          .select('user_id, omie_codigo_cliente')
          .in('omie_codigo_cliente', codigosCliente);

        if (mappings) {
          for (const cliente of clientes) {
            const mapping = mappings.find(m => m.omie_codigo_cliente === cliente.codigo_cliente);
            if (mapping) {
              cliente.local_user_id = mapping.user_id;
            }
          }
        }
      }

      setOmieCustomers(clientes);
    } catch (error) {
      console.error('Erro ao pesquisar clientes Omie:', error);
      toast({
        title: 'Erro na pesquisa',
        description: 'Não foi possível pesquisar clientes no Omie',
        variant: 'destructive',
      });
    } finally {
      setLoadingCustomers(false);
    }
  };

  const handleSelectCustomer = (customer: OmieCustomer) => {
    setSelectedOmieCustomer(customer);
    // Reset items when switching customer
    setItems([]);
    setUserTools([]);
    setLoadingTools(true);
    setLoadingData(true);
  };

  const loadCategories = async () => {
    try {
      const { data } = await supabase
        .from('tool_categories')
        .select('id, name, description, suggested_interval_days')
        .order('name');
      if (data) setToolCategories(data);
    } catch (error) {
      console.error('Erro ao carregar categorias:', error);
    }
  };

  const loadUserTools = async () => {
    if (!effectiveUserId) return;
    
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
        .eq('user_id', effectiveUserId)
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
    if (!effectiveUserId) return;
    
    try {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, email, phone, document')
        .eq('user_id', effectiveUserId)
        .maybeSingle();

      if (profileData) {
        setProfile(profileData);
      } else {
        setProfile({
          name: 'Usuário',
          email: null,
          phone: null,
          document: null,
        });
      }

      const { data: addressesData } = await supabase
        .from('addresses')
        .select('*')
        .eq('user_id', effectiveUserId)
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
      } else {
        setAddresses([]);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    } finally {
      setLoadingData(false);
    }
  };

  const steps: { id: Step; label: string; number: number }[] = isStaff
    ? [
        { id: 'customer', label: 'Cliente', number: 1 },
        { id: 'items', label: 'Serviços', number: 2 },
        { id: 'delivery', label: 'Entrega', number: 3 },
        { id: 'review', label: 'Revisão', number: 4 },
      ]
    : [
        { id: 'items', label: 'Serviços', number: 1 },
        { id: 'delivery', label: 'Entrega', number: 2 },
        { id: 'review', label: 'Revisão', number: 3 },
      ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  const addItem = (toolId: string) => {
    const tool = userTools.find(t => t.id === toolId);
    if (!tool) return;
    
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
    // Enforce quantity limit based on tool's registered quantity
    if (field === 'quantity') {
      const maxQty = newItems[index].userTool?.quantity || 1;
      value = Math.min(value as number, maxQty);
    }
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const selectServico = (index: number, codigoServico: number) => {
    const servico = servicos.find(s => s.omie_codigo_servico === codigoServico);
    if (servico) {
      updateItem(index, 'servico', servico);
    }
  };

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

  const getFilteredServicos = (tool: UserTool | undefined): OmieServico[] => {
    if (!tool) return [];
    const categoryName = tool.tool_categories?.name?.toLowerCase().trim();
    if (!categoryName) return [];
    return servicos.filter(servico => {
      const descricaoLower = servico.descricao.toLowerCase();
      return descricaoLower.includes(categoryName);
    });
  };

  const getItemPrice = (item: ServiceItem): number | null => {
    if (!item.userTool) return null;
    const serviceType = item.servico?.descricao || '';
    const lastPrice = getLastPrice(item.userToolId, serviceType);
    if (lastPrice !== null) return lastPrice;
    const specs = item.userTool.specifications as Record<string, string> | null;
    const tablePrice = calculatePrice({
      tool_category_id: item.userTool.tool_category_id,
      specifications: specs,
    });
    return tablePrice;
  };

  const deliveryFee = DELIVERY_FEES[deliveryOption];

  const canProceed = () => {
    switch (currentStep) {
      case 'customer':
        return !!selectedOmieCustomer;
      case 'items':
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
    if (!profile) {
      toast({
        title: 'Erro',
        description: 'Dados do cliente não disponíveis',
        variant: 'destructive',
      });
      return;
    }
    if (!isStaff && !user) {
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
      
      const orderItems = items.map(item => {
        const estimatedPrice = getItemPrice(item);
        return {
          category: item.servico?.descricao || '',
          quantity: item.quantity || 1,
          omie_codigo_servico: item.servico?.omie_codigo_servico,
          userToolId: item.userToolId,
          toolName: item.userTool?.generated_name || item.userTool?.custom_name || item.userTool?.tool_categories?.name || '',
          notes: item.notes,
          photos: item.photos || [],
          unitPrice: estimatedPrice || 0,
          toolCategoryId: item.userTool?.tool_category_id,
          toolSpecs: item.userTool?.specifications || {},
        };
      });

      const buildToolInfo = (item: ServiceItem): string => {
        const parts: string[] = [];
        const toolName = item.userTool?.generated_name || item.userTool?.custom_name || item.userTool?.tool_categories?.name || '';
        if (toolName) parts.push(toolName);
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

      const subtotal = orderItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);

      const orderData = {
        items: orderItems,
        service_type: 'padrao',
        subtotal,
        delivery_fee: deliveryFee,
        total: subtotal + deliveryFee,
        notes: items.map(buildToolInfo).filter(Boolean).join(' || '),
        payment_method: paymentMethod,
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

      // Build staff context if employee is creating for a customer
      const staffContext = isStaff && selectedOmieCustomer ? {
        customerOmieCode: selectedOmieCustomer.codigo_cliente,
        customerUserId: selectedOmieCustomer.local_user_id || null,
      } : undefined;

      const result = await syncOrderToOmie(orderId, orderData, profilePayload, addressPayload, staffContext);

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

  const customerDisplayName = selectedOmieCustomer 
    ? (selectedOmieCustomer.nome_fantasia || selectedOmieCustomer.razao_social || 'Cliente')
    : '';
  const customerFirstName = customerDisplayName.split(' ')[0] || 'Cliente';

  // Create local profile for Omie-only customers so we can register tools
  const handleStaffAddTool = async () => {
    if (!selectedOmieCustomer) return;

    // If already has local_user_id, just open dialog
    if (selectedOmieCustomer.local_user_id) {
      setAddToolDialogOpen(true);
      return;
    }

    // Create a placeholder profile + omie_clientes mapping
    setCreatingLocalProfile(true);
    try {
      // Generate a deterministic UUID from omie_codigo_cliente to avoid duplicates
      const { data: existingMapping } = await supabase
        .from('omie_clientes')
        .select('user_id')
        .eq('omie_codigo_cliente', selectedOmieCustomer.codigo_cliente)
        .maybeSingle();

      if (existingMapping) {
        // Mapping already exists, use it
        setSelectedOmieCustomer(prev => prev ? { ...prev, local_user_id: existingMapping.user_id } : prev);
        setAddToolDialogOpen(true);
        return;
      }

      // Create a new auth user placeholder via edge function
      const { data: result, error } = await supabase.functions.invoke('omie-cliente', {
        body: { 
          action: 'criar_perfil_local', 
          cliente: {
            codigo_cliente: selectedOmieCustomer.codigo_cliente,
            razao_social: selectedOmieCustomer.razao_social,
            nome_fantasia: selectedOmieCustomer.nome_fantasia,
            cnpj_cpf: selectedOmieCustomer.cnpj_cpf,
            email: selectedOmieCustomer.email,
            telefone: selectedOmieCustomer.telefone,
            cidade: selectedOmieCustomer.cidade,
            estado: selectedOmieCustomer.estado,
            codigo_vendedor: selectedOmieCustomer.codigo_vendedor,
          }
        },
      });

      if (error) throw error;

      const localUserId = result?.user_id;
      if (!localUserId) throw new Error('Não foi possível criar perfil local');

      // Update local state
      setSelectedOmieCustomer(prev => prev ? { ...prev, local_user_id: localUserId } : prev);
      
      toast({
        title: 'Perfil criado',
        description: `Perfil local criado para ${customerFirstName}. Agora cadastre as ferramentas.`,
      });

      setAddToolDialogOpen(true);
    } catch (error) {
      console.error('Erro ao criar perfil local:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível preparar o cadastro do cliente. Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setCreatingLocalProfile(false);
    }
  };

  // Show loading while role is being determined
  if (roleLoading) {
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

  // Show loading only for non-staff or after customer is selected
  const showLoading = isStaff 
    ? (selectedOmieCustomer && (loadingData || loadingServicos || loadingTools))
    : (loadingServicos || loadingTools);

  if (showLoading && currentStep !== 'customer') {
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
                    'w-12 h-0.5 mx-1 mt-[-12px]',
                    index < currentStepIndex ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="animate-fade-in">
          {/* Step: Customer Selection (staff only) */}
          {currentStep === 'customer' && isStaff && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Selecionar Cliente</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Escolha o cliente para quem será feito o pedido
              </p>

              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome, email, telefone ou documento..."
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              {selectedOmieCustomer && (
                <div className="bg-primary/5 border-2 border-primary rounded-xl p-4 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <User className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold">{selectedOmieCustomer.nome_fantasia || selectedOmieCustomer.razao_social}</p>
                      <p className="text-sm text-muted-foreground">
                        {selectedOmieCustomer.cnpj_cpf || selectedOmieCustomer.telefone || selectedOmieCustomer.email || ''}
                      </p>
                      {selectedOmieCustomer.cidade && (
                        <p className="text-xs text-muted-foreground">
                          {selectedOmieCustomer.cidade}{selectedOmieCustomer.estado ? `/${selectedOmieCustomer.estado}` : ''}
                        </p>
                      )}
                    </div>
                    <Check className="w-5 h-5 text-primary" />
                  </div>
                </div>
              )}

              {loadingCustomers ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : customerSearch.trim().length < 2 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Digite pelo menos 2 caracteres para pesquisar clientes no Omie
                </p>
              ) : (
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {omieCustomers.map((customer) => (
                    <button
                      key={customer.codigo_cliente}
                      onClick={() => handleSelectCustomer(customer)}
                      className={cn(
                        'w-full p-3 rounded-xl border-2 text-left transition-all flex items-center gap-3',
                        selectedOmieCustomer?.codigo_cliente === customer.codigo_cliente
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      )}
                    >
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <User className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{customer.nome_fantasia || customer.razao_social}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[customer.cnpj_cpf, customer.telefone, customer.cidade && `${customer.cidade}/${customer.estado}`].filter(Boolean).join(' • ')}
                        </p>
                        {!customer.local_user_id && (
                          <p className="text-xs text-amber-600 mt-0.5">Sem cadastro no app</p>
                        )}
                      </div>
                    </button>
                  ))}
                  {omieCustomers.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Nenhum cliente encontrado no Omie
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step: Services / Items */}
          {currentStep === 'items' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Selecionar Ferramentas</h2>
              <p className="text-sm text-muted-foreground mb-2">
                {isStaff && selectedOmieCustomer
                  ? `Ferramentas de ${customerDisplayName}`
                  : 'Escolha suas ferramentas cadastradas e o serviço desejado'}
              </p>
              {isStaff && selectedOmieCustomer && (
                <p className="text-xs text-primary mb-6">
                  Cliente: {customerDisplayName}
                </p>
              )}

              {/* Assistente por voz/texto */}
              {userTools.length > 0 && (
                <div className="mb-6 space-y-4">
                  <VoiceServiceInput
                    userTools={userTools}
                    onItemsIdentified={handleVoiceItemsIdentified}
                    isLoading={isSubmitting}
                  />
                  
                  <ToolImageIdentifier
                    categories={toolCategories}
                    onCategoryIdentified={(categoryId, _specs) => {
                      const matchingTools = userTools.filter(t => t.tool_category_id === categoryId);
                      if (matchingTools.length > 0) {
                        matchingTools.forEach(tool => {
                          if (!items.some(item => item.userToolId === tool.id)) {
                            addItem(tool.id);
                          }
                        });
                        toast({
                          title: 'Ferramenta encontrada!',
                          description: `${matchingTools.length} ferramenta(s) adicionada(s) ao pedido`,
                        });
                      } else {
                        toast({
                          title: 'Ferramenta não cadastrada',
                          description: 'Nenhuma ferramenta dessa categoria foi encontrada no cadastro. Cadastre-a primeiro.',
                          variant: 'destructive',
                        });
                      }
                    }}
                  />
                </div>
              )}

              {/* Ferramentas sem cadastro */}
              {userTools.length === 0 ? (
                <div className="bg-muted/50 rounded-xl p-6 text-center">
                  <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <h3 className="font-semibold mb-2">Nenhuma ferramenta cadastrada</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    {isStaff 
                      ? `${customerDisplayName || 'O cliente'} não possui ferramentas cadastradas. Cadastre uma ferramenta para continuar.`
                      : 'Você precisa cadastrar suas ferramentas antes de solicitar um serviço'}
                  </p>
                  {isStaff ? (
                    <Button onClick={() => handleStaffAddTool()} disabled={creatingLocalProfile}>
                      {creatingLocalProfile ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="w-4 h-4 mr-2" />
                      )}
                      Cadastrar Ferramenta para {customerFirstName}
                    </Button>
                  ) : (
                    <Button onClick={() => navigate('/tools')}>
                      <Wrench className="w-4 h-4 mr-2" />
                      Cadastrar Ferramentas
                    </Button>
                  )}
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

                          {/* Seleção de serviço */}
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
                            <label className="text-sm font-medium mb-2 block">
                              Quantidade
                              {item.userTool?.quantity && (
                                <span className="text-xs text-muted-foreground ml-1">(máx: {item.userTool.quantity})</span>
                              )}
                            </label>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => updateItem(index, 'quantity', Math.max(1, (item.quantity || 1) - 1))}
                                className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted"
                              >
                                -
                              </button>
                              <span className="w-10 text-center font-semibold">{item.quantity || 1}</span>
                              <button
                                onClick={() => {
                                  const maxQty = item.userTool?.quantity || 1;
                                  const currentQty = item.quantity || 1;
                                  if (currentQty >= maxQty) {
                                    toast({
                                      title: 'Quantidade máxima atingida',
                                      description: `Esta ferramenta possui apenas ${maxQty} unidade(s) cadastrada(s).`,
                                      variant: 'default',
                                    });
                                    return;
                                  }
                                  updateItem(index, 'quantity', currentQty + 1);
                                }}
                                disabled={(item.quantity || 1) >= (item.userTool?.quantity || 1)}
                                className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
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
                          {effectiveUserId && (
                            <div>
                              <label className="text-sm font-medium mb-2 block">Fotos (opcional)</label>
                              <PhotoUpload
                                photos={item.photos || []}
                                onPhotosChange={(photos) => updateItem(index, 'photos', photos)}
                                userId={effectiveUserId}
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
                        {items.length > 0 ? 'Adicionar mais ferramentas:' : 'Ferramentas cadastradas:'}
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
                  {isStaff ? (
                    <Button
                      variant="ghost"
                      className="w-full mt-4"
                      onClick={() => handleStaffAddTool()}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Cadastrar nova ferramenta para {customerFirstName}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className="w-full mt-4"
                      onClick={() => navigate('/tools')}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Cadastrar nova ferramenta
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step: Delivery */}
          {currentStep === 'delivery' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Entrega</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Como deseja receber as ferramentas?
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

          {/* Step: Review */}
          {currentStep === 'review' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Revisar Pedido</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Confira os detalhes antes de enviar
              </p>

              {isStaff && selectedOmieCustomer && (
                <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                  <h3 className="font-semibold mb-2">Cliente</h3>
                  <p className="text-sm">{customerDisplayName}</p>
                  <p className="text-sm text-muted-foreground">
                    {[selectedOmieCustomer.cnpj_cpf, selectedOmieCustomer.telefone, selectedOmieCustomer.email].filter(Boolean).join(' • ')}
                  </p>
                </div>
              )}

              <div className="bg-secondary border border-border rounded-lg p-3 mb-4">
                <p className="text-sm text-muted-foreground">
                  💡 {items.some(item => getItemPrice(item) !== null)
                    ? 'Preços estimados com base na tabela de preços. O valor final pode ser ajustado na triagem.'
                    : 'O valor será informado após a triagem das ferramentas'}
                </p>
              </div>

              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-3">Serviços Solicitados</h3>
                <div className="space-y-3">
                  {items.map((item, index) => {
                    const price = getItemPrice(item);
                    return (
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
                          {price !== null ? (
                            <span className="text-sm font-medium text-primary">
                              R$ {(price * (item.quantity || 1)).toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground italic">
                              A orçar
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
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

              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-2">Pagamento</h3>
                {isStaff ? (
                  <div className="space-y-2">
                    {PAYMENT_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        onClick={() => setPaymentMethod(option.id)}
                        className={cn(
                          'w-full p-3 rounded-lg border-2 text-left transition-all',
                          paymentMethod === option.id
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-medium text-sm">{option.label}</span>
                            <p className="text-xs text-muted-foreground">{option.description}</p>
                          </div>
                          {paymentMethod === option.id && (
                            <Check className="w-4 h-4 text-primary" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <p className="text-sm">À vista</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      PIX ou pagamento presencial na entrega/retirada
                    </p>
                  </>
                )}
              </div>

              <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
                {(() => {
                  const estimatedSubtotal = items.reduce((sum, item) => {
                    const price = getItemPrice(item);
                    return sum + (price !== null ? price * (item.quantity || 1) : 0);
                  }, 0);
                  const hasAllPrices = items.every(item => getItemPrice(item) !== null);
                  const hasAnyPrices = items.some(item => getItemPrice(item) !== null);

                  return (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Serviços</span>
                        {hasAnyPrices ? (
                          <span className="text-primary font-medium">
                            R$ {estimatedSubtotal.toFixed(2)}
                            {!hasAllPrices && ' *'}
                          </span>
                        ) : (
                          <span className="italic text-muted-foreground">A orçar após triagem</span>
                        )}
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Frete</span>
                        <span className="text-primary font-medium">Grátis</span>
                      </div>
                      <div className="border-t border-border pt-2 flex justify-between font-semibold text-base">
                        <span>Total{!hasAllPrices && hasAnyPrices ? ' (estimado)' : ''}</span>
                        {hasAnyPrices ? (
                          <span className="text-primary">R$ {(estimatedSubtotal + deliveryFee).toFixed(2)}</span>
                        ) : (
                          <span className="text-muted-foreground italic">A definir</span>
                        )}
                      </div>
                      {hasAnyPrices && !hasAllPrices && (
                        <p className="text-xs text-muted-foreground">* Alguns itens ainda serão orçados na triagem</p>
                      )}
                    </div>
                  );
                })()}
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

      {/* Add Tool Dialog for staff - adds tool to customer */}
      {isStaff && selectedOmieCustomer?.local_user_id && (
        <AddToolDialog
          open={addToolDialogOpen}
          onOpenChange={setAddToolDialogOpen}
          onToolAdded={() => {
            // Refresh effectiveUserId and reload tools
            loadUserTools();
          }}
          categories={toolCategories}
          targetUserId={selectedOmieCustomer.local_user_id}
        />
      )}
    </div>
  );
};

export default NewOrder;
