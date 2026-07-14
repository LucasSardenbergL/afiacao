import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useSavingsSummary } from '@/queries/useSavings';
import { AVG_NEW_TOOL_COST } from '@/lib/afiacao/savings';
import { TrendingUp, DollarSign, Wrench, Leaf, PiggyBank } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, LineChart, Line } from 'recharts';

const SavingsDashboard = () => {
  const { user } = useAuth();
  const { summary, isPending: loading } = useSavingsSummary(user?.id);
  const { monthlyData, totalTools, totalSpent, totalSavings, savingsPercent } = summary;

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <main className="pt-16 px-4 max-w-lg mx-auto">
          <PageSkeleton variant="cockpit" />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Hero savings card */}
        <Card className="mb-4 bg-gradient-to-br from-emerald-500 to-emerald-700 text-white border-0">
          <CardContent className="p-6 text-center">
            <PiggyBank className="w-10 h-10 mx-auto mb-2 opacity-80" />
            <p className="text-sm opacity-80">Economia total estimada</p>
            <p className="text-4xl font-bold mt-1">
              R$ {totalSavings > 0 ? totalSavings.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '0'}
            </p>
            {savingsPercent > 0 && (
              <p className="text-sm mt-2 opacity-90">
                Você economizou ~{savingsPercent}% em relação a comprar ferramentas novas
              </p>
            )}
            <p className="text-xs mt-2 opacity-60">
              * Estimativa baseada no custo médio de reposição de ferramentas novas (R$ {AVG_NEW_TOOL_COST}). Valores de afiação são reais dos seus pedidos.
            </p>
          </CardContent>
        </Card>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="w-5 h-5 text-primary mx-auto mb-1" />
              <p className="text-lg font-bold">R$ {totalSpent.toFixed(0)}</p>
              <p className="text-xs text-muted-foreground">Investido</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Wrench className="w-5 h-5 text-primary mx-auto mb-1" />
              <p className="text-lg font-bold">{totalTools}</p>
              <p className="text-xs text-muted-foreground">Afiações</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Leaf className="w-5 h-5 text-status-success mx-auto mb-1" />
              <p className="text-lg font-bold">{totalTools}</p>
              <p className="text-xs text-muted-foreground">Ferramentas salvas</p>
            </CardContent>
          </Card>
        </div>

        {/* Comparison chart */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Afiação vs Comprar Nova
            </CardTitle>
            <p className="text-xs text-muted-foreground">Últimos 6 meses</p>
          </CardHeader>
          <CardContent>
            {monthlyData.some(d => d.toolCount > 0) ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={monthlyData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={v => `R$${v}`} />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `R$ ${value.toFixed(2)}`,
                      name === 'sharpeningCost' ? 'Afiação' : 'Ferramenta nova',
                    ]}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Bar dataKey="sharpeningCost" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="sharpeningCost" />
                  <Bar dataKey="newToolCost" fill="hsl(var(--muted-foreground) / 0.3)" radius={[4, 4, 0, 0]} name="newToolCost" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">Sem dados suficientes ainda</p>
                <p className="text-xs text-muted-foreground/70">Os gráficos aparecerão quando você tiver pedidos concluídos</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Savings over time */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <PiggyBank className="w-4 h-4" />
              Economia Acumulada
            </CardTitle>
          </CardHeader>
          <CardContent>
            {monthlyData.some(d => d.savings > 0) ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={v => `R$${v}`} />
                  <Tooltip
                    formatter={(value: number) => [`R$ ${value.toFixed(2)}`, 'Economia']}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Line type="monotone" dataKey="savings" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981' }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">Dados serão exibidos com pedidos concluídos</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Eco impact */}
        <Card className="bg-status-success-bg border-status-success/40">
          <CardContent className="p-4 flex gap-3">
            <Leaf className="w-5 h-5 text-status-success flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-status-success-foreground">Impacto Ambiental</p>
              <p className="text-xs text-status-success-foreground">
                Ao afiar {totalTools} ferramenta{totalTools !== 1 ? 's' : ''} ao invés de descartá-la{totalTools !== 1 ? 's' : ''}, 
                você evitou {(totalTools * 0.5).toFixed(1)} kg de resíduos metálicos.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>

    </div>
  );
};

export default SavingsDashboard;
