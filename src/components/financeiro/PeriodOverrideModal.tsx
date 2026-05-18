import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePeriodOverride } from '@/hooks/usePeriodOverride';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company: string;
  ano: number;
  mes: number;
  onOverrideOpened?: () => void;
};

export function PeriodOverrideModal({ open, onOpenChange, company, ano, mes, onOverrideOpened }: Props) {
  const { isMaster } = useAuth();
  const { openOverride } = usePeriodOverride(company);
  const [justificativa, setJustificativa] = useState('');
  const [acaoPlanejada, setAcaoPlanejada] = useState('');

  if (!isMaster) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permissão insuficiente</DialogTitle>
            <DialogDescription>
              Apenas usuários master podem abrir override de período fechado. Peça pra quem tem permissão.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const submit = async () => {
    if (justificativa.trim().length < 10 || acaoPlanejada.trim().length < 10) {
      toast.error('Justificativa e ação planejada precisam ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await openOverride.mutateAsync({ ano, mes, justificativa, acao_planejada: acaoPlanejada });
      toast.success(`Override aberto por 15 min — ${String(mes).padStart(2, '0')}/${ano} de ${company}`);
      setJustificativa('');
      setAcaoPlanejada('');
      onOpenChange(false);
      onOverrideOpened?.();
    } catch (err) {
      toast.error(`Falha ao abrir override: ${String((err as Error).message ?? err)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override de emergência</DialogTitle>
          <DialogDescription>
            Abre uma janela de 15 min pra editar lançamentos do período fechado <strong>{String(mes).padStart(2,'0')}/{ano}</strong> da empresa <strong>{company}</strong>. Toda mudança é gravada no audit com sua justificativa.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="justificativa">Justificativa (mín. 10 chars)</Label>
            <Textarea
              id="justificativa"
              value={justificativa}
              onChange={e => setJustificativa(e.target.value)}
              placeholder="Ex: lançamento de R$X esquecido pela contabilidade externa, NF 1234"
              rows={3}
            />
          </div>
          <div>
            <Label htmlFor="acao">Ação planejada (mín. 10 chars)</Label>
            <Input
              id="acao"
              value={acaoPlanejada}
              onChange={e => setAcaoPlanejada(e.target.value)}
              placeholder="Ex: inserir CP de Honorários R$2.500 em 15/01"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={submit} disabled={openOverride.isPending}>
            {openOverride.isPending ? 'Abrindo…' : 'Abrir override (15 min)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
