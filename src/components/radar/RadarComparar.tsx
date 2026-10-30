import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import {
  formatarCnpj, formatarCnae, rotuloPorte, rotuloStatus, scoreUI, CLASSE_TOM,
} from '@/lib/radar/ui-helpers';
import { cn } from '@/lib/utils';

/** Teto da comparação: 3 colunas cabem lado a lado sem rolagem horizontal no desktop. */
export const MAX_COMPARAR = 3;

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <>
      <div className="text-xs text-muted-foreground pt-2 border-t col-span-full first:border-t-0">{rotulo}</div>
      {children}
    </>
  );
}

const vazio = <span className="text-muted-foreground">—</span>;

/**
 * Até 3 leads lado a lado: onde fica, o que faz, como falar com ele e por que o score deu o que deu.
 * Só LEITURA — as ações continuam na ficha de cada um. Score ausente é "sem score" (com o motivo
 * gravado), nunca 0.
 */
export function RadarComparar({
  empresas,
  open,
  onClose,
}: {
  empresas: RadarEmpresa[];
  open: boolean;
  onClose: () => void;
}) {
  const lista = empresas.slice(0, MAX_COMPARAR);
  const colunas = { gridTemplateColumns: `repeat(${Math.max(lista.length, 1)}, minmax(0, 1fr))` };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Comparar {lista.length} empresa{lista.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>Município, atividade, contatos e os motivos do score, lado a lado.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-4 gap-y-1 text-sm" style={colunas} data-testid="radar-comparar">
          {lista.map((e) => (
            <div key={e.cnpj} className="min-w-0">
              <div className="font-medium truncate" title={e.razao_social ?? undefined}>{e.nome_fantasia || e.razao_social || formatarCnpj(e.cnpj)}</div>
              <div className="text-xs text-muted-foreground tabular-nums">{formatarCnpj(e.cnpj)}</div>
            </div>
          ))}

          <Linha rotulo="Município">
            {lista.map((e) => (
              <div key={e.cnpj} className="min-w-0">{e.municipio_nome ? `${e.municipio_nome}${e.uf ? ` / ${e.uf}` : ''}` : vazio}</div>
            ))}
          </Linha>

          <Linha rotulo="Atividade (CNAE principal)">
            {lista.map((e) => (
              <div key={e.cnpj} className="min-w-0">
                <div>{e.cnae_descricao || vazio}</div>
                <div className="text-xs text-muted-foreground tabular-nums">{formatarCnae(e.cnae_principal)} · {rotuloPorte(e.porte)}</div>
              </div>
            ))}
          </Linha>

          <Linha rotulo="Contatos">
            {lista.map((e) => {
              const tels = [e.telefone1, e.telefone2].filter((t): t is string => !!t);
              return (
                <div key={e.cnpj} className="min-w-0 space-y-0.5">
                  {tels.length === 0 && !e.email ? <span className="text-muted-foreground">sem telefone e sem e-mail</span> : null}
                  {tels.map((t) => <div key={t} className="tabular-nums">{t}</div>)}
                  {e.email && <div className="truncate" title={e.email}>{e.email}</div>}
                </div>
              );
            })}
          </Linha>

          <Linha rotulo="Score e motivos">
            {lista.map((e) => {
              const s = scoreUI(e.score, e.score_motivos);
              return (
                <div key={e.cnpj} className="min-w-0">
                  <span className={cn('rounded px-1.5 py-px text-xs font-medium', CLASSE_TOM[s.tom])}>{s.texto}</span>
                  {e.score != null && e.score_motivos && e.score_motivos.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                      {e.score_motivos.map((m) => <li key={m}>{m}</li>)}
                    </ul>
                  ) : (
                    <div className="mt-1 text-xs text-muted-foreground">{s.detalhe}</div>
                  )}
                </div>
              );
            })}
          </Linha>

          <Linha rotulo="Situação na fila">
            {lista.map((e) => <div key={e.cnpj} className="min-w-0">{rotuloStatus(e.prospeccao_status)}</div>)}
          </Linha>
        </div>
      </DialogContent>
    </Dialog>
  );
}
