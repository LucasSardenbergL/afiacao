import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { updateOrderInOmie, deleteOrderFromOmie, checkOsExistsInOmie } from '@/services/omieService';
import { logger } from '@/lib/logger';
import type { Order, OrderItem, Profile } from '@/components/admin-order/types';

export function useAdminOrderDetail(id: string | undefined) {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading, role } = useAuth();

  const [order, setOrder] = useState<Order | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingOmie, setSyncingOmie] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [itemPrices, setItemPrices] = useState<Record<number, string>>({});
  const [selectedStatus, setSelectedStatus] = useState('');

  const [customerUserId, setCustomerUserId] = useState<string | undefined>();
  const { priceHistory, loadPriceHistory, getLastPrice, savePriceEntry } = usePriceHistory(customerUserId);
  const { defaultPrices, loadDefaultPrices, calculatePrice } = usePricingEngine();

  // Auth guard
  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, role, navigate]);

  // Load order
  useEffect(() => {
    if (id && isStaff) {
      loadOrder();
      loadDefaultPrices();
    }
  }, [id, isStaff]);

  // Load price history
  useEffect(() => {
    if (customerUserId) {
      loadPriceHistory();
    }
  }, [customerUserId, loadPriceHistory]);

  // Auto-apply prices
  useEffect(() => {
    if (!order || !defaultPrices.length) return;

    const newPrices = { ...itemPrices };
    let changed = false;

    order.items.forEach((item, index) => {
      if (newPrices[index] && parseFloat(newPrices[index]) > 0) return;

      const lastPrice = getLastPrice(item.userToolId, item.category);
      if (lastPrice !== null) {
        newPrices[index] = lastPrice.toString();
        changed = true;
        return;
      }

      if (item.toolCategoryId) {
        const tablePrice = calculatePrice({
          tool_category_id: item.toolCategoryId,
          specifications: item.toolSpecs || null,
        });
        if (tablePrice !== null) {
          newPrices[index] = tablePrice.toString();
          changed = true;
        }
      }
    });

    if (changed) setItemPrices(newPrices);
  }, [order, defaultPrices, priceHistory]);

  const loadOrder = async () => {
    if (!id) return;

    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;

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
          toolCategoryId: i.toolCategoryId as string | undefined,
          toolSpecs: i.toolSpecs as Record<string, string> | undefined,
        };
      });

      const enrichedItems = await Promise.all(
        parsedItems.map(async (item) => {
          if (item.userToolId && !item.toolCategoryId) {
            const { data: toolData } = await supabase
              .from('user_tools')
              .select('tool_category_id, specifications')
              .eq('id', item.userToolId)
              .single();

            if (toolData) {
              return {
                ...item,
                toolCategoryId: toolData.tool_category_id,
                toolSpecs: (toolData.specifications as Record<string, string>) || {},
              };
            }
          }
          return item;
        })
      );

      const orderData: Order = {
        id: data.id,
        status: data.status,
        created_at: data.created_at,
        updated_at: data.updated_at,
        items: enrichedItems,
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

      const initialPrices: Record<number, string> = {};
      orderData.items.forEach((item, index) => {
        initialPrices[index] = item.unitPrice ? item.unitPrice.toString() : '';
      });
      setItemPrices(initialPrices);

      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, document, phone')
        .eq('user_id', orderData.user_id)
        .single();

      if (profileData) setProfile(profileData);

      const osCheck = await checkOsExistsInOmie(data.id);
      if (!osCheck.exists) {
        toast.error('Pedido excluído no Omie', {
          description: 'Esta OS foi excluída no Omie. O pedido será removido.',
        });
        await deleteOrderFromOmie(data.id);
        navigate('/admin');
        return;
      }
    } catch (error) {
      logger.error('Failed to load order', { stage: 'load_order', orderId: id, error });
      toast.error('Erro', {
        description: 'Não foi possível carregar o pedido',
      });
    } finally {
      setLoading(false);
    }
  };

  const applySuggestedPrice = (index: number, item: OrderItem) => {
    const lastPrice = getLastPrice(item.userToolId, item.category);
    if (lastPrice !== null) {
      setItemPrices((prev) => ({ ...prev, [index]: lastPrice.toString() }));
      toast.success('Preço do histórico aplicado', { description: `Último preço cobrado: R$ ${lastPrice.toFixed(2)}` });
      return;
    }

    if (item.toolCategoryId) {
      const tablePrice = calculatePrice({
        tool_category_id: item.toolCategoryId,
        specifications: item.toolSpecs || null,
      });
      if (tablePrice !== null) {
        setItemPrices((prev) => ({ ...prev, [index]: tablePrice.toString() }));
        toast.success('Preço da tabela aplicado', { description: `Valor da tabela padrão: R$ ${tablePrice.toFixed(2)}` });
        return;
      }
    }

    toast.success('Sem preço sugerido', { description: 'Nenhum preço encontrado no histórico ou tabela padrão' });
  };

  const hasAnySuggestedPrice = (item: OrderItem): boolean => {
    if (getLastPrice(item.userToolId, item.category) !== null) return true;
    if (item.toolCategoryId) {
      const tablePrice = calculatePrice({
        tool_category_id: item.toolCategoryId,
        specifications: item.toolSpecs || null,
      });
      if (tablePrice !== null) return true;
    }
    return false;
  };

  const getSuggestedPriceSource = (item: OrderItem): 'history' | 'table' | null => {
    if (getLastPrice(item.userToolId, item.category) !== null) return 'history';
    if (item.toolCategoryId) {
      const tablePrice = calculatePrice({
        tool_category_id: item.toolCategoryId,
        specifications: item.toolSpecs || null,
      });
      if (tablePrice !== null) return 'table';
    }
    return null;
  };

  const handleSave = async (syncToOmie: boolean = false) => {
    if (!order) return;

    setSaving(true);
    if (syncToOmie) setSyncingOmie(true);

    try {
      const updatedItems = order.items.map((item, index) => ({
        ...item,
        unitPrice: parseFloat(itemPrices[index] || '0') || 0,
      }));

      const subtotal = updatedItems.reduce((sum, item) => sum + (item.unitPrice || 0) * (item.quantity || 1), 0);
      const total = subtotal + (order.delivery_fee || 0);

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

      for (const item of updatedItems) {
        if (item.unitPrice && item.unitPrice > 0) {
          await savePriceEntry(item.userToolId || null, item.category, item.unitPrice);
        }
      }

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
          toast.success('Pedido sincronizado!', { description: `OS ${omieResult.cNumOS} atualizada no Omie` });
        } else {
          toast.error('Erro ao sincronizar com Omie', { description: omieResult.error || 'Tente novamente' });
          setSaving(false);
          setSyncingOmie(false);
          return;
        }
      } else {
        toast.success('Pedido atualizado!', { description: 'Preços salvos localmente' });
      }

      navigate('/admin');
    } catch (error) {
      logger.critical('Failed to save order — possible data inconsistency', {
        stage: 'update_status', orderId: order.id, syncToOmie, error,
      });
      toast.error('Erro', { description: 'Não foi possível salvar o pedido' });
    } finally {
      setSaving(false);
      setSyncingOmie(false);
    }
  };

  const handleDelete = async () => {
    if (!order) return;
    setDeleting(true);
    try {
      const result = await deleteOrderFromOmie(order.id);
      if (result.success) {
        toast.success('Pedido excluído', { description: 'O pedido foi excluído do app e do Omie' });
        navigate('/admin');
      } else {
        toast.error('Erro ao excluir', { description: result.error });
      }
    } catch (error) {
      logger.error('Failed to delete order', { stage: 'delete_order', orderId: order.id, error });
      toast.error('Erro', { description: 'Não foi possível excluir o pedido' });
    } finally {
      setDeleting(false);
    }
  };

  // Computed totals
  const currentSubtotal = order
    ? order.items.reduce((sum, _, index) => {
        const price = parseFloat(itemPrices[index] || '0') || 0;
        const qty = order.items[index].quantity || 1;
        return sum + price * qty;
      }, 0)
    : 0;
  const currentTotal = currentSubtotal + (order?.delivery_fee || 0);

  return {
    order,
    profile,
    loading: authLoading || loading,
    saving,
    syncingOmie,
    deleting,
    isStaff,
    itemPrices,
    setItemPrices,
    selectedStatus,
    setSelectedStatus,
    currentSubtotal,
    currentTotal,
    applySuggestedPrice,
    hasAnySuggestedPrice,
    getSuggestedPriceSource,
    handleSave,
    handleDelete,
  };
}
