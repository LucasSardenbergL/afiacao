import { TrendingUp, Package, ShoppingBag, DollarSign, Palette, Activity, type LucideIcon } from 'lucide-react';
import type { ZoneId } from './persona-config';

export interface ZoneMeta {
  id: ZoneId;
  label: string;
  caption: string;
  icon: LucideIcon;
  cockpitPath: string;
}

export const ZONE_META: Record<ZoneId, ZoneMeta> = {
  vendas:       { id: 'vendas', label: 'Vendas', caption: 'Pipeline operacional', icon: TrendingUp, cockpitPath: '/sales' },
  estoque:      { id: 'estoque', label: 'Estoque', caption: 'Recebimento e picking', icon: Package, cockpitPath: '/admin/estoque/picking' },
  reposicao:    { id: 'reposicao', label: 'Reposição', caption: 'Sugestões e alertas', icon: ShoppingBag, cockpitPath: '/admin/reposicao/sessao' },
  financeiro:   { id: 'financeiro', label: 'Financeiro', caption: 'Aging e fluxo', icon: DollarSign, cockpitPath: '/financeiro/cockpit' },
  tintometrico: { id: 'tintometrico', label: 'Tintométrico', caption: 'Fórmulas Oben', icon: Palette, cockpitPath: '/tintometrico' },
  sistema:      { id: 'sistema', label: 'Sistema', caption: 'Aprovações e integrações', icon: Activity, cockpitPath: '/admin/approvals' },
};
