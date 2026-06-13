import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { CacaConteudo } from '@/components/caca/CacaConteudo';
import { ChamadasPendentesNudge } from '@/components/farmer/ChamadasPendentesNudge';
import { PositivacaoHero } from '@/components/farmer/PositivacaoHero';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';

/**
 * Dashboard Hunter (aquisição) — Meu Dia do hunter.
 *
 * Lidera com o PLACAR DE AQUISIÇÃO (PositivacaoHero isHunter) — enxuto e honesto:
 * "Novos na carteira MTD" (proxy de aquisição), "Receita da carteira MTD" e
 * "Participação de novos". Os KPIs de retenção/penetração (recência, a-positivar,
 * cobertura) NÃO entram — são da farmer. A FILA DE CAÇA é a ação do dia (alvos
 * look-alike que ainda não compram); a página /caca mostra a mesma fila.
 *
 * VISITAS foram removidas (era VisitasHojeCard): visita é trabalho do CLOSER.
 * Ver docs/superpowers/specs/2026-06-13-kpis-hunter-meu-dia-design.md.
 */
export function HunterDashboard() {
  const { data: positivacao } = useMyPositivacao();

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia (aquisição)</h1>
        <p className="text-xs text-muted-foreground">
          Seu placar de aquisição e a fila de caça: clientes parecidos com os melhores que ainda não compram.
        </p>
      </div>

      {/* Placar de aquisição — o norte do hunter (proxy honesto, não-OTE ainda) */}
      {positivacao && <PositivacaoHero kpis={positivacao} isHunter={true} />}

      <MinhasTarefasCard />

      {/* nudge condicional: ligações registradas sem cliente vinculado (era item do menu Vendas) */}
      <ChamadasPendentesNudge />

      {/* Fila de caça — look-alike dos melhores que ainda não compram (Frente B) — a ação do dia */}
      <CacaConteudo />
    </div>
  );
}
