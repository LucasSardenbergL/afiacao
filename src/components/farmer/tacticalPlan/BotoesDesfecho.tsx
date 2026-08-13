// Registro de desfecho em 1 toque, na FACE do card do plano tático.
//
// Contexto (docs/historico/fila-plano-tatico.md): o PR #1693 deu SAÍDA à fila e provou que ela
// não era mais o gargalo — 169 planos ficaram pendentes, alcançáveis, com 7 dias de janela, e o
// desfecho continuou em ZERO (0 de 533, psql-ro 2026-08-07). O que resta é o custo de captura:
// o RecordResultDialog pede switch + select + margem em R$ + duração, atrás de um card que
// precisa ser aberto. A vendedora não sabe a margem durante a ligação.
//
// Este componente não substitui o dialog — ele vira o caminho DETALHADO, e continua sendo o
// único caminho para planos já expirados.
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import type { RecordResultPayload } from './types';

/**
 * Os cinco desfechos de uma ligação.
 *
 * `valor` é gravado em `farmer_tactical_plans.call_result` e reproduz EXATAMENTE o vocabulário
 * do select do RecordResultDialog — o 1 toque não inventa domínio novo, senão o histórico
 * nasceria partido em dois vocabulários sem migration que os reconcilie.
 *
 * `comConversa` agrupa visualmente (linha 1 = falou com o cliente, linha 2 = não falou) e
 * documenta a fronteira que motivou a decisão 3 do spec: os dois de baixo concluem o plano
 * hoje, e é isso que a primeira semana de uso vai testar.
 */
export const DESFECHOS = [
  { valor: 'venda_realizada', rotulo: 'Vendeu', curto: 'Vendeu', emoji: '✅', comConversa: true },
  { valor: 'interesse_futuro', rotulo: 'Interesse futuro', curto: 'Futuro', emoji: '🔁', comConversa: true },
  { valor: 'sem_interesse', rotulo: 'Não vendeu', curto: 'Não vendeu', emoji: '❌', comConversa: true },
  { valor: 'nao_atendeu', rotulo: 'Não atendeu', curto: 'Não atendeu', emoji: '📵', comConversa: false },
  { valor: 'reagendado', rotulo: 'Remarcou', curto: 'Remarcou', emoji: '📅', comConversa: false },
] as const;

/**
 * Rótulo legível de um `call_result` gravado. Fonte única com os botões.
 * Valor desconhecido volta CRU em vez de virar "—": um valor gravado por outro writer é dado
 * real, e escondê-lo atrás de um travessão apagaria a única pista de que ele existe.
 */
export const rotuloDoDesfecho = (valor: string): string =>
  DESFECHOS.find((d) => d.valor === valor)?.rotulo ?? valor;

/**
 * [money-path — ausente ≠ zero] O payload de um toque.
 *
 * Um toque captura UM fato: qual foi o desfecho. Todo o resto é desconhecido e vai ao banco
 * como NULL (as colunas são nullable e a RPC aceita null explícito — verificado com
 * `pg_get_functiondef` na PROD, não no repo).
 *
 * - `actualMargin: null` — a margem não foi apurada. `0` entraria nas médias de efetividade
 *   como resultado real, que é exatamente a fabricação do `Number(null) === 0`.
 * - `callDurationSeconds: null` — ninguém cronometrou. `0` afirmaria ligação instantânea e
 *   ainda viraria denominador em profitPerHour.
 * - `planFollowed: null` nos CINCO — inclusive nos três em que houve conversa. Gravar `true`
 *   ali pareceria razoável e seria fabricação: o toque não pergunta se ela seguiu o roteiro.
 *   `false` nos dois sem conversa seria pior — afirmaria que ela ignorou um plano que nem
 *   chegou a ser executado, e o follow-rate leria isso como desobediência.
 */
export function payloadDeUmToque(callResult: string): RecordResultPayload {
  return {
    planFollowed: null,
    callResult,
    actualMargin: null,
    callDurationSeconds: null,
  };
}

export const BotoesDesfecho = ({
  planId,
  onRecord,
}: {
  planId: string;
  onRecord: (planId: string, result: RecordResultPayload) => Promise<void>;
}) => {
  // Lente "Ver como": registrar resultado é WRITE — desabilitado, igual ao RecordResultDialog.
  const { isImpersonating } = useImpersonation();
  // Qual desfecho está gravando. Trava os CINCO botões durante a gravação: a RPC recusa a
  // segunda escrita com "Plano já concluído" e o toast de erro puniria quem só tocou duas
  // vezes num alvo de 44px — ou tocou em "Vendeu" e corrigiu para "Remarcou" antes do retorno.
  const [salvando, setSalvando] = useState<string | null>(null);

  const registrar = async (valor: string) => {
    if (salvando || isImpersonating) return;
    setSalvando(valor);
    try {
      await onRecord(planId, payloadDeUmToque(valor));
    } catch (err) {
      // `recordResult` hoje já trata e mostra toast, então este catch não dispara na integração
      // real. Ele existe porque o `onClick` DESCARTA a promise: um handler que propague viraria
      // unhandled rejection, que em produção não avisa ninguém e no teste derruba a suíte.
      console.error('[BotoesDesfecho] falha ao registrar desfecho', err);
    } finally {
      // `finally` e não o fim do try: sem ele, uma falha de rede deixaria o card travado em
      // "salvando" para sempre, e o desfecho se perderia justamente no caso em que ela tentou.
      setSalvando(null);
    }
  };

  const botao = (d: (typeof DESFECHOS)[number]) => (
    <Button
      key={d.valor}
      variant="outline"
      size="touch"
      // `size="touch"` pelo alvo de 44px (WCAG AA / chão de fábrica); o padding e o corpo de
      // texto da variante são grandes demais para três alvos na largura de um card.
      className="px-1 text-[10px] gap-1 min-w-0"
      // Rótulo completo no nome acessível: o texto visível é abreviado ("Futuro") para caber,
      // e leitor de tela / tooltip precisam do termo comercial inteiro.
      aria-label={d.rotulo}
      title={d.rotulo}
      disabled={!!salvando || isImpersonating}
      onClick={() => registrar(d.valor)}
    >
      {salvando === d.valor
        ? <Loader2 className="w-3 h-3 animate-spin shrink-0" />
        : <span aria-hidden="true">{d.emoji}</span>}
      <span className="truncate">{d.curto}</span>
    </Button>
  );

  return (
    <div
      className="mt-2 space-y-1"
      title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
    >
      <div className="grid grid-cols-3 gap-1">
        {DESFECHOS.filter((d) => d.comConversa).map(botao)}
      </div>
      <div className="grid grid-cols-2 gap-1">
        {DESFECHOS.filter((d) => !d.comConversa).map(botao)}
      </div>
    </div>
  );
};
