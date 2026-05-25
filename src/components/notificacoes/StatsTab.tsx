// Aba de estatísticas (KPIs + gráfico de distribuição diária).
// Extraída verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { ChartDatum } from './types';

interface StatsTabProps {
  loading: boolean;
  total7d: number;
  taxaSucesso: number;
  esgotados: number;
  chartData: ChartDatum[];
}

export function StatsTab({ loading, total7d, taxaSucesso, esgotados, chartData }: StatsTabProps) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Total últimos 7 dias</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{total7d}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Taxa de sucesso</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{taxaSucesso}%</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Alertas esgotados (3 tentativas)</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{esgotados}</div>}
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
