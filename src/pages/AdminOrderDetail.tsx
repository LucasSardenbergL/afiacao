import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderChat } from '@/components/OrderChat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { updateOrderInOmie } from '@/services/omieService';
import { Loader2, Save, Package, Clock, Truck, CheckCircle, Building2, DollarSign, Sparkles, ImageIcon, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const EMPLOYEE_ORDER_STATUS = {
  pedido_recebido: { label: 'Pedido Recebido', icon: Package, color: 'bg-blue-500' },
  aguardando_coleta: { label: 'Aguardando Coleta', icon: Clock, color: 'bg-amber-500' },
  em_triagem: { label: 'Coletado e na Empresa', icon: Building2, color: 'bg-purple-500' },
  em_rota: { label: 'A Caminho da Entrega', icon: Truck, color: 'bg-amber-500' },
  entregue: { label: 'Entregue', icon: CheckCircle, color: 'bg-emerald-500' },
};

interface OrderItem {
  category: string;
  quantity: number;
  omie_codigo_servico?: number;
  brandModel?: string;
  notes?: string;
  photos?: string[];
  userToolId?: string;
  unitPrice?: number;
}

interface Order {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
  total: number;
  subtotal: number;
  delivery_fee: number;
  delivery_option: string;
  user_id: string;
  notes: string | null;
}

interface Profile {
  name: string;
  document: string | null;
  phone: string | null;
}

const AdminOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [order, setOrder] = useState<Order | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingOmie, setSyncingOmie] = useState(false);
  
  // Item prices state
  const [itemPrices, setItemPrices] = useState<{ [key: number]: string }>({});
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  
  // Price history hook for customer
  const [customerUserId, setCustomerUserId] = useState<string | undefined>();
  const { priceHistory, loadPriceHistory, getLastPrice, savePriceEntry } = usePriceHistory(customerUserId);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (id && isStaff) {
      loadOrder();
    }
  }, [id, isStaff]);

  useEffect(() => {
    if (customerUserId) {
      loadPriceHistory();
    }
  }, [customerUserId, loadPriceHistory]);

  const loadOrder = async () => {
    if (!id) return;
    
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;

      // Parse items from JSON
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const parsedItems: OrderItem[] = rawItems.map((item: unknown) => {
        const i = item as Record<string, unknown>;
        return {
          category: (i.category as string) || '',
          quantity: (i.quantity as number) || 1,
          omie_codigo_servico: i.omie_codigo_servico as number | undefined,
          brandModel: i.brandModel as string | undefined,
          notes: i.notes as string | undefined,
          photos: (i.photos as string[]) || [],
          userToolId: i.userToolId as string | undefined,
          unitPrice: i.unitPrice as number | undefined,
        };
      });

      const orderData: Order = {
        id: data.id,
        status: data.status,
        created_at: data.created_at,
        updated_at: data.updated_at,
        items: parsedItems,
        total: data.total,
        subtotal: data.subtotal,
        delivery_fee: data.delivery_fee,
        delivery_option: data.delivery_option,
        user_id: data.user_id,
        notes: data.notes,
      };
      setOrder(orderData);
      setSelectedStatus(orderData.status);
      setCustomerUserId(orderData.user_id);
      
      // Initialize prices from existing items or empty
      const initialPrices: { [key: number]: string } = {};
      orderData.items.forEach((item, index) => {
        initialPrices[index] = item.unitPrice ? item.unitPrice.toString() : '';
      });
      setItemPrices(initialPrices);

      // Load profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, document, phone')
        .eq('user_id', orderData.user_id)
        .single();

      if (profileData) {
        setProfile(profileData);
      }
    } catch (error) {
      console.error('Error loading order:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível carregar o pedido',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const applySuggestedPrice = (index: number, item: OrderItem) => {
    const lastPrice = getLastPrice(item.userToolId, item.category);
    if (lastPrice !== null) {
      setItemPrices(prev => ({
        ...prev,
        [index]: lastPrice.toString(),
      }));
      toast({
        title: 'Preço aplicado',
        description: `Último preço encontrado: R$ ${lastPrice.toFixed(2)}`,
      });
    } else {
      toast({
        title: 'Sem histórico',
        description: 'Nenhum preço anterior encontrado para este item',
        variant: 'default',
      });
    }
  };

  const hasHistoricalPrice = (item: OrderItem): boolean => {
    return getLastPrice(item.userToolId, item.category) !== null;
  };

  const handleSave = async (syncToOmie: boolean = false) => {
    if (!order) return;
    
    setSaving(true);
    if (syncToOmie) setSyncingOmie(true);
    
    try {
      // Build updated items with prices
      const updatedItems = order.items.map((item, index) => ({
        ...item,
        unitPrice: parseFloat(itemPrices[index] || '0') || 0,
      }));

      // Calculate totals
      const subtotal = updatedItems.reduce((sum, item) => {
        return sum + (item.unitPrice || 0) * (item.quantity || 1);
      }, 0);
      const total = subtotal + (order.delivery_fee || 0);

      // Update order locally first
      const { error } = await supabase
        .from('orders')
        .update({
          items: updatedItems,
          subtotal,
          total,
          status: selectedStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      if (error) throw error;

      // Save price history for each item with a price
      for (let i = 0; i < updatedItems.length; i++) {
        const item = updatedItems[i];
        if (item.unitPrice && item.unitPrice > 0) {
          await savePriceEntry(
            item.userToolId || null,
            item.category,
            item.unitPrice
          );
        }
      }

      // Sync to Omie if requested
      if (syncToOmie) {
        const omieResult = await updateOrderInOmie(order.id, {
          items: updatedItems,
          subtotal,
          delivery_fee: order.delivery_fee || 0,
          total,
          notes: order.notes || undefined,
          status: selectedStatus,
        });

        if (omieResult.success) {
          toast({
            title: 'Pedido sincronizado!',
            description: `OS ${omieResult.cNumOS} atualizada no Omie`,
          });
        } else {
          toast({
            title: 'Erro ao sincronizar com Omie',
            description: omieResult.error || 'Tente novamente',
            variant: 'destructive',
          });
          // Don't navigate away on Omie error
          setSaving(false);
          setSyncingOmie(false);
          return;
        }
      } else {
        toast({
          title: 'Pedido atualizado!',
          description: 'Preços salvos localmente',
        });
      }
      
      navigate('/admin');
    } catch (error) {
      console.error('Error saving order:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível salvar o pedido',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
      setSyncingOmie(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Detalhes do Pedido" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Pedido não encontrado" showBack />
        <div className="flex items-center justify-center pt-32">
          <p className="text-muted-foreground">Pedido não encontrado</p>
        </div>
        <BottomNav />
      </div>
    );
  }

  const statusInfo = EMPLOYEE_ORDER_STATUS[order.status as keyof typeof EMPLOYEE_ORDER_STATUS];

  // Calculate current total
  const currentSubtotal = order.items.reduce((sum, _, index) => {
    const price = parseFloat(itemPrices[index] || '0') || 0;
    const qty = order.items[index].quantity || 1;
    return sum + price * qty;
  }, 0);
  const currentTotal = currentSubtotal + (order.delivery_fee || 0);

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Triagem de Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Customer info */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg">{profile?.name || 'Cliente'}</CardTitle>
                {profile?.document && (
                  <p className="text-sm text-muted-foreground">Doc: {profile.document}</p>
                )}
                {profile?.phone && (
                  <p className="text-sm text-muted-foreground">Tel: {profile.phone}</p>
                )}
              </div>
              <Badge variant="secondary" className={`${statusInfo?.color || 'bg-gray-500'} text-white`}>
                {statusInfo?.label || order.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              📅 Criado em {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
            </p>
          </CardContent>
        </Card>

        {/* Status change */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Alterar Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={selectedStatus} onValueChange={setSelectedStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione o status" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(EMPLOYEE_ORDER_STATUS).map(([key, { label }]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Items with pricing */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Definir Preços dos Itens
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {order.items.map((item, index) => (
              <div key={index} className="p-3 bg-muted/50 rounded-lg space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium">{item.category}</p>
                    {item.brandModel && (
                      <p className="text-sm text-muted-foreground">{item.brandModel}</p>
                    )}
                    <p className="text-sm text-muted-foreground">Qtd: {item.quantity || 1}</p>
                  </div>
                  {item.photos && item.photos.length > 0 && (
                    <div className="flex gap-1">
                      <ImageIcon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{item.photos.length}</span>
                    </div>
                  )}
                </div>

                {item.notes && (
                  <p className="text-sm text-muted-foreground italic border-l-2 border-primary/50 pl-2">
                    "{item.notes}"
                  </p>
                )}

                {/* Photos preview */}
                {item.photos && item.photos.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {item.photos.map((photo, photoIdx) => (
                      <img
                        key={photoIdx}
                        src={photo}
                        alt={`Foto ${photoIdx + 1}`}
                        className="w-16 h-16 object-cover rounded-lg border"
                      />
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <div className="flex-1">
                    <Label htmlFor={`price-${index}`} className="text-xs mb-1 block">
                      Preço unitário (R$)
                    </Label>
                    <Input
                      id={`price-${index}`}
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0,00"
                      value={itemPrices[index] || ''}
                      onChange={(e) => setItemPrices(prev => ({
                        ...prev,
                        [index]: e.target.value,
                      }))}
                      className="h-9"
                    />
                  </div>
                  
                  {hasHistoricalPrice(item) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-5 gap-1"
                      onClick={() => applySuggestedPrice(index, item)}
                    >
                      <Sparkles className="w-3 h-3" />
                      Último
                    </Button>
                  )}
                </div>

                {(parseFloat(itemPrices[index] || '0') > 0) && (
                  <p className="text-sm text-right font-medium">
                    Subtotal: R$ {((parseFloat(itemPrices[index] || '0') || 0) * (item.quantity || 1)).toFixed(2)}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Summary */}
        <Card className="mb-6">
          <CardContent className="pt-4">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>R$ {currentSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Taxa de entrega</span>
                <span>R$ {(order.delivery_fee || 0).toFixed(2)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-base">
                <span>Total</span>
                <span>R$ {currentTotal.toFixed(2)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Chat with customer */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">💬 Chat com Cliente</CardTitle>
          </CardHeader>
          <CardContent>
            <OrderChat orderId={order.id} />
          </CardContent>
        </Card>

        {/* Action buttons */}
        <div className="space-y-3 mb-6">
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            onClick={() => navigate(`/admin/orders/${order.id}/quality`)}
          >
            <CheckCircle className="w-4 h-4 mr-2" />
            Checklist de Qualidade
          </Button>
          
          <Button
            className="w-full"
            size="lg"
            onClick={() => handleSave(true)}
            disabled={saving || syncingOmie}
          >
            {syncingOmie ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Salvar e Sincronizar com Omie
          </Button>
          
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            onClick={() => handleSave(false)}
            disabled={saving || syncingOmie}
          >
            {saving && !syncingOmie ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Salvar Apenas Localmente
          </Button>
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminOrderDetail;
