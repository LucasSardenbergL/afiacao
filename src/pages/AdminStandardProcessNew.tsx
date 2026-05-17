import { useNavigate } from 'react-router-dom';
import { StandardProcessForm } from '@/components/standard-process/StandardProcessForm';
import { Button } from '@/components/ui/button';
import { ChevronLeft } from 'lucide-react';

export default function AdminStandardProcessNew() {
  const navigate = useNavigate();

  return (
    <div className="container mx-auto p-4 space-y-3 max-w-3xl">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/standard-processes')} className="gap-1">
          <ChevronLeft className="w-3.5 h-3.5" />
          Voltar
        </Button>
      </div>
      <div>
        <h1 className="text-xl font-semibold">Novo processo padrão</h1>
        <p className="text-xs text-muted-foreground">
          Preencha as etapas que compõem esse processo modelo. Quanto mais detalhe, melhor a comparação contra processos de clientes (PR-P3).
        </p>
      </div>
      <StandardProcessForm onSaved={() => navigate('/admin/standard-processes')} />
    </div>
  );
}
