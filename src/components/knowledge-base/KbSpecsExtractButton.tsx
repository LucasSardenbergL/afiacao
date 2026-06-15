import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useExtractSpecs } from '@/hooks/useExtractSpecs';
import { KbSpecsForm } from './KbSpecsForm';
import { Sparkles, Loader2 } from 'lucide-react';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

interface Props {
  documentId: string;
  documentTitle: string;
  productCode?: string | null;
  onSaved?: () => void;
}

/**
 * Botão "Extrair specs com IA" → invoca Claude → abre Dialog com KbSpecsForm
 * pré-preenchido pra admin revisar e aprovar.
 */
export function KbSpecsExtractButton({ documentId, documentTitle, productCode, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [extracted, setExtracted] = useState<KbExtractedSpec | null>(null);
  const extract = useExtractSpecs();

  const handleExtract = () => {
    extract.mutate(documentId, {
      onSuccess: (data) => {
        setExtracted(data.specs ?? null);
        setOpen(data.specs != null);
      },
    });
  };

  const handleSaved = () => {
    setOpen(false);
    setExtracted(null);
    onSaved?.();
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleExtract}
        disabled={extract.isPending}
        className="gap-1.5"
      >
        {extract.isPending ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Extraindo…
          </>
        ) : (
          <>
            <Sparkles className="w-3.5 h-3.5" />
            Extrair specs com IA
          </>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Revisar specs extraídos</DialogTitle>
            <DialogDescription>
              Claude analisou <strong>{documentTitle}</strong>
              {productCode && <> ({productCode})</>} e propôs os valores abaixo. Revise antes de aprovar — campos com confiança baixa ou faltantes estão sinalizados.
            </DialogDescription>
          </DialogHeader>

          {extracted && (
            <KbSpecsForm
              initialValues={extracted}
              documentId={documentId}
              onSaved={handleSaved}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
