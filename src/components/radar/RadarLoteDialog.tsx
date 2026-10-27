import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, XCircle, CircleDashed, Loader2, Building2, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { useRadarLoteOmie } from '@/queries/useRadarLote';
import type { ItemLote } from '@/lib/radar/lote-persistido';
import { resumoConflito, situacaoConflito, type SituacaoConflito } from '@/lib/radar/conflito-cadastro';
import { porCnpj, useRadarConflitosDosCnpjs } from '@/queries/useRadarConflitosCadastro';

type Lote = ReturnType<typeof useRadarLoteOmie>;

function IconeItem({ item, sit }: { item: ItemLote; sit: SituacaoConflito }) {
  if (sit.tipo === 'aberto') return <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />;
  if (sit.tipo === 'conferido') return <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" />;
  switch (item.estado.status) {
    case 'ok': return <CheckCircle2 className="w-4 h-4 text-status-success shrink-0" />;
    case 'falha': return <XCircle className="w-4 h-4 text-status-error shrink-0" />;
    case 'divergente': return <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />;
    case 'nao_iniciado': return <CircleDashed className="w-4 h-4 text-muted-foreground shrink-0" />;
    default: return <Loader2 className="w-4 h-4 text-muted-foreground shrink-0 animate-spin" />;
  }
}

/** O servidor manda no aviso (aberto/conferido); o local só fala quando o servidor não tem o registro. */
function detalheItem(item: ItemLote, sit: SituacaoConflito): string {
  if (sit.tipo === 'aberto') return `conflito aberto — confira no Omie e marque como conferido na ficha: ${sit.conflitos.map(resumoConflito).join('; ')}`;
  if (sit.tipo === 'conferido') return `conflito conferido no Omie por um gestor${sit.conflito.notaResolucao ? `: ${sit.conflito.notaResolucao}` : ''} (não é cadastro)`;
  const e = item.estado;
  if (e.status === 'divergente' && sit.tipo === 'nao_sincronizado') return `conflito de vínculo — confira no Omie, nada foi regravado (aviso só nesta aba, não chegou ao servidor): ${e.erro}`;
  if (e.status === 'ok') return e.jaExistia ? `já existia no Omie · cód. ${e.codigo}${e.recuperado ? ' (recuperado)' : ''}` : `cadastrado · cód. ${e.codigo}`;
  if (e.status === 'falha') return `${e.etapa === 'radar' ? 'Omie OK, falhou gravar no Radar' : 'falhou no Omie'}: ${e.erro}`;
  if (e.status === 'divergente') return `conflito de vínculo — confira no Omie, nada foi regravado: ${e.erro}`;
  if (e.status === 'nao_iniciado') return 'não iniciado (lote parado)';
  return 'aguardando…';
}

/**
 * Progresso do lote de cadastro Omie. Fica aberto enquanto roda; ao terminar, mostra o
 * resumo e oferece retentar SÓ o que não ficou ok. "Parar" interrompe novos disparos —
 * o item em voo termina (não há como desfazer uma chamada ao Omie já feita).
 */
export function RadarLoteDialog({ lote, open, onClose }: { lote: Lote; open: boolean; onClose: () => void }) {
  const { lote: estado, rodando, progresso, retomar, parar, esquecer } = lote;
  // O aviso de conflito é do SERVIDOR (migration 20261027160000): outra aba pode ter regravado este lote local.
  const srv = useRadarConflitosDosCnpjs(estado?.itens.map((i) => i.cnpj) ?? []);
  if (!estado || !progresso) return null;
  const doServidor = srv.isSuccess ? porCnpj(srv.data) : null;
  const situacao = (i: ItemLote) => situacaoConflito(
    { divergente: i.estado.status === 'divergente', conflitoId: i.estado.status === 'divergente' ? i.estado.conflitoId ?? null : null },
    doServidor ? doServidor.get(i.cnpj) ?? [] : null,
  );
  const comConflito = estado.itens.filter((i) => {
    const t = situacao(i).tipo;
    return t === 'aberto' || (i.estado.status === 'divergente' && t !== 'conferido');
  }).length;
  const doEsquecer = async () => {
    const r = await esquecer();
    if (r.esquecido) { onClose(); return; }
    if (r.falhas.length > 0) {
      toast.error('O lote ficou guardado', {
        description: `${r.falhas.length} conflito(s) ainda não chegaram ao servidor — apagar o lote perderia o aviso. Tente de novo em instantes.`,
      });
    }
  };
  const pct = progresso.total ? Math.round((progresso.feitos / progresso.total) * 100) : 0;
  const pendentes = progresso.pendentes;
  const parouPorThrottling = estado.itens.some(
    (i) => i.estado.status === 'falha' && /OMIE_TRANSIENT|rate.?limit/i.test(i.estado.erro),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !rodando) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-4 h-4" /> Cadastro em massa no Omie (Oben)
          </DialogTitle>
          <DialogDescription>
            {rodando
              ? `Cadastrando ${progresso.feitos + 1 > progresso.total ? progresso.total : progresso.feitos + 1} de ${progresso.total}…`
              : `${progresso.ok} de ${progresso.total} confirmados · ${progresso.falhas} falha(s) · ${progresso.naoIniciados} não iniciado(s)${comConflito ? ` · ${comConflito} conflito(s)` : ''}`}
          </DialogDescription>
        </DialogHeader>

        <Progress value={pct} className="h-2" />
        {parouPorThrottling && !rodando && (
          <p className="text-xs text-status-warning">
            O Omie limitou as chamadas e o lote parou. Espere alguns minutos e retente só o que faltou.
          </p>
        )}

        {comConflito > 0 && !rodando && (
          <p className="text-xs text-status-warning">
            {comConflito === 1 ? 'Um lead tem' : `${comConflito} leads têm`} conflito entre o Radar e o Omie
            (CNPJ ou código já vinculados a outro cadastro). Retentar não resolve: confira no Omie e marque como conferido na ficha do lead.
            O aviso fica guardado no servidor — esquecer o lote não o apaga.
          </p>
        )}
        {srv.isError && (
          <p className="text-xs text-status-error">
            Não consegui ler os conflitos guardados no servidor — os avisos abaixo são só os desta aba.
          </p>
        )}

        <ul className="max-h-72 overflow-y-auto divide-y text-sm">
          {estado.itens.map((i) => (
            <li key={i.cnpj} className="flex items-start gap-2 py-1.5">
              <IconeItem item={i} sit={situacao(i)} />
              <div className="min-w-0">
                <div className="truncate font-medium">{i.nome}</div>
                <div className={cn('text-xs truncate',
                  situacao(i).tipo === 'aberto' ? 'text-status-warning'
                    : situacao(i).tipo === 'conferido' ? 'text-muted-foreground'
                      : i.estado.status === 'falha' ? 'text-status-error' : i.estado.status === 'divergente' ? 'text-status-warning' : 'text-muted-foreground')}
                  title={detalheItem(i, situacao(i))}>
                  {detalheItem(i, situacao(i))}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          {rodando ? (
            <Button variant="outline" onClick={parar}>Parar após o atual</Button>
          ) : (
            <>
              {pendentes > 0 && (
                <Button onClick={retomar}>Retentar {pendentes} pendente{pendentes === 1 ? '' : 's'}</Button>
              )}
              <Button variant="ghost" onClick={() => { void doEsquecer(); }}>
                {progresso.concluido ? 'Fechar' : 'Esquecer lote'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
