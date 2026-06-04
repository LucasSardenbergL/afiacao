import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { formatSlaWait } from '@/lib/whatsapp/sla-format';

export function SlaCardMeuDia() {
  const { user } = useAuth();
  const { data: rows = [] } = useWhatsappSla();
  const [escopo, setEscopo] = useState<'minhas' | 'todas'>('minhas');

  const visiveis = useMemo(() => {
    const base = escopo === 'minhas' ? rows.filter((r) => r.owner_user_id === user?.id) : rows;
    return [...base].sort((a, b) => b.minutos_uteis_aguardando - a.minutos_uteis_aguardando);
  }, [rows, escopo, user?.id]);

  const vermelhos = visiveis.filter((r) => r.nivel === 'vermelho').length;
  const pior = visiveis[0];
  if (rows.length === 0) return null;

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageCircle className={`w-4 h-4 ${vermelhos > 0 ? 'text-status-error' : 'text-status-warning'}`} />
          <h2 className="text-sm font-semibold">Clientes sem resposta no WhatsApp</h2>
        </div>
        <div className="flex rounded-md border text-2xs overflow-hidden">
          {(['minhas', 'todas'] as const).map((e) => (
            <button key={e} onClick={() => setEscopo(e)}
              className={`px-2 py-0.5 ${escopo === e ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
              {e === 'minhas' ? 'Minhas' : 'Todas'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {visiveis.length === 0
          ? 'Nenhum cliente esperando. 👌'
          : <>{visiveis.length} cliente(s) esperando{vermelhos > 0 ? ` · ${vermelhos} atrasado(s)` : ''}{pior ? ` · pior: ${formatSlaWait(pior.minutos_uteis_aguardando)}` : ''}.</>}
      </p>
      <Link to="/whatsapp" className="text-xs text-primary hover:underline">Abrir inbox →</Link>
    </Card>
  );
}
