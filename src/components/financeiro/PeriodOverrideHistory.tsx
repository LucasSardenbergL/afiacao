import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';

type OverrideRow = {
  id: string;
  company: string;
  ano: number;
  mes: number;
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
  justificativa: string;
  acao_planejada: string;
};

export function PeriodOverrideHistory() {
  const { data, isLoading } = useQuery({
    queryKey: ['fin_period_overrides', 'history'],
    queryFn: async (): Promise<OverrideRow[]> => {
      // fin_period_overrides table type only exists after migration applied + types.ts regenerated.
      // Cast supabase to skip strict literal type check; runtime is safe because the table exists in DB.
      const { data, error } = await (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> })
        .from('fin_period_overrides')
        .select('*')
        .order('opened_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as OverrideRow[];
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlert className="h-4 w-4" /> Overrides recentes (30 dias)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Carregando…</div>}
        {!isLoading && data?.length === 0 && (
          <div className="text-sm text-muted-foreground">Nenhum override nos últimos 30 dias.</div>
        )}
        <ul className="space-y-3">
          {data?.map(o => {
            const isActive = !o.closed_at && new Date(o.expires_at) > new Date();
            return (
              <li key={o.id} className="rounded border p-2 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono">
                    {o.company} · {String(o.mes).padStart(2, '0')}/{o.ano}
                  </span>
                  <Badge variant={isActive ? 'destructive' : 'outline'}>
                    {isActive ? 'ativo' : 'expirado'}
                  </Badge>
                </div>
                <div className="text-muted-foreground tabular-nums">
                  {format(new Date(o.opened_at), 'dd/MM HH:mm')} → {format(new Date(o.expires_at), 'HH:mm')}
                </div>
                <div><strong>Por quê:</strong> {o.justificativa}</div>
                <div><strong>Ação:</strong> {o.acao_planejada}</div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
