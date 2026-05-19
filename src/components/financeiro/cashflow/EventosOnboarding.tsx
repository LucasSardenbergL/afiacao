import { useCompany } from '@/contexts/CompanyContext';
import { useEventosRecorrentes, useCreateEventoRecorrente } from '@/hooks/useEventosRecorrentes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const SUGESTOES = [
  { descricao: 'Folha de pagamento', valor: 50000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: true, dia_do_mes: 5 },
  { descricao: 'Aluguel', valor: 8000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 10 },
  { descricao: 'Pró-labore sócios', valor: 30000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 5 },
  { descricao: 'Internet + Telefonia', valor: 1500, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 15 },
  { descricao: 'Software / SaaS', valor: 3000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 20 },
];

export function EventosOnboarding({ onDone }: { onDone?: () => void }) {
  const { activeCompany } = useCompany();
  const { data: existing } = useEventosRecorrentes(activeCompany);
  const create = useCreateEventoRecorrente();

  if (!existing || existing.filter(e => e.ativo).length >= 5) return null;

  const handleAdd = async (sug: typeof SUGESTOES[number]) => {
    try {
      await create.mutateAsync({
        company: activeCompany,
        ...sug,
        inicio: new Date().toISOString().slice(0, 10),
        fim: null,
        ativo: true,
        observacao: null,
      });
      toast.success(`Adicionado: ${sug.descricao} (ajuste o valor depois)`);
      onDone?.();
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4" /> Sugestões pra começar
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Adicione eventos típicos com 1 clique. Edite valor e dia depois.
        </p>
        <div className="flex flex-wrap gap-2">
          {SUGESTOES.map(s => (
            <Button key={s.descricao} size="sm" variant="outline" onClick={() => handleAdd(s)}>
              + {s.descricao}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
