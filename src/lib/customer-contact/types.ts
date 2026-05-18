export type ContactCargo =
  | 'dono'
  | 'socio'
  | 'gerente'
  | 'comprador'
  | 'secretaria'
  | 'aplicador'
  | 'tecnico'
  | 'outro';

export interface CustomerContact {
  id: string;
  customer_user_id: string;
  phone: string;
  nome: string | null;
  cargo: ContactCargo | null;
  email: string | null;
  is_decision_maker: boolean;
  is_primary: boolean;
  whatsapp_only: boolean;
  birthday: string | null;
  notas: string | null;
  source: 'manual' | 'omie' | 'auto_detected_call' | 'auto_import';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const CARGO_LABEL: Record<ContactCargo, string> = {
  dono: 'Dono',
  socio: 'Sócio',
  gerente: 'Gerente',
  comprador: 'Comprador',
  secretaria: 'Secretaria',
  aplicador: 'Aplicador',
  tecnico: 'Técnico',
  outro: 'Outro',
};
