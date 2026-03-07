import { Card, CardContent } from '@/components/ui/card';

interface Props {
  subtotal: number;
  deliveryFee: number;
  total: number;
}

export const OrderFinancialSummary = ({ subtotal, deliveryFee, total }: Props) => (
  <Card className="mb-6">
    <CardContent className="pt-4">
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>R$ {subtotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Taxa de entrega</span>
          <span>R$ {deliveryFee.toFixed(2)}</span>
        </div>
        <div className="border-t pt-2 flex justify-between font-bold text-base">
          <span>Total</span>
          <span>R$ {total.toFixed(2)}</span>
        </div>
      </div>
    </CardContent>
  </Card>
);
