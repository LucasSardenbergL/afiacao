import { supabase } from "@/integrations/supabase/client";

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
      console.error("[Omie Service] Erro ao sincronizar:", error);
      return { success: false, error: error.message };
    }

    return data as OmieSyncResult;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

export async function checkOmieClient(): Promise<{
  exists: boolean;
  omie_codigo_cliente: number | null;
}> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "check_client",
      },
    });

    if (error) {
      console.error("[Omie Service] Erro ao verificar cliente:", error);
      return { exists: false, omie_codigo_cliente: null };
    }

    return data;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return { exists: false, omie_codigo_cliente: null };
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

export async function listOmieServices(): Promise<{
  success: boolean;
  servicos: OmieServico[];
  error?: string;
}> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "list_services",
      },
    });

    if (error) {
      console.error("[Omie Service] Erro ao listar serviços:", error);
      return { success: false, servicos: [], error: error.message };
    }

    return data;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return {
      success: false,
      servicos: [],
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

export interface OmieContaCorrente {
  nCodCC: number;
  cDescricao: string;
  cCodCCInt: string;
  cNomeBanco: string;
  cAgencia: string;
  cNumeroConta: string;
  cTipo: string;
}

export async function listOmieContasCorrentes(): Promise<{
  success: boolean;
  contas_correntes: OmieContaCorrente[];
  error?: string;
}> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "list_contas_correntes",
      },
    });

    if (error) {
      console.error("[Omie Service] Erro ao listar contas correntes:", error);
      return { success: false, contas_correntes: [], error: error.message };
    }

    return data;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return {
      success: false,
      contas_correntes: [],
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

export async function syncOmieServices(): Promise<{
  success: boolean;
  adicionados?: number;
  atualizados?: number;
  inativados?: number;
  error?: string;
}> {
  try {
    const { data, error } = await supabase.functions.invoke("omie-sync", {
      body: {
        action: "sync_services",
      },
    });

    if (error) {
      console.error("[Omie Service] Erro ao sincronizar serviços:", error);
      return { success: false, error: error.message };
    }

    return data;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
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
      console.error("[Omie Service] Erro ao atualizar pedido:", error);
      return { success: false, error: error.message };
    }

    return data as UpdateOrderResult;
  } catch (err) {
    console.error("[Omie Service] Erro inesperado:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
