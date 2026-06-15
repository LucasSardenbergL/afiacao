import { useState } from 'react';
import { toast } from 'sonner';
import { Building2, ClipboardPlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useRadarCadastrarOmie, useRadarAtribuirTarefa } from '@/queries/useRadarAcoesLead';
import type { RadarEmpresa } from '@/queries/useRadarLista';

export function RadarAcoesLead({ empresa }: { empresa: RadarEmpresa }) {
  const { isImpersonating } = useImpersonation();
  const cadastrar = useRadarCadastrarOmie();
  const tarefa = useRadarAtribuirTarefa();
  const [confirmOmie, setConfirmOmie] = useState(false);
  const [dias, setDias] = useState('7');

  const doCadastrar = async () => {
    setConfirmOmie(false);
    try {
      const r = await cadastrar.mutateAsync(empresa);
      toast.success(r.ja_existia ? 'Já era cliente no Omie (Oben) — reconciliado' : `Cadastrado no Omie (Oben)${r.codigo_cliente ? ` · cód. ${r.codigo_cliente}` : ''}`);
    } catch (e) {
      toast.error('Não foi possível cadastrar', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const doTarefa = async () => {
    try {
      const n = Math.max(1, Math.min(Number(dias) || 7, 90));
      const r = await tarefa.mutateAsync({ cnpj: empresa.cnpj, diasRetomada: n });
      if (!r.deduped) toast.success('Tarefa criada pra você', { description: `Retomar em ${n} dia(s)` });
      else toast.info('Tarefa já existia (criada agora há pouco)');
    } catch (e) {
      toast.error('Não foi possível criar a tarefa', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const disabled = isImpersonating;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={disabled || cadastrar.isPending} onClick={() => setConfirmOmie(true)}
        title={disabled ? 'Indisponível em modo Ver como' : undefined}>
        {cadastrar.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Building2 className="w-4 h-4 mr-1" />}
        Cadastrar no Omie (Oben)
      </Button>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" disabled={disabled || tarefa.isPending} onClick={doTarefa}
          title={disabled ? 'Indisponível em modo Ver como' : undefined}>
          {tarefa.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ClipboardPlus className="w-4 h-4 mr-1" />}
          Criar tarefa pra mim
        </Button>
        <Label htmlFor="radar-dias" className="text-xs text-muted-foreground">retomar em</Label>
        <Input id="radar-dias" value={dias} onChange={(e) => setDias(e.target.value)} className="w-14 h-8" inputMode="numeric" />
        <span className="text-xs text-muted-foreground">dias</span>
      </div>

      <AlertDialog open={confirmOmie} onOpenChange={setConfirmOmie}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar no Omie (Oben)?</AlertDialogTitle>
            <AlertDialogDescription>
              {empresa.razao_social || empresa.cnpj} será cadastrada como cliente na conta <strong>Oben</strong>.
              Se o CNPJ já existir lá, apenas reconcilia (marca como já-cliente). Não cadastra nas outras empresas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doCadastrar}>Cadastrar na Oben</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
