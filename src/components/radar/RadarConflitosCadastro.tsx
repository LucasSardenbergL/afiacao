import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { resumoConflito, type ConflitoCadastro } from '@/lib/radar/conflito-cadastro';
import {
  ehConflitoMudou, porCnpj, useRadarConflitosAbertos, useRadarConflitosDosCnpjs, useRadarResolverConflito,
} from '@/queries/useRadarConflitosCadastro';

// Conflitos de cadastro Radar×Omie guardados no servidor (migration 20261027160000). Conflito aberto barra o
// cadastro do CNPJ até um gestor conferir no Omie e registrar o que viu — resolver é marcar o PRÓPRIO registro
// (com a versão lida: ocorrência nova de outra aba recusa e relê). Resolver não corrige vínculo nem vira cadastro.

/** Ficha do lead: os conflitos ABERTOS deste CNPJ, com "Conferi no Omie". */
export function RadarConflitosDoLead({ cnpj }: { cnpj: string }) {
  const q = useRadarConflitosDosCnpjs([cnpj]);
  const abertos = (q.data ?? []).filter((c) => c.resolvidoEm === null);
  if (q.isError) {
    return <p className="text-xs text-status-error">Não consegui ler os conflitos com o Omie deste lead — o cadastro fica bloqueado até a leitura voltar.</p>;
  }
  if (abertos.length === 0) return null;
  return (
    <div className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm space-y-2">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />
        Conflito com o Omie — o cadastro deste lead está bloqueado
      </div>
      {abertos.map((c) => <LinhaConflito key={c.id} conflito={c} />)}
    </div>
  );
}

function LinhaConflito({ conflito }: { conflito: ConflitoCadastro }) {
  const { isImpersonating } = useImpersonation();
  const resolver = useRadarResolverConflito();
  const [aberto, setAberto] = useState(false);
  const [nota, setNota] = useState('');

  const confirmar = async () => {
    try {
      await resolver.mutateAsync({ conflito, nota });
      setAberto(false);
      setNota('');
      toast.success('Conflito marcado como conferido', { description: 'O lead volta a poder ser cadastrado — o vínculo não foi alterado.' });
    } catch (e) {
      setAberto(false);
      toast.error(ehConflitoMudou(e) ? 'O conflito mudou desde que você abriu a ficha' : 'Não foi possível marcar como conferido', {
        description: ehConflitoMudou(e) ? 'Houve uma ocorrência nova (ou outra pessoa já resolveu). Releia e confira de novo.' : e instanceof Error ? e.message : undefined,
      });
    }
  };

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 min-w-0 text-xs">
        <div>{resumoConflito(conflito)}</div>
        <div className="text-muted-foreground">
          {`última ocorrência ${new Date(conflito.ultimaEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={isImpersonating || resolver.isPending} onClick={() => setAberto(true)}
        title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}>
        {resolver.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
        Conferi no Omie
      </Button>
      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar o conflito como conferido?</AlertDialogTitle>
            <AlertDialogDescription>
              {resumoConflito(conflito)}. Diga o que você viu no Omie. Isto só encerra o aviso e libera nova tentativa —
              não muda o vínculo do Radar nem cadastra nada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500}
            placeholder="Ex.: no Omie o cliente certo é o 4242; o 5555 é duplicado e foi inativado." />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={nota.trim() === ''} onClick={(e) => { e.preventDefault(); void confirmar(); }}>
              Marcar como conferido
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * "N CNPJs com pendência Omie" — parte dos CONFLITOS, não da fila (que esconde já-clientes e descartados): depois de
 * esquecer o lote o conflito continua alcançável. Conta CNPJs distintos; erro aparece como indisponível, nunca zero.
 */
export function RadarConflitosIndicador({ onAbrir }: { onAbrir: (cnpj: string) => Promise<void> }) {
  const q = useRadarConflitosAbertos();
  const [aberto, setAberto] = useState(false);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  if (q.isError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-status-error/40 px-3 py-2 text-sm text-status-error">
        <AlertTriangle className="w-4 h-4 shrink-0" /> Pendências de cadastro no Omie: indisponível (não consegui ler os conflitos).
      </div>
    );
  }
  const grupos = porCnpj(q.data ?? []);
  if (grupos.size === 0) return null;

  const abrir = async (cnpj: string) => {
    setAbrindo(cnpj);
    try {
      await onAbrir(cnpj);
      setAberto(false);
    } catch (e) {
      toast.error('Não foi possível abrir a ficha', { description: e instanceof Error ? e.message : undefined });
    } finally {
      setAbrindo(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm">
        <AlertTriangle className="w-4 h-4 text-status-warning shrink-0" />
        <span className="flex-1">
          <strong>{grupos.size}</strong> {grupos.size === 1 ? 'CNPJ com pendência' : 'CNPJs com pendência'} de cadastro no Omie — conflito a conferir.
        </span>
        <Button size="sm" variant="outline" onClick={() => setAberto(true)}>Ver</Button>
      </div>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Pendências de cadastro no Omie</DialogTitle>
            <DialogDescription>
              Conflitos entre o Radar e o Omie que bloqueiam o cadastro. Abra a ficha, confira no Omie e marque como conferido.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 overflow-y-auto divide-y text-sm">
            {[...grupos.entries()].map(([cnpj, cs]) => (
              <li key={cnpj} className="flex items-start gap-2 py-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium tabular-nums">{cnpj}</div>
                  {cs.map((c) => <div key={c.id} className="text-xs text-muted-foreground">{resumoConflito(c)}</div>)}
                </div>
                <Button size="sm" variant="outline" disabled={abrindo !== null} onClick={() => { void abrir(cnpj); }}>
                  {abrindo === cnpj ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Abrir ficha'}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
