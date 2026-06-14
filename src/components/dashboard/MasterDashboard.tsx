import { Link } from 'react-router-dom';
import { Target, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { TeamKpiTiles } from './TeamKpiTiles';
import { RankingVendedoresCard } from './RankingVendedoresCard';
import { GestorExcecoes } from './GestorExcecoes';
import { ClosersMtdHero } from './ClosersMtdHero';
import { DadosVendaParciaisBanner } from './DadosVendaParciaisBanner';
import { ViewAsPicker } from '@/components/impersonation/ViewAsPicker';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { AtivarNotificacoesCard } from '@/components/push/AtivarNotificacoesCard';

/**
 * Dashboard Master (CEO) — lidera com a VISÃO DE TIME e a GESTÃO POR EXCEÇÃO (o
 * trabalho diário do founder), depois ranking (decomposição do placar), a
 * ferramenta "Ver como", e por fim a operação PRÓPRIA do master-como-closer.
 *
 * Ordem validada com Codex (docs/superpowers/specs/2026-06-13-kpis-master-meu-dia-design.md):
 * "estamos ganhando? → o que exige ação? → quem/onde explica? → minha operação".
 * O VisitSuggestionsCard (sugestão de visita) saiu — é trabalho de closer, não
 * gestão. O KpisToday saiu de "como Closer" (mede LIGAÇÕES): "Minha operação" usa
 * ClosersMtdHero (visitas MTD), coerente com o papel.
 */
export function MasterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Master (CEO)</h1>
        <p className="text-xs text-muted-foreground">
          Visão consolidada do time, gestão por exceção e ranking. O escopo segue a empresa do seletor.
        </p>
      </div>

      {/* Receita/positivação vêm de sales_orders, hoje parcial (backfill pendente) → aviso honesto */}
      <DadosVendaParciaisBanner />

      {/* "Estamos ganhando?" — placar de time (receita MTD + trend, ativos) */}
      <TeamKpiTiles />

      {/* "O que exige ação?" — gestão por exceção (Buddy v2). Lidera por dependência com
          Dados quebrados, que invalidam o placar acima. */}
      <GestorExcecoes />

      {/* "Quem/onde explica?" — ranking de vendedores do mês (decomposição do placar) */}
      <RankingVendedoresCard />

      {/* Ferramenta de investigação: master entra na visão de um vendedor (somente leitura) */}
      <ViewAsPicker />

      {/* Tarefas do vendedor sendo visto via "Ver como" (somente leitura; some sem impersonação) */}
      <MinhasTarefasCard />

      {/* "Minha operação" — o master também é Closer (suas visitas do mês) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Minha operação</div>
        <ClosersMtdHero />
      </div>

      {/* Atalho discreto pra fila de caça (Frente B) — master acessa sem trocar de papel */}
      <Link to="/caca" className="block">
        <Card className="p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors">
          <Target className="w-4 h-4 text-status-info shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Caça</div>
            <div className="text-2xs text-muted-foreground">
              Clientes parecidos com seus melhores que ainda não compram
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </Card>
      </Link>

      {/* Opt-in de Web Push (config) — some quando ativo/negado/sem suporte/dispensado */}
      <AtivarNotificacoesCard />
    </div>
  );
}
