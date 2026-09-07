import { useEffect, useRef } from 'react';
import { useRadarKpis } from '@/queries/useRadarKpis';
import { Skeleton } from '@/components/ui/skeleton';
import { estadoDeLeitura, naoConsegui, desatualizado, type EstadoLeitura } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { track } from '@/lib/analytics';

function Card({ label, valor, hint }: { label: string; valor: number | string; hint?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{valor}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

/**
 * Placar do lote do Radar de prospecção — o resumo que o gestor lê antes da lista.
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md). Fazia
 * `const { data, isLoading } = useRadarKpis(); if (!data) return null` — e como o hook
 * LANÇA quando a RPC falha, `data` fica `undefined` no erro, na primeira carga e no
 * offline: os três colapsavam no mesmo sumiço. Denominador medido em prod (psql-ro,
 * 2026-08-23): `radar_empresas` tem 526.176 empresas, 523.180 delas `a_contatar`, lote
 * 2026-05 `complete`. É o único dos cinco cards desta leva com dano VIVO — a falha de
 * leitura apagava, sem rastro, o resumo de meio milhão de prospects, e a lista embaixo
 * continuava na tela dando ao painel a aparência de quem simplesmente não tem números.
 *
 * Ausência de ACESSO NÃO passa por aqui: o `enabled` do hook espelha o gate da RPC, então
 * staff não-gestor cai em `desabilitada` — não renderiza, não avisa e não emite evento.
 */
export function RadarKpis() {
  const q = useRadarKpis();
  const { data } = q;
  const estado = estadoDeLeitura(q);

  // Sensor de adoção (o card nasceu sem nenhum): sem ele não há como saber, em prod, se o
  // aviso abaixo apareceu. Emite em TODO estado RESOLVIDO — erro inclusive — e leva `null`
  // no lugar do número quando a leitura não aconteceu: `0` somaria falha de leitura a
  // "lote vazio", que é a MESMA fabricação que este card existe para não cometer
  // (money-path §2: ausente ≠ zero). `desabilitada` (sem acesso) e `carregando` não emitem
  // — contá-las poluiria o denominador com quem nunca poderia ver a tela.
  // A dedup é pelo ESTADO emitido, não por booleano: `erro → pronta` na mesma montagem é
  // justamente a transição que separa falha transitória de lote realmente vazio.
  const trackedEstado = useRef<EstadoLeitura | null>(null);
  useEffect(() => {
    if (estado === 'carregando' || estado === 'desabilitada') return;
    if (trackedEstado.current === estado) return;
    trackedEstado.current = estado;
    track('radar.kpis_vistos', { estado, a_contatar: data?.a_contatar ?? null });
  }, [estado, data]);

  if (estado === 'carregando')
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );

  // Sem NADA em mãos: só o aviso — é exatamente o que o defeito escondia.
  if (naoConsegui(estado) && !data) {
    return <AvisoLeituraFalhou oque="os indicadores do lote do Radar" estado={estado} className="mb-0" />;
  }

  // COM os números no cache e um refetch que falhou, apagar o painel trocaria um defeito
  // por outro. Estado COMPOSTO: os KPIs ficam, com o aviso de que estão desatualizados.
  const velho = desatualizado(q, Boolean(data));

  // `desabilitada` — a pergunta que não foi feita (staff sem acesso ao Radar).
  if (!data) return null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card
          label="Novos no lote"
          valor={data.novos.toLocaleString('pt-BR')}
          hint={data.lote ?? undefined}
        />
        <Card label="A contatar" valor={data.a_contatar.toLocaleString('pt-BR')} />
        <Card label="Em conversa" valor={data.em_conversa.toLocaleString('pt-BR')} />
        <Card label="Viraram cliente (mês)" valor={data.virou_cliente_mes.toLocaleString('pt-BR')} />
      </div>
      {velho && <AvisoLeituraFalhou oque="a leitura mais recente" estado={velho} className="mt-2" />}
    </div>
  );
}
