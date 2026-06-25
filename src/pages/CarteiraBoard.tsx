import { useMemo } from 'react';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useCarteiraSla } from '@/hooks/useCarteiraSla';
import { montarColunasBoard } from '@/lib/carteira/board';
import { BoardCarteira } from '@/components/farmer/BoardCarteira';
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function CarteiraBoard() {
  const { agenda, clientScores, loading } = useFarmerScoring();
  const { data: slaRows, isLoading: slaLoading } = useCarteiraSla();
  const colunas = useMemo(
    () => montarColunasBoard(agenda, clientScores, slaRows ?? []),
    [agenda, clientScores, slaRows],
  );
  if (loading || slaLoading) return <PageSkeleton variant="cockpit" />;
  return (
    <div className="min-h-screen bg-background">
      <main className="px-4 py-4 space-y-4 max-w-6xl mx-auto">
        <h1 className="font-display text-xl">Board da carteira</h1>
        <BoardCarteira colunas={colunas} />
      </main>
    </div>
  );
}
