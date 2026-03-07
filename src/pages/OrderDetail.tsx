import { useParams, useNavigate } from 'react-router-dom';
import { Phone, MessageCircle, Copy, Check, RefreshCw, Camera, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';
import { useState, useEffect } from 'react';
import { OrderStatus } from '@/types';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderTimeline } from '@/components/OrderTimeline';
import { OrderChat } from '@/components/OrderChat';
import { OrderReview } from '@/components/OrderReview';
import { StatusBadgeSimple } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { TOOL_CATEGORIES, SERVICE_TYPES, DELIVERY_OPTIONS } from '@/types';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

const WHATSAPP_NUMBER = '553732221035';

const STATUS_LABELS: Record<string, string> = {
  pedido_recebido: 'Recebido',
  aguardando_coleta: 'Aguardando Coleta',
  em_triagem: 'Em Triagem',
  orcamento_enviado: 'Orçamento Enviado',
  aprovado: 'Aprovado',
  em_afiacao: 'Em Afiação',
  controle_qualidade: 'Controle de Qualidade',
  pronto_entrega: 'Pronto para Entrega',
  em_rota: 'Em Rota',
  entregue: 'Entregue',
};

interface QualityData {
  item_index: number;
  before_photos: string[];
  after_photos: string[];
  approved: boolean;
}

function buildWhatsAppUrl(orderNumber: string, status: string) {
  const statusText = STATUS_LABELS[status] || status;
  const msg = encodeURIComponent(
    `Olá! Gostaria de falar sobre meu pedido #${orderNumber}.\nStatus atual: ${statusText}`
  );
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
}

const OrderDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [qualityData, setQualityData] = useState<QualityData[]>([]);

  const { data: order, isLoading } = useQuery({
    queryKey: ['order-detail', id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: data.id,
        orderNumber: data.id.slice(0, 8).toUpperCase(),
        userId: data.user_id,
        items: (data.items as any[]) || [],
        status: data.status as string,
        deliveryOption: data.delivery_option,
        timeSlot: data.time_slot,
        subtotal: data.subtotal,
        deliveryFee: data.delivery_fee,
        discount: 0,
        total: data.total,
        paymentMethod: undefined as string | undefined,
        paymentStatus: 'pending' as string,
        quoteApproved: !['orcamento_enviado'].includes(data.status),
        estimatedDelivery: undefined as Date | undefined,
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at),
        statusHistory: [] as Array<{ status: string; timestamp: Date; note?: string; operator?: string }>,
        notes: data.notes,
        address: data.address,
      };
    },
    enabled: !!id,
  });

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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

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

  const needsApproval = order.status === 'orcamento_enviado';
  const isDelivered = order.status === 'entregue';
  const whatsAppUrl = buildWhatsAppUrl(order.orderNumber, order.status);

  // Collect all quality photos for the "Resultado do Serviço" section
  const allQualityPhotos = qualityData.filter(
    qd => qd.before_photos.length > 0 || qd.after_photos.length > 0
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Detalhes do Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Order header */}
        <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display font-bold text-lg">#{order.orderNumber}</h2>
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
            <StatusBadgeSimple status={order.status as OrderStatus} />
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

        {/* ═══ QUOTE APPROVAL CARD ═══ */}
        {needsApproval && (
          <Card className="mb-4 border-status-warning/50 ring-1 ring-status-warning/20 overflow-hidden">
            <CardContent className="p-0">
              <div className="bg-status-warning-bg/60 px-4 py-3 border-b border-status-warning/20 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-status-warning" />
                <h3 className="font-display font-bold text-foreground">Orçamento aguardando aprovação</h3>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Revise os itens e valores abaixo e aprove para iniciar a afiação das suas ferramentas.
                </p>
                <div className="bg-muted rounded-xl p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Valor total</p>
                  <p className="text-3xl font-bold text-foreground">
                    R$ {order.total.toFixed(2).replace('.', ',')}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button className="flex-1" size="sm">
                    Aprovar Orçamento
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => window.open(whatsAppUrl, '_blank')}
                  >
                    <MessageCircle className="w-4 h-4 mr-1.5" />
                    Falar com suporte
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Items */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Itens do Pedido</h3>
          <div className="space-y-3">
            {order.items.map((item: any, idx: number) => (
              <div
                key={item.id || idx}
                className="bg-card rounded-xl p-4 shadow-soft border border-border"
              >
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="font-semibold">{TOOL_CATEGORIES[item.category as keyof typeof TOOL_CATEGORIES] || item.category}</h4>
                    {item.brandModel && (
                      <p className="text-sm text-muted-foreground">{item.brandModel}</p>
                    )}
                  </div>
                  <span className="text-sm font-semibold">
                    {item.quantity}x R$ {item.unitPrice?.toFixed(2).replace('.', ',')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {item.serviceType && SERVICE_TYPES[item.serviceType as keyof typeof SERVICE_TYPES] && (
                    <span className="px-2 py-1 bg-muted rounded-full">
                      {SERVICE_TYPES[item.serviceType as keyof typeof SERVICE_TYPES].label}
                    </span>
                  )}
                  {item.wearLevel && (
                    <span className="px-2 py-1 bg-muted rounded-full">
                      Desgaste: {item.wearLevel}
                    </span>
                  )}
                </div>
                {item.notes && (
                  <p className="text-sm text-muted-foreground mt-2 italic">"{item.notes}"</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ═══ QUALITY PHOTOS — Resultado do Serviço ═══ */}
        {allQualityPhotos.length > 0 && (
          <section className="mb-6">
            <h3 className="font-display font-bold mb-3">Resultado do Serviço</h3>
            <div className="space-y-3">
              {allQualityPhotos.map((qd, qi) => (
                <Card key={qi} className="overflow-hidden">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Camera className="w-4 h-4 text-primary" />
                      <span className="text-sm font-semibold text-foreground">
                        {order.items[qd.item_index]
                          ? TOOL_CATEGORIES[order.items[qd.item_index].category as keyof typeof TOOL_CATEGORIES] || order.items[qd.item_index].category
                          : `Item ${qd.item_index + 1}`}
                      </span>
                      {qd.approved && (
                        <Badge variant="outline" className="text-[10px] ml-auto border-emerald-400 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-300">
                          ✓ Qualidade aprovada
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {/* Before */}
                      {qd.before_photos.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1.5">Antes</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {qd.before_photos.map((photo, pi) => (
                              <img
                                key={pi}
                                src={photo}
                                alt="Antes do serviço"
                                className="w-full aspect-square object-cover rounded-lg border border-border"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {/* After */}
                      {qd.after_photos.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-primary mb-1.5">Depois</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {qd.after_photos.map((photo, pi) => (
                              <img
                                key={pi}
                                src={photo}
                                alt="Depois do serviço"
                                className="w-full aspect-square object-cover rounded-lg border-2 border-primary/30"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Delivery info */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Entrega</h3>
          <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
            <p className="font-medium">{DELIVERY_OPTIONS[order.deliveryOption as keyof typeof DELIVERY_OPTIONS]?.label || order.deliveryOption}</p>
            <p className="text-sm text-muted-foreground">
              {DELIVERY_OPTIONS[order.deliveryOption as keyof typeof DELIVERY_OPTIONS]?.description}
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
                  <span className={order.paymentStatus === 'paid' ? 'text-emerald-600' : 'text-status-warning'}>
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
            <OrderTimeline statusHistory={order.statusHistory as any} currentStatus={order.status as OrderStatus} />
          </div>
        </section>

        {/* Chat */}
        <section className="mb-6">
          <h3 className="font-display font-bold mb-3">Mensagens</h3>
          <div className="bg-card rounded-xl p-4 shadow-soft border border-border">
            <OrderChat orderId={order.id} />
          </div>
        </section>

        {/* Actions */}
        <section className="space-y-3">
          {/* Reorder */}
          {isDelivered && (
            <>
              <Button className="w-full gap-2" onClick={() => navigate('/new-order')}>
                <RefreshCw className="w-4 h-4" />
                Pedir Novamente
              </Button>
              <OrderReview orderId={order.id} />
            </>
          )}

          {/* Contextual WhatsApp support */}
          <Button
            variant="secondary"
            className="w-full gap-2"
            onClick={() => window.open(whatsAppUrl, '_blank')}
          >
            <MessageCircle className="w-4 h-4" />
            Falar sobre este pedido
            <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
          </Button>

          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={() => window.open(`tel:+${WHATSAPP_NUMBER}`, '_self')}
          >
            <Phone className="w-4 h-4" />
            Ligar para suporte
          </Button>
        </section>
      </main>

      <BottomNav />
    </div>
  );
};

export default OrderDetail;
