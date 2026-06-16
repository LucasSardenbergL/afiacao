// src/pages/FinanceiroProximaAcao.tsx
import { useAuth } from '@/contexts/AuthContext';
import { useProximaAcao } from '@/hooks/useProximaAcao';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type { AcaoFila, StatusAcaoFila } from '@/services/financeiroService';

const brl = (x: number | null | undefined) =>
  x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const GRUPOS: { status: StatusAcaoFila; titulo: string; classe: string }[] = [
  { status: 'consertar_antes', titulo: 'Consertar antes (preço/prazo/caixa — faça primeiro)', classe: 'text-status-warning' },
  { status: 'financiar_ja', titulo: 'Financiar já', classe: 'text-status-success' },
  { status: 'financiar_condicional', titulo: 'Financiar condicional (sem caixa hoje)', classe: 'text-status-info' },
  { status: 'falta_dado', titulo: 'Falta dado (definir ação / hurdle)', classe: 'text-muted-foreground' },
  { status: 'nao_financiar', titulo: 'Não financiar / benchmark', classe: 'text-status-error' },
];

export default function FinanceiroProximaAcao() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading, error } = useProximaAcao(podeVer);

  if (!podeVer) return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Acesso restrito — gestor comercial e master.
        </CardContent>
      </Card>
    </div>
  );
  if (isLoading) return <div className="p-6"><PageSkeleton variant="list" /></div>;
  if (error) return (
    <div className="p-6">
      <Card>
        <CardContent className="py-6 text-sm text-status-error">
          Erro: {error instanceof Error ? error.message : String(error)}
        </CardContent>
      </Card>
    </div>
  );
  if (!data) return null;

  const linha = (a: AcaoFila, i: number) => (
    <div key={i} className="flex justify-between gap-3 border-b border-border py-1 text-sm last:border-0">
      <span>{a.descricao}</span>
      <span className="font-mono whitespace-nowrap text-muted-foreground">
        {a.impacto_eva != null ? `EVA ${brl(a.impacto_eva)}/a` : ''}{a.caixa_consumido ? ` · caixa ${brl(a.caixa_consumido)}` : ''}
      </span>
    </div>
  );

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="font-display text-3xl">Próxima Melhor Ação</h1>
        <p className="text-sm text-muted-foreground">
          O que aprovar a seguir — e o que recusar — sob a restrição de caixa de cada empresa.
        </p>
      </div>
      {GRUPOS.map((g) => {
        const acoes = data.fila.filter((a) => a.status === g.status);
        if (acoes.length === 0) return null;
        return (
          <Card key={g.status}>
            <CardHeader>
              <CardTitle className={`text-base ${g.classe}`}>{g.titulo}</CardTitle>
            </CardHeader>
            <CardContent>{acoes.map(linha)}</CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Caixa disponível por empresa</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {Object.entries(data.caixa_por_empresa).map(([emp, c]) => (
            <div key={emp} className="flex justify-between border-b border-border py-1 last:border-0">
              <span>{emp}</span>
              <span className="font-mono">
                {brl(c.disponivel)}{' '}
                <span className="text-muted-foreground">({c.confianca})</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      {data.confianca.motivos.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>Confiança: {data.confianca.nivel}</summary>
          <ul className="list-disc pl-4 mt-1">
            {data.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        Caixa não é fungível entre as 3 empresas. Direcional; compõe A1 (caixa) + A2 (hurdle) + A3 (cockpit Oben).
      </p>
    </div>
  );
}
