import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { VisitasHojeCard } from './VisitasHojeCard';
import { CacaConteudo } from '@/components/caca/CacaConteudo';

/**
 * Dashboard Hunter (inbound) — Meu Dia do hunter.
 *
 * Lidera com tarefas + visitas do dia e a FILA DE CAÇA (clientes parecidos com
 * os melhores que ainda não compram). A caça vive aqui pro hunter trabalhar a
 * fila sem trocar de tela; a página dedicada `/caca` mostra a mesma fila.
 */
export function HunterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Hunter (inbound)</h1>
        <p className="text-xs text-muted-foreground">
          Foco em chamadas que chegam de clientes novos e qualificação rápida pra entregar pro Closer ou fechar direto.
        </p>
      </div>

      <MinhasTarefasCard />

      <VisitasHojeCard />

      {/* Fila de caça — look-alike dos melhores que ainda não compram (Frente B) */}
      <CacaConteudo />
    </div>
  );
}
