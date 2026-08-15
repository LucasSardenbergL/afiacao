import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowAlertas, useAcaoAlerta, type AcaoAlerta, type Alerta } from '@/hooks/useCashflowAlertas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, AlertOctagon, Info, Check, Clock, X } from 'lucide-react';
import { toast } from 'sonner';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const SEVERIDADE_ICON: Record<Alerta['severidade'], typeof Info> = {
  info: Info,
  aviso: AlertTriangle,
  critico: AlertOctagon,
};

const SEVERIDADE_STYLE: Record<Alerta['severidade'], string> = {
  info: 'border-status-info bg-status-info-bg',
  aviso: 'border-status-warning bg-status-warning-bg',
  critico: 'border-status-error bg-status-error-bg',
};

function sonecaVigente(a: Alerta): boolean {
  return Boolean(a.dismissed_until && new Date(a.dismissed_until).getTime() > Date.now());
}

export function AlertasStack() {
  const { activeCompany } = useCompany();
  const { data, isLoading } = useCashflowAlertas(activeCompany);
  const acao = useAcaoAlerta();

  if (isLoading || !data || data.length === 0) return null;

  const agir = async (id: string, a: AcaoAlerta) => {
    try {
      await acao.mutateAsync({ id, acao: a });
      toast.success(
        a.tipo === 'silenciar'
          ? `Alerta silenciado por ${a.dias} dias`
          : a.tipo === 'encerrar'
            ? 'Alerta encerrado'
            : 'Alerta reconhecido',
      );
    } catch (err) {
      // mensagemDeErro devolve null em vez de "[object Object]": o erro do supabase-js é objeto
      // PLANO, não Error, então String(err) apagaria justamente a recusa da RPC/RLS.
      toast.error(mensagemDeErro(err) ?? 'Falha ao atualizar o alerta');
    }
  };

  return (
    <div className="space-y-2">
      {data.map(a => {
        const Icon = SEVERIDADE_ICON[a.severidade];
        const reconhecido = Boolean(a.acknowledged_at);
        const emSoneca = sonecaVigente(a);
        return (
          <Alert key={a.id} className={SEVERIDADE_STYLE[a.severidade]}>
            <Icon className="h-4 w-4" />
            <AlertTitle className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">{a.tipo}</Badge>
              {reconhecido && (
                <Badge variant="secondary" className="text-xs">reconhecido</Badge>
              )}
              {emSoneca && (
                <Badge variant="secondary" className="text-xs">
                  {`silenciado até ${new Date(a.dismissed_until!).toLocaleDateString('pt-BR')}`}
                </Badge>
              )}
            </AlertTitle>
            <AlertDescription className="flex items-start justify-between gap-3">
              <span>{a.mensagem}</span>
              <div className="flex gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={emSoneca || acao.isPending}
                  onClick={() => agir(a.id, { tipo: 'silenciar', dias: 7 })}
                  title="Silenciar os e-mails por 7 dias (o alerta continua aberto)"
                >
                  <Clock className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={reconhecido || acao.isPending}
                  onClick={() => agir(a.id, { tipo: 'reconhecer' })}
                  title="Reconhecer: para os lembretes, mas uma piora volta a avisar"
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={acao.isPending}
                  onClick={() => agir(a.id, { tipo: 'encerrar' })}
                  title="Encerrar: tira da lista. Se a condição persistir, o vigia reabre no próximo ciclo."
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
