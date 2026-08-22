import { useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { useCarteiraSaude } from '@/hooks/useCarteiraSaude';
import { statusCron, statusSync, statusCoverage, nivelAgregado } from '@/lib/carteira-saude/status';
import { track } from '@/lib/analytics';
import type { SaudeNivel } from '@/lib/carteira-saude/types';
import { estadoDeLeitura, naoConsegui, type EstadoLeitura } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

const DOT: Record<SaudeNivel, string> = {
  green: 'bg-status-success-bold',
  yellow: 'bg-status-warning-bold',
  red: 'bg-status-error-bold',
};

const NIGHTLY_MAX_AGE = 48;
// Mensal alerta se o snapshot mais recente passa de ~35 dias. A RPC cai pro EFEITO
// (max created_at do snapshot) quando o purge do job_run_details apaga o run mensal —
// então idade grande aqui é atraso REAL, não cegueira de histórico.
const MENSAL_MAX_AGE = 24 * 35;
const MENSAL = 'carteira-positivacao-snapshot-mensal';

function Row({ nivel, label, detail, acao }: { nivel: SaudeNivel; label: string; detail: string; acao: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${DOT[nivel]}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {label} <span className="text-2xs text-muted-foreground font-normal">{detail}</span>
        </div>
        {nivel !== 'green' && <div className="text-2xs text-muted-foreground">{acao}</div>}
      </div>
    </div>
  );
}

/**
 * ⚠️ FAIL-CLOSED de propósito — este painel é o gêmeo exato do MixGap do #1859, e o
 * agravante é que ele É o painel de saúde:
 *
 *     const { data, isLoading } = useCarteiraSaude();
 *     if (!data || tracked.current) return;          // o evento só saía COM data
 *     if (!data) return null;                        // erro e vazio no mesmo silêncio
 *
 * `useCarteiraSaude` lança quando a RPC falha ⇒ `data` fica `undefined` no erro, na
 * mesma condição de "nunca carregou". Um painel que existe para dizer "cron parado,
 * sync velho, cobertura furada" DESAPARECENDO quando não consegue ler é a forma mais
 * cara da classe: a ausência afirma verde (docs/historico/fase-sem-sinal.md).
 *
 * O evento de adoção segue as duas regras do #1859:
 *   · sai em TODO estado resolvido (erro inclusive), senão o denominador de
 *     `carteira.saude_vista` soma falha de leitura a "ninguém abriu";
 *   · leva `nivel: null` no erro, NUNCA um nível fabricado — mandar 'green' seria
 *     inventar exatamente o número que o sensor existe para medir (§2 do money-path:
 *     ausente ≠ zero). Denominador medido em prod: 3 vendedores em `commercial_roles`,
 *     então um evento errado é um terço da série.
 *   · a dedup é pelo ESTADO EMITIDO, não por booleano: `erro → pronta` na mesma
 *     montagem é justamente a transição que separa falha transitória de carteira vazia,
 *     e um `useRef<boolean>` a engoliria.
 */
export function CarteiraSaudePanel() {
  const q = useCarteiraSaude();
  const { data } = q;
  const estado = estadoDeLeitura(q);

  const trackedEstado = useRef<EstadoLeitura | null>(null);
  // `data == null` com a leitura PRONTA é a RPC dizendo "você não é staff": conferido em
  // prod, `get_carteira_saude` faz RETURN NULL sem uid ou sem role master/employee.
  // Ausência de ACESSO não é um estado do painel — contá-la como "visto" poluiria o
  // denominador de adoção com quem nunca poderia ver a tela. Não renderiza e NÃO emite;
  // é a única ausência de evento legítima (mesma regra do #1859).
  const semAcesso = estado === 'pronta' && data == null;
  useEffect(() => {
    if (estado === 'carregando' || estado === 'desabilitada' || semAcesso) return;
    if (trackedEstado.current === estado) return;
    trackedEstado.current = estado;
    const nivel = data
      ? nivelAgregado([
          ...data.crons.map((c) => statusCron(c, c.jobname === MENSAL ? MENSAL_MAX_AGE : NIGHTLY_MAX_AGE).nivel),
          statusSync(data.sync).nivel,
          statusCoverage(data.score_coverage).nivel,
        ])
      : null;
    track('carteira.saude_vista', { estado, nivel });
  }, [estado, data, semAcesso]);

  if (naoConsegui(estado)) {
    return (
      <Card className="p-4">
        <AvisoLeituraFalhou oque="a saúde da carteira" estado={estado} className="mb-0" />
      </Card>
    );
  }
  if (estado === 'carregando') {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  // `desabilitada` (query sem `enabled`) e o `data` nulo da RPC = ausência de ACESSO,
  // não um estado do painel: não renderiza e — acima — não emite.
  if (!data) return null;

  const cronRows = data.crons.map((c) => {
    const st = statusCron(c, c.jobname === MENSAL ? MENSAL_MAX_AGE : NIGHTLY_MAX_AGE);
    const detail = c.last_run_at ? `${c.last_status ?? '?'} · há ${c.age_hours ?? '?'}h` : 'nunca rodou';
    return { ...st, label: c.jobname, detail };
  });
  const syncSt = statusSync(data.sync);
  const syncDetail = data.sync.age_hours == null
    ? 'sem sync'
    : `há ${data.sync.age_hours}h · ${data.sync.stale_count} stale`;
  const covSt = statusCoverage(data.score_coverage);
  const covDetail = `${data.score_coverage.fcs_clientes}/${data.score_coverage.carteira} score · ${data.score_coverage.cvs_clientes}/${data.score_coverage.carteira} visita`;

  const agregado = nivelAgregado([...cronRows.map((r) => r.nivel), syncSt.nivel, covSt.nivel]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[agregado]}`} />
          Saúde da carteira
        </CardTitle>
        <p className="text-2xs text-muted-foreground">
          Crons, frescor do sync Omie e cobertura de score. Semáforo operacional — vermelho = ação necessária.
        </p>
      </CardHeader>
      <div className="px-6 pb-4 divide-y divide-border">
        <Row nivel={syncSt.nivel} label="Sync da carteira" detail={syncDetail} acao={syncSt.acao} />
        <Row nivel={covSt.nivel} label="Cobertura de score" detail={covDetail} acao={covSt.acao} />
        {cronRows.map((r) => (
          <Row key={r.label} nivel={r.nivel} label={r.label} detail={r.detail} acao={r.acao} />
        ))}
      </div>
    </Card>
  );
}
