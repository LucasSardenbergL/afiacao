// Tipos do CustomerDashboard.
// Extraídos verbatim de src/components/CustomerDashboard.tsx (god-component split).
import type { LucideIcon } from 'lucide-react';

export interface Profile {
  name: string;
  customer_type: string | null;
  document: string | null;
}

export interface Order {
  id: string;
  status: string;
  created_at: string;
  service_type: string;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  next_sharpening_due: string | null;
  last_sharpened_at: string | null;
  sharpening_interval_days: number | null;
  tool_categories: { name: string; suggested_interval_days: number | null };
}

export interface PriorityAction {
  type: 'quote' | 'order_issue' | 'tools_overdue' | 'no_tools' | 'no_address' | 'all_good';
  title: string;
  description: string;
  buttonLabel?: string;
  path?: string;
  variant: 'warning' | 'destructive' | 'default' | 'success';
  icon: LucideIcon;
  orderId?: string;
}
