// Modal de upload/extração de anúncio de aumento (PDF/imagem → Gemini Vision).
// Extraído verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).
import { Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  arquivo: File | null;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancel: () => void;
  onExtrair: () => void;
  extraindo: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
}

export function UploadDialog({
  open,
  onOpenChange,
  arquivo,
  onFileChange,
  onCancel,
  onExtrair,
  extraindo,
  fileInputRef,
}: UploadDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload de anúncio de aumento</DialogTitle>
          <DialogDescription>
            Selecione um PDF ou imagem do comunicado. A IA vai extrair nome,
            data de vigência e categorias com percentual de aumento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={onFileChange}
            disabled={extraindo}
          />
          {arquivo && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{arquivo.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(arquivo.size / 1024).toFixed(1)} KB
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={extraindo}
          >
            Cancelar
          </Button>
          <Button onClick={onExtrair} disabled={!arquivo || extraindo}>
            {extraindo && <Loader2 className="h-4 w-4 animate-spin" />}
            Extrair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
