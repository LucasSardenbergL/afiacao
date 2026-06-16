import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { useCreateGrupo, useUpdateGrupo, type ClienteGrupo } from '@/queries/useClienteGrupos';

interface GrupoFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Quando presente, edita; senão, cria. */
  grupo?: Pick<ClienteGrupo, 'id' | 'nome' | 'notas'>;
  /** Recebe o id do grupo criado (útil pra navegar pro 360). */
  onCreated?: (grupoId: string) => void;
}

export function GrupoFormDialog({ open, onOpenChange, grupo, onCreated }: GrupoFormDialogProps) {
  const editando = !!grupo;
  const [nome, setNome] = useState('');
  const [notas, setNotas] = useState('');
  const createGrupo = useCreateGrupo();
  const updateGrupo = useUpdateGrupo();
  const salvando = createGrupo.isPending || updateGrupo.isPending;

  useEffect(() => {
    if (open) {
      setNome(grupo?.nome ?? '');
      setNotas(grupo?.notas ?? '');
    }
  }, [open, grupo]);

  const handleSalvar = async () => {
    const nomeTrim = nome.trim();
    if (!nomeTrim) {
      toast.error('Dê um nome ao grupo (o nome do dono).');
      return;
    }
    try {
      if (editando && grupo) {
        await updateGrupo.mutateAsync({ id: grupo.id, nome: nomeTrim, notas: notas.trim() || null });
        toast.success('Grupo atualizado.');
      } else {
        const id = await createGrupo.mutateAsync({ nome: nomeTrim, notas: notas.trim() || null });
        toast.success('Grupo criado.');
        onCreated?.(id);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não consegui salvar o grupo.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editando ? 'Editar grupo' : 'Novo grupo de cliente'}</DialogTitle>
          <DialogDescription>
            Um grupo é a identidade única de um dono — junta os CNPJs/CPFs dele nas 3 empresas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="grupo-nome">Nome do dono / grupo</Label>
            <Input
              id="grupo-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: João da Silva (Marcenaria + Esquadrias)"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="grupo-notas">Notas (opcional)</Label>
            <Textarea
              id="grupo-notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Contexto: por que estes documentos são o mesmo dono."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={handleSalvar} disabled={salvando} className="gap-2">
            {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
            {editando ? 'Salvar' : 'Criar grupo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
