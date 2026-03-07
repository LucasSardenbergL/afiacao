import { MessageCircle, Phone, Mail, HelpCircle, ChevronRight, ExternalLink } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';

const faqItems = [
  {
    question: 'Quanto tempo demora a afiação?',
    answer: 'O prazo padrão é de 24 a 72 horas úteis, dependendo do tipo de ferramenta e volume do pedido.',
  },
  {
    question: 'Vocês afiam qualquer tipo de ferramenta?',
    answer: 'Afiamos serras circulares (widea e HSS), fresas, facas de plaina, facas de desengrosso, cabeçotes desintegradores e tesouras profissionais para a indústria moveleira.',
  },
  {
    question: 'Como funciona a coleta?',
    answer: 'Nossa equipe busca as ferramentas no endereço cadastrado, no turno agendado (manhã ou tarde).',
  },
  {
    question: 'Posso cancelar meu pedido?',
    answer: 'Sim, pedidos podem ser cancelados até a fase de triagem. Após o início da afiação, entre em contato pelo WhatsApp.',
  },
];

const Support = () => {
  const openWhatsApp = () => {
    // Opens WhatsApp app directly with pre-filled message
    const message = encodeURIComponent('Olá! Preciso de ajuda com meu pedido.');
    const whatsappUrl = `https://wa.me/5537999991035?text=${message}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
  };

  const openPhone = () => {
    // Opens phone dialer with number
    window.location.href = 'tel:+553732221035';
  };

  const openEmail = () => {
    // Opens email client
    window.location.href = 'mailto:colacorcomercial@gmail.com?subject=Suporte%20Colacor';
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Suporte" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Contact options */}
        <section className="mb-8">
          <h2 className="font-display font-bold text-lg mb-4">Fale Conosco</h2>
          
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={openWhatsApp}
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

        {/* FAQ */}
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
                  <ChevronRight className="w-5 h-5 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <div className="px-4 pb-4 text-sm text-muted-foreground">
                  {item.answer}
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* Open ticket */}
        <section>
          <div className="bg-muted rounded-xl p-6 text-center">
            <h3 className="font-semibold mb-2">Precisa de mais ajuda?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Abra um chamado e nossa equipe responderá em até 24h
            </p>
            <Button onClick={() => {
              const message = encodeURIComponent('Olá, preciso de suporte técnico. Meu problema é: ');
              window.open(`https://wa.me/5537999991035?text=${message}`, '_blank', 'noopener,noreferrer');
            }}>
              Abrir Chamado
            </Button>
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
};

export default Support;
