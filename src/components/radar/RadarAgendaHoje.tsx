import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Hourglass } from 'lucide-react';
import { useRadarProspectarHoje } from '@/queries/useRadarProspectarHoje';
import { registrarUsoAgenda } from '@/queries/useRadarAgendaUso';
import { nomeDoLead, tituloMunicipio } from '@/lib/radar/prospectar-hoje';
import { diaMes } from '@/lib/radar/atendimento';
import { resumoAgendaHoje } from '@/lib/radar/agenda-hoje';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Pacote L (item 3): a agenda "Hoje" dentro do /radar — os retornos marcados para hoje (ou atrasados) e as posses que
 * vencem em 48 h. Antes isso só aparecia no card do /meu-dia e no e-mail semanal (desligado): quem trabalhava pelo
 * /radar não via o que tinha combinado. Sem tela nova e sem RPC nova: a MESMA leitura do card
 * (`radar_prospectar_hoje`, mesma chave de cache — abrir o /radar depois do /meu-dia não consulta de novo).
 * Agenda vazia não ocupa espaço (a fila é a entrada do vendedor, pacote B1); leitura que falhou DIZ.
 * Sensor no ledger (`radar_agenda_uso`): 'vista' 1×/dia com o denominador; 'aberta' por item.
 */
export function RadarAgendaHoje({ hojeISO, onAbrir }: {
  /** Dia BRT da página: a 'vista' é 1 por dia. A leitura relê na virada pela chave do hook (`useHojeBRT`). */
  hojeISO: string;
  onAbrir: (cnpj: string) => Promise<void>;
}) {
  const q = useRadarProspectarHoje(true);
  const resumo = q.data ? resumoAgendaHoje(q.data) : null;
  const vistaDoDia = useRef<string | null>(null);

  useEffect(() => {
    if (!resumo || resumo.vazia || vistaDoDia.current === hojeISO) return;
    vistaDoDia.current = hojeISO;
    track('radar.agenda_hoje_vista', { retornos: resumo.totalRetornos, posses: resumo.posses.length, vencidas_7d: resumo.vencidas7d });
    void registrarUsoAgenda({ evento: 'vista', nRetornos: resumo.totalRetornos, nPosses: resumo.posses.length });
  }, [resumo, hojeISO]);

  if (q.isError) {
    return (
      <p className="text-xs text-status-error" data-testid="radar-agenda-erro">
        Não consegui ler seus retornos e posses de hoje ({mensagemDeErro(q.error) ?? 'erro de leitura'}).{' '}
        <button type="button" className="underline" onClick={() => void q.refetch()}>Tentar de novo</button>
      </p>
    );
  }
  if (!resumo || resumo.vazia) return null;

  const abrir = (cnpj: string, tipo: 'retorno' | 'posse') => {
    track('radar.agenda_hoje_aberta', { tipo });
    void registrarUsoAgenda({ evento: 'aberta', cnpj });
    onAbrir(cnpj).catch((e) => toast.error('Não consegui abrir a ficha', { description: mensagemDeErro(e) ?? undefined }));
  };

  return (
    <section className="rounded-md border p-3 space-y-2" data-testid="radar-agenda-hoje" aria-label="Sua agenda de hoje">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-display leading-tight">Hoje</h2>
        <p className="text-xs text-muted-foreground" data-testid="radar-agenda-resumo">{resumo.rotulo}</p>
      </div>
      {resumo.retornos.length > 0 && (
        <ul className="space-y-1">
          {resumo.retornos.map((r) => (
            <li key={r.cnpj}>
              <button type="button" onClick={() => abrir(r.cnpj, 'retorno')} data-testid="radar-agenda-retorno"
                className="w-full text-left rounded px-2 py-1.5 hover:bg-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm min-h-11">
                <CalendarClock className="w-4 h-4 shrink-0 text-status-info" />
                <span className="font-medium truncate">{nomeDoLead(r)}</span>
                <span className="text-xs text-muted-foreground">
                  {r.tipo === 'conversa' ? 'retomar a conversa' : 'tentar de novo'}
                  {r.municipioNome ? ` · ${tituloMunicipio(r.municipioNome)}` : ''}
                </span>
                {r.atrasado && <span className="text-xs text-status-warning">atrasado ({diaMesDia(r.retornoEm)})</span>}
                {r.nota && <span className="basis-full text-xs text-muted-foreground truncate pl-6">“{r.nota}”</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {resumo.posses.length > 0 && (
        <ul className="space-y-1">
          {resumo.posses.map((p) => (
            <li key={p.atendimentoId}>
              <button type="button" onClick={() => abrir(p.cnpj, 'posse')} data-testid="radar-agenda-posse"
                className="w-full text-left rounded px-2 py-1.5 hover:bg-muted flex flex-wrap items-center gap-x-2 text-sm min-h-11">
                <Hourglass className="w-4 h-4 shrink-0 text-status-warning" />
                <span className="font-medium truncate">{nomeDoLead(p)}</span>
                <span className="text-xs text-muted-foreground">sua posse vence em {diaMes(p.expiraEm)} — um contato renova</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(resumo.retornosFora > 0 || resumo.vencidas7d > 0) && (
        <p className="text-xs text-muted-foreground" data-testid="radar-agenda-rodape">
          {[
            resumo.retornosFora > 0 ? `+${resumo.retornosFora} retorno${resumo.retornosFora === 1 ? '' : 's'} além destes` : null,
            resumo.vencidas7d > 0 ? `${resumo.vencidas7d} posse${resumo.vencidas7d === 1 ? '' : 's'} venceu${resumo.vencidas7d === 1 ? '' : 'ram'} nos últimos 7 dias` : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      {q.isFetching && !q.isLoading && <span className="sr-only">Atualizando a agenda</span>}
    </section>
  );
}

/** 'YYYY-MM-DD' → 'dd/mm' sem passar por `new Date('YYYY-MM-DD')` (meia-noite UTC = dia anterior em BRT). */
function diaMesDia(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}
