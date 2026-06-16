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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import {
  useAddMembro,
  documentoValido,
  normalizarDocumento,
  type RelationType,
} from '@/queries/useClienteGrupos';

interface AddDocumentoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grupoId: string;
  grupoNome: string;
}

const RELATION_LABELS: Record<RelationType, string> = {
  incerto: 'Incerto (só agrupar)',
  multi_ativo: 'Multi-CNPJ ativo (fatura junto)',
  sucessao: 'Sucessão (encerrou um, abriu outro)',
};

export function AddDocumentoDialog({ open, onOpenChange, grupoId, grupoNome }: AddDocumentoDialogProps) {
  const [documento, setDocumento] = useState('');
  const [relationType, setRelationType] = useState<RelationType>('incerto');
  const [note, setNote] = useState('');
  const addMembro = useAddMembro();

  useEffect(() => {
    if (open) {
      setDocumento('');
      setRelationType('incerto');
      setNote('');
    }
  }, [open]);

  const digits = normalizarDocumento(documento);
  const valido = documentoValido(documento);

  const handleAdd = async () => {
    if (!valido) {
      toast.error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).');
      return;
    }
    try {
      await addMembro.mutateAsync({ grupoId, documento, relationType, note: note.trim() || null });
      toast.success('Documento adicionado ao grupo.');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não consegui adicionar o documento.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar documento</DialogTitle>
          <DialogDescription>Vincula um CNPJ/CPF ao grupo «{grupoNome}».</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="doc">CNPJ ou CPF</Label>
            <Input
              id="doc"
              value={documento}
              onChange={(e) => setDocumento(e.target.value)}
              placeholder="00.000.000/0000-00 ou 000.000.000-00"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {digits.length > 0
                ? valido
                  ? `${digits.length === 11 ? 'CPF' : 'CNPJ'} válido (${digits.length} dígitos)`
                  : `${digits.length} dígitos — precisa ser 11 (CPF) ou 14 (CNPJ)`
                : 'Pode colar formatado; eu normalizo pra dígitos.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rel">Tipo de relação</Label>
            <Select value={relationType} onValueChange={(v) => setRelationType(v as RelationType)}>
              <SelectTrigger id="rel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RELATION_LABELS) as RelationType[]).map((rt) => (
                  <SelectItem key={rt} value={rt}>
                    {RELATION_LABELS[rt]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note">Nota (opcional)</Label>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Por que este documento é o mesmo dono."
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={addMembro.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleAdd} disabled={addMembro.isPending || !valido} className="gap-2">
            {addMembro.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
