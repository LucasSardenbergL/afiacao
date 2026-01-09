import { MessageCircle, Phone, Mail, HelpCircle, ChevronRight, ExternalLink } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';

const faqItems = [
  {
    question: 'Quanto tempo demora a afiação?',
    answer: 'O prazo padrão é de 24 a 72 horas, dependendo do tipo de ferramenta e serviço escolhido.',
  },
  {
    question: 'Vocês afiam qualquer tipo de faca?',
    answer: 'Sim! Afiamos facas de cozinha, chef, serrilhadas, japonesas, alemãs e outras.',
  },
  {
    question: 'Como funciona a coleta?',
    answer: 'Nosso motoboy busca as ferramentas no endereço escolhido, no horário agendado.',
  },
  {
    question: 'Posso cancelar meu pedido?',
    answer: 'Sim, até a fase de triagem. Após isso, consulte nosso suporte.',
  },
];

const Support = () => {
  const openWhatsApp = () => {
    window.open('https://wa.me/5511999999999?text=Olá! Preciso de ajuda com meu pedido.', '_blank');
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
              className="bg-emerald-500 text-white rounded-xl p-4 flex flex-col items-center gap-2 hover:bg-emerald-600 transition-colors"
            >
              <MessageCircle className="w-6 h-6" />
              <span className="font-semibold text-sm">WhatsApp</span>
            </button>

            <button className="bg-card rounded-xl p-4 flex flex-col items-center gap-2 border border-border hover:bg-muted transition-colors">
              <Phone className="w-6 h-6 text-muted-foreground" />
              <span className="font-semibold text-sm">Ligar</span>
            </button>
          </div>

          <button className="w-full mt-3 bg-card rounded-xl p-4 flex items-center gap-3 border border-border hover:bg-muted transition-colors">
            <Mail className="w-5 h-5 text-muted-foreground" />
            <div className="flex-1 text-left">
              <span className="font-medium block">Email</span>
              <span className="text-sm text-muted-foreground">contato@afiacaoexpress.com.br</span>
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
            <Button>
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
