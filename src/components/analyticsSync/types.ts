// Tipos e constantes da tela de Sincronização & Analytics.
// Extraídos verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Database, Package, ShoppingCart, Warehouse, CheckCircle, AlertCircle, Clock, Loader2 } from "lucide-react";

export type SyncEntity = "customers" | "products" | "orders" | "inventory";
export type OmieAccount = "vendas" | "servicos";

export interface SyncState {
  id: string;
  entity_type: string;
  account: string;
  last_sync_at: string | null;
  total_synced: number;
  status: string;
  error_message: string | null;
  updated_at: string;
}

export const ENTITY_CONFIG: Record<SyncEntity, { label: string; icon: typeof Database; description: string }> = {
  customers: { label: "Clientes", icon: Database, description: "Sincronizar clientes e mapear com perfis locais" },
  products: { label: "Produtos", icon: Package, description: "Catálogo de produtos com família e subfamília" },
  orders: { label: "Pedidos", icon: ShoppingCart, description: "Sync incremental com janela de 24h" },
  inventory: { label: "Estoque", icon: Warehouse, description: "Posição de estoque + CMC para custo" },
};

export const STATUS_MAP: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
  idle: { variant: "secondary", icon: Clock },
  running: { variant: "default", icon: Loader2 },
  complete: { variant: "outline", icon: CheckCircle },
  error: { variant: "destructive", icon: AlertCircle },
};
