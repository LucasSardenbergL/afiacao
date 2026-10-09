import { useMemo } from 'react';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useCarteiraSla } from '@/hooks/useCarteiraSla';
import { montarColunasBoard } from '@/lib/carteira/board';
import { BoardCarteira } from '@/components/farmer/BoardCarteira';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw, Loader2 } from 'lucide-react';

export default function CarteiraBoard() {
  const { agenda, clientScores, loading, erro, calculating, recalculate } = useFarmerScoring();
  const { data: slaRows, isLoading: slaLoading, isError: slaErro } = useCarteiraSla();
  const colunas = useMemo(
    () => montarColunasBoard(agenda, clientScores, slaRows ?? []),
    [agenda, clientScores, slaRows],
  );
  if (loading || slaLoading) return <PageSkeleton variant="cockpit" />;

  // §7 do money-path: falha SEM dado ≠ carteira vazia. Sem este corte, as três colunas saem
  // vazias e o BoardCarteira afirma "Nada aqui / Sem clientes nesta coluna" em cada uma — e o
  // `loading` já virou false (o `finally` do hook encerra), então nem skeleton sobra. A tela
  // diria, com cara de sucesso, que não há ninguém em risco. Com dado na mão (recálculo que
  // falhou depois de uma leitura boa), mantém o último estado bom e avisa que é de antes.
  const indisponivel = !!erro && clientScores.length === 0;
  const desatualizado = !!erro && clientScores.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <main className="px-4 py-4 space-y-4 max-w-6xl mx-auto">
        <h1 className="font-display text-xl">Board da carteira</h1>

        {indisponivel ? (
          <Card role="alert" className="p-6 space-y-3 border-status-error/30 bg-status-error/5">
            <p className="text-sm text-status-error">
              Board indisponível — a leitura da carteira falhou ({erro}). Nenhuma coluna foi
              avaliada; isto não significa carteira sem clientes.
            </p>
            <Button
              variant="outline" size="sm" onClick={recalculate}
              disabled={calculating} className="gap-1.5"
            >
              {calculating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Tentar novamente
            </Button>
          </Card>
        ) : (
          <>
            {desatualizado && (
              <div
                role="alert"
                className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning"
              >
                Exibindo a última leitura bem-sucedida — a atualização mais recente falhou
                ({erro}). As colunas podem estar desatualizadas.
              </div>
            )}

            {slaErro && (
              // `slaRows ?? []` apagava a falha da view: o board renderizava INTEIRO, com cara
              // de sucesso, e todo card vinha `slaVencido: false` — "ninguém atrasado"
              // fabricado. Mesmo anti-padrão do §7 (sinal zerado vindo de OUTRA query que a
              // tela não declara). Os cards continuam válidos; só a marca de atraso não.
              <div
                role="alert"
                className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning"
              >
                Marca de atraso (SLA) indisponível — a leitura da fila de contato falhou. Nenhum
                card foi marcado como atrasado por isso; não conclua que o SLA está em dia.
              </div>
            )}

            <BoardCarteira colunas={colunas} />
          </>
        )}
      </main>
    </div>
  );
}
