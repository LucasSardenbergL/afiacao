import { useMemo, useState } from 'react';
import { UserX } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  impedimentoDoDesligamento,
  opcoesNovoDono,
  resumoDoDesligamento,
  type MembroEquipe,
} from '@/lib/governanca/desligamento';
import { useDesligarFuncionario } from '@/lib/governanca/useDesligarFuncionario';

type Props = { alvo: MembroEquipe; equipe: MembroEquipe[] };

/**
 * Botão + confirmação do desligamento (só master — o servidor também barra).
 * Revoga papel, flag de equipe e perfil comercial, transfere carteira/cobrança/tarefas para quem o
 * master escolher, encerra coberturas, remove o ramal e bloqueia o login. Nada do histórico se apaga.
 */
export function DesligarFuncionarioDialog({ alvo, equipe }: Props) {
  // Escrita/identidade sempre pelo useAuth REAL (lente "Ver como" é só leitura).
  const { user, isMaster } = useAuth();
  const { isImpersonating } = useImpersonation();
  const desligar = useDesligarFuncionario();
  const [aberto, setAberto] = useState(false);
  const [novoDono, setNovoDono] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [confirmacao, setConfirmacao] = useState('');

  const eu = useMemo<MembroEquipe | null>(
    () => (user ? { user_id: user.id, name: 'Eu (master)' } : null),
    [user],
  );
  const opcoes = useMemo(() => opcoesNovoDono(equipe, alvo.user_id, eu), [equipe, alvo.user_id, eu]);
  const impedimento = impedimentoDoDesligamento({ nomeAlvo: alvo.name, confirmacao, motivo, novoDono });

  if (!isMaster || user?.id === alvo.user_id) return null;

  const fechar = (v: boolean) => {
    if (desligar.isPending) return;
    setAberto(v);
    if (!v) { setNovoDono(null); setMotivo(''); setConfirmacao(''); }
  };

  const confirmar = () => {
    if (impedimento || !novoDono) return;
    desligar.mutate(
      { userId: alvo.user_id, novoDonoUserId: novoDono, motivo: motivo.trim() },
      {
        onSuccess: (r) => {
          const resumo = resumoDoDesligamento(r.resumo);
          toast.success(
            r.status === 'ja_desligado' ? `${alvo.name} já estava desligado — login bloqueado.` : `${alvo.name} desligado.`,
            { description: resumo ? `Transferido: ${resumo}.` : undefined },
          );
          fechar(false);
        },
        onError: (e) => toast.error('Desligamento não concluído', { description: e.message }),
      },
    );
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-status-error"
        disabled={isImpersonating}
        title={isImpersonating ? 'Na lente "Ver como" a tela é só leitura' : undefined}
        onClick={() => setAberto(true)}
      >
        <UserX className="w-3.5 h-3.5 mr-1" />
        Desligar
      </Button>
      <AlertDialog open={aberto} onOpenChange={fechar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desligar {alvo.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tira o acesso de equipe e o perfil comercial, transfere a carteira, a cobrança e as tarefas abertas,
              encerra coberturas, remove o ramal e bloqueia o login. O histórico (pedidos, contatos, ligações)
              continua atribuído a ele.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Quem recebe a carteira</Label>
              <Select value={novoDono ?? ''} onValueChange={setNovoDono}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Escolha um colega" /></SelectTrigger>
                <SelectContent>
                  {opcoes.map((o) => (
                    <SelectItem key={o.user_id} value={o.user_id}>{o.name ?? o.user_id.slice(0, 8)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Motivo</Label>
              <Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={500} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Digite <span className="font-semibold">{alvo.name}</span> para confirmar</Label>
              <Input value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} className="h-8 text-xs" />
            </div>
            {impedimento && <p className="text-xs text-muted-foreground">{impedimento}</p>}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={desligar.isPending}>Cancelar</AlertDialogCancel>
            <Button variant="destructive" disabled={!!impedimento || desligar.isPending || isImpersonating} onClick={confirmar}>
              {desligar.isPending ? 'Desligando…' : 'Desligar'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
