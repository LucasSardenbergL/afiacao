// Aba de estatísticas (KPIs + gráfico de distribuição diária).
// Extraída verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { ChartDatum } from './types';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import type { EstadoSemLeitura } from '@/lib/leitura/estado-de-leitura';

interface StatsTabProps {
  loading: boolean;
  /** `null` = não sei (leitura falhou, ou não há base para a taxa) → "—", nunca 0. */
  total7d: number | null;
  taxaSucesso: number | null;
  esgotados: number | null;
  chartData: ChartDatum[];
  /** A leitura das estatísticas falhou (plano v8, C14): aviso no lugar de KPIs zerados. */
  semLeitura?: EstadoSemLeitura | null;
}

const fmt = (v: number | null, sufixo = '') => (v == null ? '—' : `${v}${sufixo}`);

export function StatsTab({ loading, total7d, taxaSucesso, esgotados, chartData, semLeitura }: StatsTabProps) {
  return (
    <>
      {semLeitura && (
        <AvisoLeituraFalhou
          oque="as estatísticas de notificação"
          estado={semLeitura}
          variante="bloco"
          testId="stats-notificacoes-sem-leitura"
        />
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Total últimos 7 dias</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{fmt(total7d)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Taxa de sucesso</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{fmt(taxaSucesso, '%')}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Alertas esgotados (3 tentativas)</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{fmt(esgotados)}</div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Distribuição diária (30 dias)</CardTitle></CardHeader>
        <CardContent style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="notificado" stackId="a" fill="hsl(142 71% 45%)" name="notificado" />
              <Bar dataKey="pendente" stackId="a" fill="hsl(45 93% 47%)" name="pendente" />
              <Bar dataKey="falha" stackId="a" fill="hsl(0 84% 60%)" name="falha" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </>
  );
}
