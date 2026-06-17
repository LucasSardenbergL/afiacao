import { Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGrupoComercial, tendenciaGrupo } from '@/queries/useGrupoComercial';
import { formatBRL } from '@/lib/grupos/format';

function fmtData(d: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}

const TONE_CLASS: Record<string, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  muted: 'text-muted-foreground',
};

function Metric({ label, valor }: { label: string; valor: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums">{valor}</p>
      </CardContent>
    </Card>
  );
}

export function GrupoComercialTab({ grupoId }: { grupoId: string }) {
  const { data, isLoading, error } = useGrupoComercial(grupoId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-status-error">Não consegui carregar o comercial: {error instanceof Error ? error.message : 'erro'}.</p>;
  }

  const c = data!;
  if (c.qtd_pedidos === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhuma compra registrada pros documentos deste grupo.
        </CardContent>
      </Card>
    );
  }

  const t = tendenciaGrupo(c);
  const TrendIcon = t.tone === 'error' ? TrendingDown : t.tone === 'success' ? TrendingUp : Minus;
  const pctTxt = t.pct == null ? '' : ` (${t.pct > 0 ? '+' : ''}${Math.round(t.pct * 100)}%)`;

  return (
    <div className="space-y-4">
      {/* Faturamento total + tendência */}
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-muted-foreground">Faturamento total (histórico)</p>
            <p className="mt-0.5 text-3xl font-bold tabular-nums">{formatBRL(c.faturamento_total)}</p>
          </div>
          <Badge variant="outline" className={`gap-1 ${TONE_CLASS[t.tone]}`}>
            <TrendIcon className="h-3.5 w-3.5" /> {t.label}{pctTxt}
          </Badge>
        </CardContent>
      </Card>

      {/* Janelas + média */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="Faturamento 90d" valor={formatBRL(c.fat_90d)} />
        <Metric label="90d anteriores" valor={formatBRL(c.fat_90d_anterior)} />
        <Metric label="Média mensal (6m)" valor={formatBRL(c.media_mensal_6m)} />
      </div>

      {/* Recência + volume */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="Última compra" valor={fmtData(c.ultima_compra)} />
        <Metric label="Dias desde a última" valor={c.dias_desde_ultima == null ? '—' : String(c.dias_desde_ultima)} />
        <Metric label="Pedidos · documentos" valor={`${c.qtd_pedidos} · ${c.documentos_com_compra}`} />
      </div>

      <p className="text-xs text-muted-foreground">
        Tendência por janela (90d vs 90d anterior) — não por intervalo médio, pra não esconder queda quando CNPJs do grupo se alternam.
        O mix ausente e o roteiro de recuperação vêm do plano da Farmer (skill farmer-industrial), que trata este grupo como um cliente só.
      </p>
    </div>
  );
}
