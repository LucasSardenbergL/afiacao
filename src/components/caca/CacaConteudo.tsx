/**
 * CacaConteudo — container da fila de caça (Frente B).
 *
 * Liga o hook de dados (`useCaca`) ao componente PURO (`FilaDeCaca`):
 *   - carrega os candidatos (look-alike dos melhores que ainda não compram);
 *   - guarda os documentos ocultos NA SESSÃO (mesmo padrão do `FilaDoDia` da
 *     Frente A: `useState<Set<string>>` + `ocultar` + filtro via `useMemo`);
 *   - filtra os ocultos antes de passar pro `FilaDeCaca`.
 *
 * Estados honestos (degradação consistente com o resto do app):
 *   - loading → delega ao skeleton do próprio `FilaDeCaca` (`isLoading`);
 *   - erro    → mensagem + botão "Tentar de novo" que dispara `refetch`
 *               (o `FilaDeCaca` não tem estado de erro próprio);
 *   - vazio   → `EmptyState tone="operational"` ("Nenhum alvo de caça agora").
 *
 * Reusável: a página `/caca` e o HunterDashboard (Meu Dia do hunter) montam
 * este mesmo container. Sem header próprio — quem monta decide o cabeçalho.
 *
 * ⚠️ Chave de ocultar = `documento`. É o que o `onOcultar` do `FilaDeCaca`
 * entrega (a fila é agrupada por documento), e bate com `features.documento`
 * de cada `CacaCandidatoDisplay` no array cru retornado pelo `useCaca`.
 *
 * Telemetria: NÃO instrumentamos "exibida" aqui — o `FilaDeCaca` já instrumenta
 * as interações (abrir item, ação, outcome). Métrica de piloto é Fase 4.
 */

import { useEffect, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { track } from '@/lib/analytics';
import { spBusinessDate } from '@/lib/time/sp-day';
import { marcarSeNovoNoDia } from '@/lib/fila/telemetria';
import { chaveDiaExibidaCaca, resumoSabores } from '@/lib/caca/telemetria';
import { useCaca } from '@/hooks/useCaca';
import { FilaDeCaca } from './FilaDeCaca';

export function CacaConteudo() {
  const { data, isLoading, error, refetch } = useCaca();

  // Documentos ocultos na sessão (não persiste). Igual ao FilaDoDia da Frente A.
  const [ocultos, setOcultos] = useState<Set<string>>(() => new Set());
  const ocultar = (documento: string) =>
    setOcultos((s) => {
      const n = new Set(s);
      n.add(documento);
      return n;
    });

  // Filtra os ocultos. `features.documento` é a mesma chave que o onOcultar entrega.
  const visiveis = useMemo(
    () => (data?.fila ?? []).filter((c) => !ocultos.has(c.features.documento)),
    [data, ocultos],
  );
  const empresasSemLucro = data?.empresasSemLucro ?? [];

  // caca.exibida: 1×/dia/sessão (NÃO por render) — mede exposição, não re-render.
  useEffect(() => {
    if (isLoading || visiveis.length === 0) return;
    const dia = spBusinessDate(new Date());
    if (marcarSeNovoNoDia(chaveDiaExibidaCaca(dia), sessionStorage)) {
      track('caca.exibida', { qtd: visiveis.length, sabores: resumoSabores(visiveis) });
    }
  }, [isLoading, visiveis]);

  // ─── Erro ───────────────────────────────────────────────────────────────────
  // FilaDeCaca não tem estado de erro → tratamos aqui (honesto, com retry).
  if (error) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Não foi possível carregar a fila de caça.</p>
        <p className="text-2xs text-muted-foreground mt-1">
          Houve um erro ao buscar os candidatos. Tente novamente.
        </p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          Tentar de novo
        </Button>
      </Card>
    );
  }

  // ─── Vazio ────────────────────────────────────────────────────────────────────
  // Só quando JÁ carregou e não há candidatos visíveis (após filtro de ocultos).
  if (!isLoading && visiveis.length === 0) {
    return (
      <EmptyState
        icon={Target}
        tone="operational"
        title="Nenhum alvo de caça agora"
        description="Não há clientes parecidos com seus melhores que ainda não compram aqui. Assim que novos candidatos forem identificados, eles aparecerão nesta lista."
      />
    );
  }

  // ─── Loading + lista ───────────────────────────────────────────────────────────
  // FilaDeCaca renderiza seu próprio skeleton quando isLoading.
  //
  // O aviso de lucro fora do índice vem ANTES da lista porque ele muda como a lista se lê: o
  // índice que ordena os "melhores clientes" pesa lucro em 0,4, e quando nenhum comprador da
  // empresa tem lucro confiável esse termo vira constante — o ranking passa a ser volume +
  // fidelidade, com a MESMA aparência de sempre. Silenciar isso é o "ausente ≠ zero" falhando
  // aberto: a ausência não corrompe a ordem, corrompe o que o operador acha que está vendo.
  // Duas causas possíveis, e a linha da view não distingue entre elas — o texto nomeia as duas.
  return (
    <div className="space-y-3">
      {empresasSemLucro.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning-foreground"
        >
          <p className="font-medium">
            Ranking sem o componente de lucro em {empresasSemLucro.join(' e ')}.
          </p>
          <p className="text-2xs text-muted-foreground mt-1">
            Nenhum comprador dessa(s) empresa(s) tem custo apurado com cobertura suficiente, então
            a ordem abaixo considera só volume e fidelidade. Pode ser custo ainda não sincronizado
            ou o seu acesso não incluir leitura de custo.
          </p>
        </div>
      )}
      <FilaDeCaca candidatos={visiveis} isLoading={isLoading} onOcultar={ocultar} />
    </div>
  );
}
