// Ícones, rótulos e badges de confiança do AI Ops.
// Extraídos verbatim de src/pages/AIops.tsx (god-component split).
import { Phone, MapPin, MessageSquare } from 'lucide-react';

export const actionIcons: Record<string, React.ElementType> = {
  ligar: Phone,
  visitar: MapPin,
  mensagem: MessageSquare,
};

export const actionLabels: Record<string, string> = {
  ligar: 'Ligar',
  visitar: 'Visitar',
  mensagem: 'Enviar mensagem',
};

export const confidenceBadge: Record<string, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  alta: { variant: 'default', label: 'Alta' },
  media: { variant: 'secondary', label: 'Média' },
  baixa: { variant: 'outline', label: 'Baixa' },
};
