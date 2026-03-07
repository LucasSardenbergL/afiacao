import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { EMPLOYEE_ORDER_STATUS } from './types';
import type { Order, Profile } from './types';

interface Props {
  order: Order;
  profile: Profile | null;
}

export const OrderCustomerHeader = ({ order, profile }: Props) => {
  const statusInfo = EMPLOYEE_ORDER_STATUS[order.status as keyof typeof EMPLOYEE_ORDER_STATUS];

  return (
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
  );
};
