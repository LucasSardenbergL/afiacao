import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { KbSpecsForm } from './KbSpecsForm';
import {
  diffVersions,
  inferirChangeTypeDoDiff,
  type DiffTipo,
  type CampoDiff,
} from '@/lib/knowledge-base/version-diff';
import { rotularCampo, formatarValorCampo, rotularChangeType } from '@/lib/knowledge-base/campo-labels';
import { useSaveProductSpecs } from '@/hooks/useSaveProductSpecs';
import { useSpecVersions } from '@/hooks/useSpecVersions';
import { toast } from 'sonner';
import { Pencil, Loader2, Save, ArrowLeft } from 'lucide-react';
import type { KbProductSpec, KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

const COR: Record<DiffTipo, string> = {
  added: 'text-status-success',
  removed: 'text-status-error',
  changed: 'text-status-warning',
};
const SIMBOLO: Record<DiffTipo, string> = { added: '+', removed: '−', changed: '~' };

const valorVazio = (v: unknown): boolean =>
  v == null || (Array.isArray(v) && v.length === 0) || v === '';

/**
 * Fase B2: corrigir/completar uma ficha aprovada pela tela, gerando uma nova versão
 * (change_type inferido pelo diff). Dialog em 2 passos: editar → revisar (diff + motivo) → gravar.
 * A escrita passa pela RPC aprovar_versao_boletim (master-only, validada na Fase A).
 */
export function KbSpecsEditButton({ spec, onSaved }: { spec: KbProductSpec; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [editado, setEditado] = useState<KbExtractedSpec | null>(null);
  const [motivo, setMotivo] = useState('');
  const save = useSaveProductSpecs();
  const { data: versions } = useSpecVersions(spec.supplier, spec.product_code);

  // A ficha atual como KbExtractedSpec — base do form e do diff. (KbProductSpec é superset.)
  const fichaAtual = { ...spec, extraction_gaps: spec.extraction_gaps ?? [] } as KbExtractedSpec;
  const proximaVersao = (versions?.[0]?.version_number ?? 0) + 1;

  const reset = () => {
    setStep('edit');
    setEditado(null);
    setMotivo('');
  };
  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) reset();
  };

  // O form devolve os specs montados; aqui calculamos o diff e abrimos o preview.
  const handleFormSubmit = (specs: KbExtractedSpec) => {
    const d = diffVersions(fichaAtual, specs);
    if (d.length === 0) {
      toast.info('Nenhuma alteração', { description: 'Você não mudou nenhum campo.' });
      return;
    }
    setEditado(specs);
    setStep('preview');
  };

  const diff: CampoDiff[] = editado ? diffVersions(fichaAtual, editado) : [];
  const changeType = diff.length > 0 ? inferirChangeTypeDoDiff(diff) : 'data_completion';

  const handleConfirm = () => {
    if (!editado || !motivo.trim()) return;
    // Campos que o founder acabou de preencher deixam de ser "gaps" → limpa o extraction_gaps
    // pra o selo/aba de completude refletir o que foi completado (camposFaltantes olha os gaps).
    const gapsAtualizados = (editado.extraction_gaps ?? []).filter((campo) =>
      valorVazio((editado as Record<string, unknown>)[campo]),
    );
    save.mutate(
      {
        specs: { ...editado, extraction_gaps: gapsAtualizados },
        documentId: spec.document_id ?? undefined,
        changeType,
        changeNote: motivo.trim(),
      },
      {
        onSuccess: () => {
          handleOpenChange(false);
          onSaved?.();
        },
      },
    );
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Pencil className="w-3.5 h-3.5" />
        Corrigir / Completar ficha
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {step === 'edit' ? (
            <>
              <DialogHeader>
                <DialogTitle>Corrigir / Completar ficha</DialogTitle>
                <DialogDescription>
                  Edite os campos de <strong>{spec.product_name}</strong> ({spec.product_code}). Código e
                  fornecedor ficam travados (são a identidade). Ao revisar, você vê o que muda antes de gravar a
                  nova versão.
                </DialogDescription>
              </DialogHeader>
              {/* initialValues = editado (se voltou do preview) preserva as edições; senão a ficha atual */}
              <KbSpecsForm
                initialValues={editado ?? fichaAtual}
                lockIdentity
                submitLabel="Revisar mudança"
                onSubmitOverride={handleFormSubmit}
              />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Revisar mudança · v{proximaVersao}</DialogTitle>
                <DialogDescription>
                  Será registrado como <strong>{rotularChangeType(changeType)}</strong>. Confira o que muda e
                  escreva o motivo.
                </DialogDescription>
              </DialogHeader>

              <Card className="p-3">
                <ul className="space-y-0.5">
                  {diff.map((d) => (
                    <li key={d.campo} className="flex items-baseline gap-1.5 text-2xs">
                      <span className={`${COR[d.tipo]} font-bold w-3 shrink-0 tabular-nums`}>{SIMBOLO[d.tipo]}</span>
                      <span className="font-medium">{rotularCampo(d.campo)}:</span>
                      <span className="text-muted-foreground">
                        {formatarValorCampo(d.de)} <span className="opacity-50">→</span> {formatarValorCampo(d.para)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>

              <div>
                <Label htmlFor="motivo-mudanca" className="text-xs">
                  Motivo da mudança *
                </Label>
                <Textarea
                  id="motivo-mudanca"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ex: catalisador atualizado conforme boletim 2024 da Sayerlack"
                  className="text-xs min-h-[60px]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep('edit')} className="gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> Voltar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!motivo.trim() || save.isPending}
                  className="gap-1.5"
                >
                  {save.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  Confirmar e gravar
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
