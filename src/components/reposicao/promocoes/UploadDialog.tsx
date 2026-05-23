// Modal de upload em lote de promoções (PDF/imagem → IA).
// Extraído de src/pages/AdminReposicaoPromocoes.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, FileText, CheckCircle2, XCircle, Clock, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { useUploadPromocoes } from "./useUploadPromocoes";

type UploadState = ReturnType<typeof useUploadPromocoes>;

export function UploadDialog({
  open, onOpenChange, upload, onIrParaLista, onCancelar,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  upload: UploadState;
  onIrParaLista: () => void;
  onCancelar: () => void;
}) {
  const {
    items, processando, fileInputRef, handleFileChange, removerItem, tentarNovamente, iniciarProcessamento,
    totalItens, concluidos, comErro, aguardando, emProcesso, finalizados, progresso, todosFinalizados, podeIniciar,
  } = upload;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload de promoções (lote)</DialogTitle>
          <DialogDescription>
            Selecione um ou mais PDFs/imagens da promoção do fornecedor. A IA extrai
            nome, datas e itens automaticamente. Cada arquivo gera uma campanha em rascunho.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={handleFileChange}
            disabled={processando}
          />

          {totalItens > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {finalizados} de {totalItens} processados
                  {emProcesso > 0 && ` · ${emProcesso} em andamento`}
                </span>
                <span className="font-medium tabular-nums">{progresso}%</span>
              </div>
              <Progress value={progresso} className="h-2" />
            </div>
          )}

          {totalItens > 0 && (
            <TooltipProvider>
              <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
                {items.map((it) => (
                  <div key={it.id} className="flex items-center gap-2 p-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{it.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(it.file.size / 1024).toFixed(1)} KB
                        {it.status === "concluido" && it.nomeCampanha && (
                          <> · {it.nomeCampanha} · {it.itensExtraidos} {it.itensExtraidos === 1 ? "item" : "itens"}</>
                        )}
                        {it.status === "erro" && it.erro && (
                          <span className="text-destructive"> · Extração falhou: {it.erro}</span>
                        )}
                      </p>
                    </div>

                    {it.status === "aguardando" && (
                      <Badge variant="outline" className="gap-1">
                        <Clock className="h-3 w-3" /> Aguardando
                      </Badge>
                    )}
                    {it.status === "processando" && (
                      <Badge variant="outline" className="gap-1 bg-status-info/15 text-status-info border-status-info/30">
                        <Loader2 className="h-3 w-3 animate-spin" /> Processando
                      </Badge>
                    )}
                    {it.status === "concluido" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className={cn(
                              "gap-1 cursor-help",
                              "bg-status-success/15 text-status-success border-status-success/30",
                            )}
                          >
                            <CheckCircle2 className="h-3 w-3" /> Concluído
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          {it.confianca !== null && it.confianca !== undefined
                            ? `Confiança Gemini: ${Math.round(it.confianca * 100)}%`
                            : "Confiança não informada"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {it.status === "erro" && (
                      <Badge variant="outline" className="gap-1 bg-destructive/15 text-destructive border-destructive/30">
                        <XCircle className="h-3 w-3" /> Erro
                      </Badge>
                    )}

                    {it.status === "erro" && !processando && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => tentarNovamente(it.id)}
                        title="Tentar novamente"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {(it.status === "aguardando" || it.status === "erro") && !processando && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => removerItem(it.id)}
                        title="Remover"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </TooltipProvider>
          )}

          {todosFinalizados && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">
                {concluidos} de {totalItens}{" "}
                {totalItens === 1 ? "campanha criada" : "campanhas criadas"} com sucesso.
                {comErro > 0 && (
                  <span className="text-destructive">
                    {" "}{comErro} {comErro === 1 ? "campanha" : "campanhas"} com erro.
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                As campanhas ficam em rascunho. Acesse a lista para revisar e ativar.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {todosFinalizados ? (
            <Button onClick={onIrParaLista}>
              Ir para lista
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onCancelar} disabled={processando}>
                {processando ? "Processando…" : "Cancelar"}
              </Button>
              <Button onClick={iniciarProcessamento} disabled={!podeIniciar}>
                {processando && <Loader2 className="h-4 w-4 animate-spin" />}
                {comErro > 0 && aguardando === 0
                  ? `Tentar novamente (${comErro})`
                  : `Processar ${aguardando + comErro} ${aguardando + comErro === 1 ? "arquivo" : "arquivos"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
