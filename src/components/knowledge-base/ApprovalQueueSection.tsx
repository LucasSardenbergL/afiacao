import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useBatchExtract } from '@/hooks/useBatchExtract';
import { useBulkApproveSpecs } from '@/hooks/useBulkApproveSpecs';
import { useExtractionDrafts } from '@/hooks/useExtractionDrafts';
import { particionarResultados } from '@/lib/knowledge-base/aprovacao-fila';
import { mesclarResultados, docsParaExtrair } from '@/lib/knowledge-base/extraction-drafts';
import { KbSpecsForm } from '@/components/knowledge-base/KbSpecsForm';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

// ─── Sub-componente: item de revisão ─────────────────────────────────────────

interface RevisaoItemProps {
  resultado: ResultadoExtracao;
  /** Chamado quando o usuário salvar com sucesso no form de revisão */
  onRevisado: (documentId: string) => void;
  /** Chamado para re-extrair este documento (com custo explícito confirmado) */
  onReExtrair?: (documentId: string) => void;
  reExtraindoId?: string | null;
}

function RevisaoItem({ resultado, onRevisado, onReExtrair, reExtraindoId }: RevisaoItemProps) {
  const isReExtraindo = reExtraindoId === resultado.documentId;
  const [dialogAberto, setDialogAberto] = useState(false);
  const { spec, documentId } = resultado;

  const confiancaPct = Math.round((spec.extraction_confidence ?? 0) * 100);
  const qtdGaps = spec.extraction_gaps.length;

  // Constrói o motivo principal que levou à revisão
  const motivo = !spec.product_code
    ? 'Sem código de produto'
    : confiancaPct < 85
      ? `Confiança baixa (${confiancaPct}%)`
      : `${qtdGaps} campo(s) não extraído(s)`;

  return (
    <>
      <div className="flex items-center gap-3 py-2.5 px-3 border-b last:border-b-0">
        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />

        {/* Informações do produto */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {spec.product_name || '(sem nome)'}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {spec.product_code ? (
              <span className="text-xs text-muted-foreground font-mono">
                {spec.product_code}
              </span>
            ) : (
              <Badge variant="secondary" className="text-status-error text-[10px] px-1.5 py-0">
                Sem código
              </Badge>
            )}
            <Badge
              variant="secondary"
              className={`text-[10px] px-1.5 py-0 ${
                confiancaPct >= 70
                  ? 'text-status-warning'
                  : 'text-status-error'
              }`}
            >
              {confiancaPct}% confiança
            </Badge>
            {qtdGaps > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {qtdGaps} campo{qtdGaps !== 1 ? 's' : ''} faltando
              </span>
            )}
            <span className="text-[10px] text-status-warning">{motivo}</span>
          </div>
        </div>

        {/* Botão Re-extrair (com confirmação de custo) */}
        {onReExtrair && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 gap-1 h-7 text-xs text-muted-foreground"
                disabled={isReExtraindo}
              >
                {isReExtraindo ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Re-extrair
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Re-extrair ficha técnica?</AlertDialogTitle>
                <AlertDialogDescription>
                  Re-extrair vai gastar saldo da Anthropic de novo. Continuar?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={() => onReExtrair(documentId)}>
                  Re-extrair
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1 h-7 text-xs"
          onClick={() => setDialogAberto(true)}
        >
          Revisar
          <ChevronRight className="w-3 h-3" />
        </Button>
      </div>

      {/* Dialog de revisão com o form completo */}
      <Dialog open={dialogAberto} onOpenChange={setDialogAberto}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Revisar e aprovar ficha técnica</DialogTitle>
          </DialogHeader>
          <KbSpecsForm
            initialValues={spec}
            documentId={documentId}
            onSaved={() => {
              setDialogAberto(false);
              onRevisado(documentId);
              toast.success('Ficha aprovada com sucesso');
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

/**
 * Seção de fila de aprovação de boletins técnicos.
 *
 * Fluxo:
 *  1. Lista documentos `ready` sem ficha aprovada (useApprovalQueue).
 *  2. Hidrata rascunhos persistidos do banco (useExtractionDrafts) e mescla com sessão.
 *  3. Botão "Extrair pendentes" extrai SOMENTE os que não têm rascunho — os demais já
 *     estão no estado via hidratação.
 *  4. Resultados são particionados: alta confiança → aprovação em lote;
 *     baixa confiança / sem código → revisão manual (KbSpecsForm).
 *  5. "Re-extrair" por item: confirmação de custo → `run([id], { force: true })` →
 *     refetch dos drafts.
 */
export function ApprovalQueueSection() {
  const fila = useApprovalQueue();
  const extract = useBatchExtract();
  const bulk = useBulkApproveSpecs();
  const drafts = useExtractionDrafts();

  // IDs dos itens de revisão já salvos (removidos localmente antes do next refetch)
  const [revisadosIds, setRevisadosIds] = useState<Set<string>>(new Set());

  // ID do item em processo de re-extração individual
  const [reExtraindoId, setReExtraindoId] = useState<string | null>(null);

  // Mescla rascunhos do banco com os resultados da sessão atual (memória wins) e
  // RESTRINGE à fila atual: um rascunho órfão (DELETE best-effort que falhou após
  // aprovar) não deve reaparecer como item a aprovar.
  const filaIdsSet = new Set((fila.data ?? []).map((d) => d.id));
  const resultadosMesclados = mesclarResultados(drafts.drafts, extract.resultados).filter(
    (r) => filaIdsSet.has(r.documentId),
  );

  // Função chamada ao salvar um item de revisão manual
  function handleRevisado(documentId: string) {
    setRevisadosIds((prev) => new Set(prev).add(documentId));
    // DELETE best-effort do rascunho (já aprovado, limpa lixo do banco)
    bulk.deleteDraft(documentId).catch(() => {
      // Silencioso: rascunho orphan é inofensivo
    });
  }

  // Dispara extração SOMENTE para docs sem rascunho ready no banco
  async function handleExtrair() {
    const ids = (fila.data ?? []).map((d) => d.id);
    const pendentes = docsParaExtrair(ids, drafts.readyIds);
    if (pendentes.length === 0) return;
    await extract.run(pendentes);
    void drafts.refetch();
  }

  // Re-extrai um doc específico com force=true (ignora cache/claim existente)
  async function handleReExtrair(documentId: string) {
    setReExtraindoId(documentId);
    try {
      await extract.run([documentId], { force: true });
      void drafts.refetch();
    } finally {
      setReExtraindoId(null);
    }
  }

  // Aprova em lote os itens de alta confiança
  async function handleAprovarLote(auto: ResultadoExtracao[]) {
    const resultado = await bulk.approve(auto);
    const errosStr =
      resultado.erros.length > 0
        ? ` — ${resultado.erros.length} com erro`
        : '';
    toast.success(
      `${resultado.ok} ficha${resultado.ok !== 1 ? 's' : ''} aprovada${resultado.ok !== 1 ? 's' : ''}${errosStr}`,
    );
    // Remove SÓ as fichas auto-aprovadas COM SUCESSO do estado; mantém as 'a revisar' (e as que
    // falharam, pra retry). ⚠️ Antes era extract.reset() — apagava TUDO, e as fichas a revisar
    // sumiam ao aprovar o lote, forçando re-extração (gasto de API à toa). A fila recarrega via
    // invalidate do useBulkApproveSpecs.
    const falharam = new Set(resultado.erros.map((e) => e.documentId));
    extract.removerResultados(
      auto.filter((a) => !falharam.has(a.documentId)).map((a) => a.documentId),
    );
  }

  // ── Renderização: carregando ──
  if (fila.isLoading || drafts.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
        <span className="text-sm">Carregando fila…</span>
      </div>
    );
  }

  const docs = fila.data ?? [];
  const qtdFila = docs.length;

  // Quantos ainda precisam de extração (excluindo os que já têm rascunho ready)
  const pendentesExtrair = docsParaExtrair(
    docs.map((d) => d.id),
    drafts.readyIds,
  );
  const qtdPendentes = pendentesExtrair.length;

  // ── Renderização: fila vazia e sem resultados de extração ──
  if (qtdFila === 0 && resultadosMesclados.length === 0) {
    return (
      <Card className="p-8 text-center text-xs text-muted-foreground">
        <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-status-success opacity-70" />
        Nada pra aprovar — suba boletins na aba Documentos.
      </Card>
    );
  }

  // ── Particiona os resultados quando existem ──
  const { auto, revisar: revisarLista } = particionarResultados(resultadosMesclados);

  // Filtra os itens de revisão que já foram salvos localmente
  const revisarPendentes = revisarLista.filter(
    (r) => !revisadosIds.has(r.documentId),
  );

  const progresso =
    extract.total > 0 ? Math.round((extract.feitos / extract.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ── Header com contagem + botão de extração ── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-medium">
            {qtdFila} documento{qtdFila !== 1 ? 's' : ''} aguardando aprovação
          </span>
          {extract.rodando && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Extraindo fichas técnicas… {extract.feitos}/{extract.total}
            </p>
          )}
        </div>

        <Button
          size="sm"
          disabled={extract.rodando || qtdPendentes === 0}
          onClick={handleExtrair}
          className="gap-1.5 shrink-0"
        >
          {extract.rodando ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Extraindo…
            </>
          ) : (
            <>Extrair pendentes ({qtdPendentes})</>
          )}
        </Button>
      </div>

      {/* ── Barra de progresso durante extração ── */}
      {extract.rodando && (
        <div className="space-y-1">
          <Progress value={progresso} className="h-2" />
          <p className="text-xs text-muted-foreground text-right tabular-nums">
            {extract.feitos} / {extract.total}
          </p>
        </div>
      )}

      {/* ── Resultados: bloco de auto-aprovação ── */}
      {auto.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-b bg-muted/40">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-status-success" />
              <span className="text-sm font-medium">
                Prontas pra aprovar ({auto.length})
              </span>
              <span className="text-xs text-muted-foreground">
                Confiança ≥ 85% + código de produto
              </span>
            </div>

            <Button
              size="sm"
              disabled={bulk.isApproving}
              onClick={() => handleAprovarLote(auto)}
              className="gap-1.5 shrink-0"
            >
              {bulk.isApproving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Aprovando…
                </>
              ) : (
                <>Aprovar {auto.length}</>
              )}
            </Button>
          </div>

          {/* Lista compacta dos itens auto-aprovados */}
          <div className="divide-y">
            {auto.map(({ documentId, spec }) => (
              <div
                key={documentId}
                className="flex items-center gap-3 px-3 py-2"
              >
                <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate block">
                    {spec.product_name || '(sem nome)'}
                  </span>
                  {spec.product_code && (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {spec.product_code}
                    </span>
                  )}
                </div>
                <Badge
                  variant="secondary"
                  className="text-[10px] text-status-success px-1.5 py-0 shrink-0"
                >
                  {Math.round((spec.extraction_confidence ?? 0) * 100)}%
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Resultados: bloco de revisão manual ── */}
      {revisarPendentes.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b bg-muted/40">
            <AlertTriangle className="w-4 h-4 text-status-warning" />
            <span className="text-sm font-medium">
              Revisar ({revisarPendentes.length})
            </span>
            <span className="text-xs text-muted-foreground">
              Baixa confiança ou campos obrigatórios ausentes
            </span>
          </div>

          <div>
            {revisarPendentes.map((resultado) => (
              <RevisaoItem
                key={resultado.documentId}
                resultado={resultado}
                onRevisado={handleRevisado}
                onReExtrair={handleReExtrair}
                reExtraindoId={reExtraindoId}
              />
            ))}
          </div>
        </Card>
      )}

      {/* ── Aviso de erros de extração ── */}
      {extract.erros.length > 0 && (
        <Card className="p-3 bg-status-error-bg border-status-error">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-status-error shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-status-error">
                {extract.erros.length} documento{extract.erros.length !== 1 ? 's' : ''} falharam na extração
              </p>
              <ul className="text-[10px] text-muted-foreground space-y-0.5">
                {extract.erros.map(({ documentId, error }) => (
                  <li key={documentId} className="font-mono">
                    {documentId.slice(0, 8)}… — {error}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
