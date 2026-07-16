// Card de entrada para a Central da Ferramenta e Serviços — a aposta central do
// app do cliente (afiação → serviço → recorrência → ROI). Fica em destaque no
// topo do CustomerDashboard.
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { LayoutGrid, ChevronRight } from 'lucide-react';

interface CentralEntryCardProps {
  navigate: ReturnType<typeof useNavigate>;
}

export function CentralEntryCard({ navigate }: CentralEntryCardProps) {
  return (
    <button
      onClick={() => navigate('/central')}
      className="w-full text-left"
      aria-label="Abrir a Central da Ferramenta e Serviços"
    >
      <Card className="border-primary/20 bg-primary/5 hover:bg-primary/10 hover:border-primary/30 transition-all">
        <CardContent className="p-4 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <LayoutGrid className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">Central da Ferramenta</p>
            <p className="text-sm text-muted-foreground">
              Economia, ferramentas, agendamentos e pedidos num só lugar
            </p>
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
        </CardContent>
      </Card>
    </button>
  );
}
