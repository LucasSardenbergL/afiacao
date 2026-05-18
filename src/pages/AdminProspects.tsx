import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Phone, Loader2, UserPlus, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { formatBrPhone } from '@/lib/phone';

interface ProspectRow {
  user_id: string;
  name: string | null;
  razao_social: string | null;
  phone: string | null;
  email: string | null;
  cnpj: string | null;
  prospect_source: string | null;
  prospect_origin_call_id: string | null;
  created_at: string;
}

const SOURCE_LABEL: Record<string, string> = {
  chamada_inbound: 'Chamada inbound',
  chamada_outbound: 'Chamada outbound',
  walk_in: 'Walk-in',
  manual: 'Cadastro manual',
  omie_import: 'Import Omie',
};

export default function AdminProspects() {
  const { data, isLoading } = useQuery({
    queryKey: ['prospects'],
    staleTime: 30_000,
    queryFn: async (): Promise<ProspectRow[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('profiles') as any)
        .select('user_id, name, razao_social, phone, email, cnpj, prospect_source, prospect_origin_call_id, created_at')
        .eq('is_prospect', true)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ProspectRow[];
    },
  });

  return (
    <div className="container mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">Prospects</h1>
          <p className="text-xs text-muted-foreground">
            Clientes cadastrados internamente (ainda sem acesso ao app). Vão pra ficha normal de cliente — toda funcionalidade disponível (processo, contatos, chamadas, comparação).
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          <UserPlus className="w-8 h-8 mx-auto mb-2 opacity-40" />
          Nenhum prospect cadastrado ainda. Quando chamadas de números desconhecidos chegarem, você pode cadastrar prospects em <span className="font-mono">/farmer/calls/pending-link</span>.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((p) => (
            <Link key={p.user_id} to={`/admin/customers/${p.user_id}`}>
              <Card className="p-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
                <Building2 className="w-5 h-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {p.razao_social || p.name || 'Sem razão social'}
                    </span>
                    <Badge variant="outline" className="text-2xs border-status-warning text-status-warning">
                      Prospect
                    </Badge>
                    {p.prospect_source && (
                      <Badge variant="outline" className="text-2xs">
                        {SOURCE_LABEL[p.prospect_source] ?? p.prospect_source}
                      </Badge>
                    )}
                  </div>
                  <div className="text-2xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
                    {p.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3" />
                        {formatBrPhone(p.phone)}
                      </span>
                    )}
                    {p.cnpj && <span>CNPJ {p.cnpj}</span>}
                    <span>
                      Cadastrado {formatDistanceToNow(new Date(p.created_at), { locale: ptBR, addSuffix: true })}
                    </span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
