// Tipos do módulo de fidelidade (loyalty).
// Extraídos verbatim de src/pages/AdminLoyalty.tsx (god-component split).

export interface CustomerPoints {
  user_id: string;
  name: string;
  total_earned: number;
  total_redeemed: number;
  balance: number;
}

export interface PointRecord {
  id: string;
  user_id: string;
  points: number;
  type: string;
  description: string | null;
  created_at: string;
  order_id: string | null;
}

export interface RedemptionRecord {
  id: string;
  user_id: string;
  reward_name: string;
  points_spent: number;
  status: string;
  created_at: string;
}
