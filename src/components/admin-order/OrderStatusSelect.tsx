import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EMPLOYEE_ORDER_STATUS } from './types';

interface Props {
  selectedStatus: string;
  onStatusChange: (status: string) => void;
}

export const OrderStatusSelect = ({ selectedStatus, onStatusChange }: Props) => (
  <Card className="mb-4">
    <CardHeader className="pb-2">
      <CardTitle className="text-base">Alterar Status</CardTitle>
    </CardHeader>
    <CardContent>
      <Select value={selectedStatus} onValueChange={onStatusChange}>
        <SelectTrigger>
          <SelectValue placeholder="Selecione o status" />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(EMPLOYEE_ORDER_STATUS).map(([key, { label }]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </CardContent>
  </Card>
);
