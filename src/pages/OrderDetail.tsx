import { useParams, useNavigate } from 'react-router-dom';
import { Phone, MessageCircle, Copy, Check, RefreshCw, Star, Camera } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderTimeline } from '@/components/OrderTimeline';
import { StatusBadgeSimple } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { mockOrders } from '@/data/mockData';
import { TOOL_CATEGORIES, SERVICE_TYPES, DELIVERY_OPTIONS } from '@/types';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface QualityData {
  item_index: number;
  before_photos: string[];
  after_photos: string[];
  approved: boolean;
}

const OrderDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [qualityData, setQualityData] = useState<QualityData[]>([]);

  const order = mockOrders.find((o) => o.id === id);

  useEffect(() => {
    if (id) loadQualityData();
  }, [id]);

  const loadQualityData = async () => {
    if (!id) return;
    try {
      const { data } = await (supabase as any)
        .from('quality_checklists')
        .select('item_index, before_photos, after_photos, approved')
        .eq('order_id', id);
      if (data) setQualityData(data as QualityData[]);
    } catch (error) {
      console.error('Error loading quality data:', error);
    }
  };

  if (!order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Pedido não encontrado</p>
      </div>
    );
  }

  const copyOrderNumber = () => {
    navigator.clipboard.writeText(order.orderNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const needsApproval = order.status === 'orcamento_enviado' && !order.quoteApproved;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Detalhes do Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Order header */}
        <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display font-bold text-lg">{order.orderNumber}</h2>
                <button onClick={copyOrderNumber} className="p-1 hover:bg-muted rounded">
                  {copied ? (
                    <Check className="w-4 h-4 text-primary" />
                  ) : (
                    <Copy className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              </div>
              <p className="text-sm text-muted-foreground">
                Criado em {format(order.createdAt, "dd 'de' MMMM", { locale: ptBR })}
              </p>
            </div>
            <StatusBadgeSimple status={order.status} />
          </div>

          {order.estimatedDelivery && order.status !== 'entregue' && (
            <div className="bg-muted rounded-lg p-3">
              <p className="text-sm text-muted-foreground">Previsão de entrega</p>
              <p className="font-semibold">
                {format(order.estimatedDelivery, "dd 'de' MMMM", { locale: ptBR })}
              </p>
            </div>
          )}
        </div>

        {/* Approval needed banner */}
        {needsApproval && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
            <h3 className="font-semibold text-amber-800 mb-2">Orçamento aguardando aprovação</h3>
            <p className="text-sm text-amber-700 mb-3">
              Revise os itens e valores abaixo e aprove para iniciar a afiação.
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" size="sm">
                Aprovar Orçamento
              </Button>
              <Button variant="outline" size="sm">
                Recusar
              </Button>
            </div>
          </div>
        )}

        {/* Items */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Itens do Pedido</h3>
          <div className="space-y-3">
            {order.items.map((item) => (
              <div
                key={item.id}
                className="bg-card rounded-xl p-4 shadow-soft border border-border"
              >
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="font-semibold">{TOOL_CATEGORIES[item.category]}</h4>
                    {item.brandModel && (
                      <p className="text-sm text-muted-foreground">{item.brandModel}</p>
                    )}
                  </div>
                  <span className="text-sm font-semibold">
                    {item.quantity}x R$ {item.unitPrice?.toFixed(2).replace('.', ',')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="px-2 py-1 bg-muted rounded-full">
                    {SERVICE_TYPES[item.serviceType].label}
                  </span>
                  <span className="px-2 py-1 bg-muted rounded-full">
                    Desgaste: {item.wearLevel}
                  </span>
                </div>
                {item.notes && (
                  <p className="text-sm text-muted-foreground mt-2 italic">"{item.notes}"</p>
                )}

                {/* Before/After Photos from Quality Checklist */}
                {(() => {
                  const qd = qualityData.find(q => q.item_index === parseInt(item.id) - 1);
                  if (!qd || (qd.before_photos.length === 0 && qd.after_photos.length === 0)) return null;
                  return (
                    <div className="mt-3 pt-3 border-t border-border">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Camera className="w-3.5 h-3.5 text-primary" />
                        <span className="text-xs font-medium text-primary">Fotos do Serviço</span>
                        {qd.approved && (
                          <Badge variant="outline" className="text-xs ml-auto border-emerald-300 text-emerald-600">
                            ✓ Aprovado
                          </Badge>
                        )}
                      </div>
                      {qd.before_photos.length > 0 && (
                        <div className="mb-2">
                          <p className="text-xs text-muted-foreground mb-1">Antes:</p>
                          <div className="flex gap-2 overflow-x-auto">
                            {qd.before_photos.map((photo, pi) => (
                              <img key={pi} src={photo} alt="Antes" className="w-14 h-14 object-cover rounded-lg border" />
                            ))}
                          </div>
                        </div>
                      )}
                      {qd.after_photos.length > 0 && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Depois:</p>
                          <div className="flex gap-2 overflow-x-auto">
                            {qd.after_photos.map((photo, pi) => (
                              <img key={pi} src={photo} alt="Depois" className="w-14 h-14 object-cover rounded-lg border border-primary/30" />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </section>

        {/* Delivery info */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Entrega</h3>
          <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
            <p className="font-medium">{DELIVERY_OPTIONS[order.deliveryOption].label}</p>
            <p className="text-sm text-muted-foreground">
              {DELIVERY_OPTIONS[order.deliveryOption].description}
            </p>
            {order.timeSlot && (
              <p className="text-sm text-muted-foreground mt-1">
                Horário: {order.timeSlot.replace('-', ':00 - ')}:00
              </p>
            )}
          </div>
        </section>

        {/* Payment summary */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Resumo</h3>
          <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>R$ {order.subtotal.toFixed(2).replace('.', ',')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Taxa de entrega</span>
                <span>R$ {order.deliveryFee.toFixed(2).replace('.', ',')}</span>
              </div>
              {order.discount > 0 && (
                <div className="flex justify-between text-primary">
                  <span>Desconto</span>
                  <span>-R$ {order.discount.toFixed(2).replace('.', ',')}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 flex justify-between font-bold text-base">
                <span>Total</span>
                <span>R$ {order.total.toFixed(2).replace('.', ',')}</span>
              </div>
            </div>

            {order.paymentMethod && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Pagamento</span>
                  <span className="capitalize">
                    {order.paymentMethod === 'pix' ? 'Pix' : 
                     order.paymentMethod === 'card' ? 'Cartão' : 'Na entrega'}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <span className={order.paymentStatus === 'paid' ? 'text-emerald-600' : 'text-amber-600'}>
                    {order.paymentStatus === 'paid' ? 'Pago' : 'Pendente'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Timeline */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Acompanhamento</h3>
          <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
            <OrderTimeline statusHistory={order.statusHistory} currentStatus={order.status} />
          </div>
        </section>

        {/* Actions */}
        <section className="space-y-3">
          {order.status === 'entregue' && (
            <>
              <Button className="w-full" variant="outline" onClick={() => navigate('/new-order')}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Repetir Pedido
              </Button>
              <Button className="w-full" variant="muted">
                <Star className="w-4 h-4 mr-2" />
                Avaliar Serviço
              </Button>
            </>
          )}

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1">
              <Phone className="w-4 h-4 mr-2" />
              Ligar
            </Button>
            <Button variant="secondary" className="flex-1">
              <MessageCircle className="w-4 h-4 mr-2" />
              WhatsApp
            </Button>
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
};

export default OrderDetail;
