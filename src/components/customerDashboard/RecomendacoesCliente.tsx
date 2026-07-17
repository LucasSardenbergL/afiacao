// Seção "Recomendações para você" do CustomerDashboard (PR2 do benchmark #13).
// Consultoria em produto via dados: cards DETERMINÍSTICOS derivados de Tools + Savings.
// Toda a lógica (e a degradação honesta money-path) vive no helper puro testado
// src/lib/afiacao/recomendacoes.ts — aqui é só apresentação.
import { useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Clock, CalendarClock, PiggyBank, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useDeliveredOrders12m } from '@/queries/useOrders';
import { track } from '@/lib/analytics';
import { gerarRecomendacoes, filtrarRecomendacoes, resumirEconomia, type ToolInput, type Recomendacao } from '@/lib/afiacao/recomendacoes';
import type { UserTool } from './types';

interface RecomendacoesClienteProps {
  userTools: UserTool[];
  navigate: ReturnType<typeof useNavigate>;
  /** Tipos a NÃO exibir nesta tela. Ex.: a Central oculta 'economia' — já tem o herói. */
  ocultarTipos?: Recomendacao['tipo'][];
}

const brl = (v: number) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;

function nomesResumidos(ferramentas: { nome: string }[]): string {
  const nomes = ferramentas.slice(0, 3).map((f) => f.nome);
  const resto = ferramentas.length - nomes.length;
  return resto > 0 ? `${nomes.join(', ')} +${resto}` : nomes.join(', ');
}

export function RecomendacoesCliente({ userTools, navigate, ocultarTipos }: RecomendacoesClienteProps) {
  const { user } = useAuth();
  const { data: orders = [] } = useDeliveredOrders12m(user?.id);

  const recomendacoes = useMemo(() => {
    const tools: ToolInput[] = userTools.map((t) => ({
      id: t.id,
      nome: t.tool_categories?.name ?? 'Ferramenta',
      next_sharpening_due: t.next_sharpening_due,
      last_sharpened_at: t.last_sharpened_at,
      sharpening_interval_days: t.sharpening_interval_days,
      suggested_interval_days: t.tool_categories?.suggested_interval_days ?? null,
    }));
    const geradas = gerarRecomendacoes({ tools, economia: resumirEconomia(orders) });
    return filtrarRecomendacoes(geradas, ocultarTipos ?? []);
  }, [userTools, orders, ocultarTipos]);

  if (recomendacoes.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-lg text-foreground">Recomendações para você</h2>
      </div>
      <div className="space-y-3">
        {recomendacoes.map((rec) => (
          <RecomendacaoCard key={rec.tipo} rec={rec} navigate={navigate} />
        ))}
      </div>
    </motion.section>
  );
}

function RecomendacaoCard({
  rec,
  navigate,
}: {
  rec: Recomendacao;
  navigate: ReturnType<typeof useNavigate>;
}) {
  if (rec.tipo === 'economia') {
    return (
      <CardBase
        icon={<PiggyBank className="w-5 h-5 text-status-success" />}
        iconBg="bg-status-success-bg"
        titulo={`Você já economizou ~${brl(rec.economiaComprovada)} afiando em vez de comprar`}
        descricao={
          rec.economiaPotencial != null
            ? `Afiar as ${rec.nAtrasadas} ferramenta(s) atrasada(s), em vez de trocar, pode render mais ~${brl(rec.economiaPotencial)}. Estimativa com base no custo médio de uma ferramenta nova.`
            : 'Estimativa com base no custo médio de uma ferramenta nova; os valores de afiação são reais dos seus pedidos.'
        }
        ctaLabel="Ver economia"
        onClick={() => {
          track('recomendacoes.cta', { tipo: rec.tipo });
          navigate('/savings');
        }}
      />
    );
  }

  if (rec.tipo === 'possivelmente_atrasada') {
    const n = rec.ferramentas.length;
    return (
      <CardBase
        icon={<Clock className="w-5 h-5 text-status-warning" />}
        iconBg="bg-status-warning-bg"
        titulo={
          n === 1
            ? '1 ferramenta pode estar passando do ponto de afiação'
            : `${n} ferramentas podem estar passando do ponto de afiação`
        }
        descricao={`${nomesResumidos(rec.ferramentas)} — pelo intervalo, já passou da data sugerida. Vale conferir o fio.`}
        ctaLabel="Agendar afiação"
        onClick={() => {
          track('recomendacoes.cta', { tipo: rec.tipo });
          navigate('/new-order');
        }}
      />
    );
  }

  // sem_programacao
  const n = rec.ferramentas.length;
  return (
    <CardBase
      icon={<CalendarClock className="w-5 h-5 text-status-info" />}
      iconBg="bg-status-info-bg"
      titulo={
        n === 1
          ? '1 ferramenta sem programação de afiação'
          : `${n} ferramentas sem programação de afiação`
      }
      descricao={`${nomesResumidos(rec.ferramentas)} — defina um intervalo para receber lembretes no momento certo.`}
      ctaLabel="Definir programação"
      onClick={() => {
        track('recomendacoes.cta', { tipo: rec.tipo });
        navigate('/tools');
      }}
    />
  );
}

function CardBase({
  icon,
  iconBg,
  titulo,
  descricao,
  ctaLabel,
  onClick,
}: {
  icon: ReactNode;
  iconBg: string;
  titulo: string;
  descricao: string;
  ctaLabel: string;
  onClick: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', iconBg)}>
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground text-sm leading-tight">{titulo}</p>
            <p className="text-xs text-muted-foreground mt-1">{descricao}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" className="w-full mt-3 gap-1" onClick={onClick}>
          {ctaLabel}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
