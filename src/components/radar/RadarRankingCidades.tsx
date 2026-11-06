import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useRadarContagemMunicipios,
  useRadarPenetracaoMunicipios,
  oportunidadesPenetracao,
  formatarPenetracao,
  bateuNoTeto,
  LIMITE_MUNICIPIOS,
  type RadarMunicipioContagem,
} from '@/queries/useRadarContagemMunicipios';
import { useRadarLoteVigente } from '@/queries/useRadarLoteVigente';
import type { RadarFiltros } from '@/queries/useRadarLista';
import { avisoContagem, rotuloRecorteGeo, type CidadeEscolhida } from '@/lib/radar/ui-helpers';

/** true quando o elemento entra na tela (e fica true). Sem IntersectionObserver (SSR/jsdom antigo) = visível:
 *  degradar para o comportamento de antes (carregar), nunca para um card que não carrega nunca. */
function useVisivel<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visivel, setVisivel] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visivel || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver((entradas) => {
      if (entradas.some((e) => e.isIntersecting)) { setVisivel(true); obs.disconnect(); }
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [visivel]);
  return [ref, visivel];
}

export function RadarRankingCidades({
  filtros,
  hojeISO,
  onPick,
  adiar = false,
}: {
  filtros: RadarFiltros;
  hojeISO: string;
  onPick: (cidade: CidadeEscolhida) => void;
  /** true enquanto a fila ainda não assentou: o território espera a 1ª página de leads (pacote C, C5). */
  adiar?: boolean;
}) {
  // Carrega só quando o card está na tela E a fila já respondeu: o território é secundário, e antes as duas
  // agregações (contagem + penetração paginada) disputavam a abertura com a 1ª página de leads.
  const [ref, visivel] = useVisivel<HTMLDivElement>();
  const carregar = visivel && !adiar;
  const q = useRadarContagemMunicipios(filtros, hojeISO, carregar);
  const pen = useRadarPenetracaoMunicipios(filtros, carregar);
  const loteVigente = useRadarLoteVigente().data ?? null;
  const top = (q.data ?? []).slice(0, 8);
  const exibidos = q.data?.length ?? 0;
  const totalExibido = (q.data ?? []).reduce((s, m) => s + m.total, 0);
  const comTelExibido = (q.data ?? []).reduce((s, m) => s + m.com_telefone, 0);
  const recorteGeo = rotuloRecorteGeo(filtros);
  // Município fora da resposta da penetração fica SEM dado ('—'), não 0%.
  const penPorCodigo = useMemo(() => new Map((pen.data ?? []).map((m) => [m.municipio_codigo, m])), [pen.data]);
  const oportunidades = useMemo(() => oportunidadesPenetracao(pen.data ?? [], 5), [pen.data]);
  // Erro sem dado em mãos NÃO é "0 empresas · nenhuma cidade": é contagem indisponível (agregado do lote
  // ainda não calculado) ou falha de leitura — e a tela diz qual.
  const semDado = q.isError && q.data === undefined;
  const aguardando = !carregar || q.isLoading;

  return (
    <Card className="p-3" ref={ref}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-sm font-medium flex items-center gap-1">
          <MapPin className="w-4 h-4" /> Onde caçar
        </span>
        {/* A soma é dos municípios DA RESPOSTA (teto de LIMITE_MUNICIPIOS), não um total da região (C4). */}
        <span className="text-xs text-muted-foreground tabular-nums text-right" data-testid="radar-ranking-soma">
          {aguardando ? '…' : semDado ? '—' : (
            <>
              {totalExibido.toLocaleString('pt-BR')} empresas · {comTelExibido.toLocaleString('pt-BR')} c/ telefone
              {' '}nos {exibidos.toLocaleString('pt-BR')} municípios exibidos {recorteGeo}
              {bateuNoTeto(exibidos) && <> (teto de {LIMITE_MUNICIPIOS}: há municípios fora da soma)</>}
            </>
          )}
        </span>
      </div>
      {aguardando ? (
        <div className="space-y-1">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : semDado ? (
        <p className="text-xs text-status-warning">{avisoContagem(q.error, 'Contagem por cidade')}</p>
      ) : top.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma cidade nestes filtros.</p>
      ) : (
        <ul className="space-y-0.5">
          {top.map((m: RadarMunicipioContagem) => (
            <li key={m.municipio_codigo}>
              <button
                onClick={() => onPick({ codigo: m.municipio_codigo, nome: m.municipio_nome, uf: m.uf })}
                className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
              >
                <span className="truncate">{m.municipio_nome} <span className="text-muted-foreground">/{m.uf}</span></span>
                <span className="tabular-nums text-xs text-muted-foreground shrink-0 ml-2">
                  {m.total.toLocaleString('pt-BR')} · {m.com_telefone} 📞 · {m.a_contatar} a contatar
                  {pen.data && <> · {formatarPenetracao(penPorCodigo.get(m.municipio_codigo)?.penetracao ?? null)} cli.</>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {oportunidades.length > 0 && (
        <div className="mt-3 pt-2 border-t">
          <p className="text-xs font-medium">Mercado grande, pouca penetração</p>
          {/* O universo da penetração é o MERCADO do lote no recorte geográfico, não a fila filtrada (C4). */}
          <p className="text-xs text-muted-foreground mb-1" data-testid="radar-oportunidades-universo">
            Mercado = empresas do lote{loteVigente ? ` ${loteVigente.mes_referencia}` : ''} {recorteGeo}, qualquer situação;
            {' '}abaixo da média do recorte
            {bateuNoTeto(pen.data?.length) && <> (nos {LIMITE_MUNICIPIOS} maiores mercados)</>}.
          </p>
          <ul className="space-y-0.5">
            {oportunidades.map((m) => (
              <li key={m.municipio_codigo}>
                <button
                  onClick={() => onPick({ codigo: m.municipio_codigo, nome: m.municipio_nome, uf: m.uf })}
                  className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
                >
                  <span className="truncate">{m.municipio_nome ?? m.municipio_codigo} <span className="text-muted-foreground">/{m.uf}</span></span>
                  <span className="tabular-nums text-xs text-muted-foreground shrink-0 ml-2">
                    {(m.empresas_lote ?? 0).toLocaleString('pt-BR')} empresas · {formatarPenetracao(m.penetracao)} cli.
                    {m.concorrentes != null && <> · {m.concorrentes} revendas</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
