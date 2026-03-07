import { MessageCircle, Phone, Mail, HelpCircle, ChevronRight, ExternalLink, Package, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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

const faqItems = [
  {
    question: 'Qual o prazo de afiação?',
    answer: 'O prazo padrão é de 24 a 72 horas úteis, dependendo do tipo de ferramenta e volume. Ferramentas de widea podem levar mais tempo pela complexidade do processo.',
  },
  {
    question: 'Quais ferramentas vocês afiam?',
    answer: 'Afiamos serras circulares (widea e HSS), fresas, facas de plaina, facas de desengrosso, cabeçotes desintegradores e tesouras profissionais para a indústria moveleira.',
  },
  {
    question: 'Como funciona a coleta e entrega?',
    answer: 'Nossa equipe busca as ferramentas no endereço cadastrado no turno agendado (manhã ou tarde) e devolve após a conclusão do serviço, sem custo adicional na região de atendimento.',
  },
  {
    question: 'Como funciona o orçamento?',
    answer: 'Após a triagem das ferramentas, enviamos o orçamento pelo app. Você pode aprovar ou recusar diretamente na tela do pedido. O serviço só começa após a aprovação.',
  },
  {
    question: 'Posso cancelar meu pedido?',
    answer: 'Sim, pedidos podem ser cancelados até a fase de triagem. Após o início da afiação, entre em contato pelo WhatsApp para avaliar alternativas.',
  },
];

function buildWhatsAppUrl(message: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

const Support = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Fetch most recent non-delivered order
  const { data: recentOrder } = useQuery({
    queryKey: ['support-recent-order', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, status, created_at')
        .eq('user_id', user!.id)
        .neq('status', 'entregue')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const openWhatsApp = (msg?: string) => {
    window.open(buildWhatsAppUrl(msg || 'Olá! Preciso de ajuda.'), '_blank', 'noopener,noreferrer');
  };

  const openPhone = () => { window.location.href = `tel:+${WHATSAPP_NUMBER}`; };
  const openEmail = () => { window.location.href = 'mailto:colacorcomercial@gmail.com?subject=Suporte%20Colacor'; };

  const orderNumber = recentOrder?.id?.slice(0, 8).toUpperCase();
  const statusLabel = recentOrder ? STATUS_LABELS[recentOrder.status] || recentOrder.status : '';

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Suporte" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">

        {/* ═══ RECENT ORDER CONTEXT ═══ */}
        {recentOrder && (
          <Card className="mb-6 border-primary/20 overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">Pedido em andamento</p>
                  <p className="font-semibold text-foreground text-sm">#{orderNumber}</p>
                  <Badge variant="outline" className="text-[10px] mt-1 border-primary/30 text-primary">
                    {statusLabel}
                  </Badge>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => openWhatsApp(`Olá! Gostaria de falar sobre meu pedido #${orderNumber}.\nStatus atual: ${statusLabel}`)}
                >
                  <MessageCircle className="w-4 h-4" />
                  Falar sobre este pedido
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => navigate(`/orders/${recentOrder.id}`)}
                >
                  Ver pedido
                  <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ═══ CONTACT OPTIONS ═══ */}
        <section className="mb-8">
          <h2 className="font-display font-bold text-lg mb-4">Fale Conosco</h2>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => openWhatsApp('Olá! Preciso de ajuda.')}
              className="bg-primary text-primary-foreground rounded-xl p-4 flex flex-col items-center gap-2 hover:bg-primary/90 transition-colors"
            >
              <MessageCircle className="w-6 h-6" />
              <span className="font-semibold text-sm">WhatsApp</span>
              <span className="text-xs opacity-80">(37) 3222-1035</span>
            </button>

            <button
              onClick={openPhone}
              className="bg-card rounded-xl p-4 flex flex-col items-center gap-2 border border-border hover:bg-muted transition-colors"
            >
              <Phone className="w-6 h-6 text-muted-foreground" />
              <span className="font-semibold text-sm">Ligar</span>
              <span className="text-xs text-muted-foreground">(37) 3222-1035</span>
            </button>
          </div>

          <button
            onClick={openEmail}
            className="w-full mt-3 bg-card rounded-xl p-4 flex items-center gap-3 border border-border hover:bg-muted transition-colors"
          >
            <Mail className="w-5 h-5 text-muted-foreground" />
            <div className="flex-1 text-left">
              <span className="font-medium block">Email</span>
              <span className="text-sm text-muted-foreground">colacorcomercial@gmail.com</span>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </button>
        </section>

        {/* ═══ FAQ ═══ */}
        <section className="mb-8">
          <h2 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
            <HelpCircle className="w-5 h-5" />
            Perguntas Frequentes
          </h2>

          <div className="space-y-3">
            {faqItems.map((item, index) => (
              <details
                key={index}
                className="bg-card rounded-xl border border-border overflow-hidden group"
              >
                <summary className="p-4 cursor-pointer font-medium flex items-center justify-between list-none">
                  {item.question}
                  <ChevronRight className="w-5 h-5 text-muted-foreground transition-transform group-open:rotate-90 flex-shrink-0" />
                </summary>
                <div className="px-4 pb-4 text-sm text-muted-foreground">
                  {item.answer}
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* ═══ OPEN TICKET ═══ */}
        <section>
          <div className="bg-muted rounded-xl p-6 text-center">
            <h3 className="font-semibold mb-2">Precisa de mais ajuda?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Envie sua dúvida pelo WhatsApp e nossa equipe responderá em até 24h
            </p>
            <Button
              className="gap-2"
              onClick={() => openWhatsApp('Olá, preciso de suporte técnico. Meu problema é: ')}
            >
              <MessageCircle className="w-4 h-4" />
              Abrir Chamado via WhatsApp
            </Button>
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
};

export default Support;
