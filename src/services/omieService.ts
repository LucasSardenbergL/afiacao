import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

interface OrderData {
  items: Array<{
    category: string;
    quantity: number;
  }>;
  service_type: string;
  subtotal: number;
  delivery_fee: number;
  total: number;
  notes?: string;
}

interface ProfileData {
  name: string;
  email?: string;
  phone?: string;
  document?: string;
}

interface AddressData {
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
  zip_code: string;
}

interface OmieSyncResult {
  success: boolean;
  omie_cliente?: number;
  omie_os?: {
    nCodOS: number;
    cNumOS: string;
  };
  error?: string;
}

export async function syncOrderToOmie(
  orderId: string,
  orderData: OrderData,
  profileData: ProfileData,
  addressData?: AddressData,
  staffContext?: {
    customerOmieCode: number;
    customerUserId?: string | null;
    customerCodigoVendedor?: number | null;
  }
): Promise<OmieSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "sync_order",
        orderId,
        orderData,
        profileData,
        addressData,
        staffContext,
      },
    });

    if (error) {
      logger.error("Omie sync_order failed", {
        functionName: "omie-sync",
        action: "sync_order",
        orderId,
        error,
      });
      return { success: false, error: error.message };
    }

    return data as OmieSyncResult;
  } catch (err) {
    logger.error("Omie sync_order unexpected exception", {
      functionName: "omie-sync",
      action: "sync_order",
      orderId,
      error: err,
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

export interface OmieServico {
  omie_codigo_servico: number;
  omie_codigo_integracao: string;
  descricao: string;
  codigo_lc116: string;
  codigo_servico_municipio: string;
  valor_unitario: number;
  unidade: string;
}

export interface UpdateOrderData {
  items: Array<{
    category: string;
    quantity: number;
    omie_codigo_servico?: number;
    brandModel?: string;
    notes?: string;
    unitPrice?: number;
  }>;
  subtotal: number;
  delivery_fee: number;
  total: number;
  notes?: string;
  status?: string;
}

export interface UpdateOrderResult {
  success: boolean;
  nCodOS?: number;
  cNumOS?: string;
  error?: string;
}

export async function updateOrderInOmie(
  orderId: string,
  orderData: UpdateOrderData
): Promise<UpdateOrderResult> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "update_order",
        orderId,
        orderData,
      },
    });

    if (error) {
      logger.error("Omie update_order failed", {
        functionName: "omie-sync",
        action: "update_order",
        orderId,
        error,
      });
      return { success: false, error: error.message };
    }

    return data as UpdateOrderResult;
  } catch (err) {
    logger.error("Omie update_order unexpected exception", {
      functionName: "omie-sync",
      action: "update_order",
      orderId,
      error: err,
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

export async function deleteOrderFromOmie(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: { action: "delete_order", orderId },
    });
    if (error) return { success: false, error: error.message };
    return data;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export async function checkOsExistsInOmie(orderId: string): Promise<{ exists: boolean }> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: { action: "check_os_exists", orderId },
    });
    if (error) return { exists: true }; // Assume exists on error
    return data;
  } catch (error) {
    logger.warn('Failed to check OS exists in Omie (assuming exists)', {
      functionName: "omie-sync",
      action: "check_os_exists",
      orderId,
      error,
    });
    return { exists: true };
  }
}
