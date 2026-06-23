import { useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import Papa from 'papaparse';
import { useDirectTintImport } from '@/hooks/useDirectTintImport';
import {
  ACCOUNT, MAX_RETRIES, getChunkSize, sha256, sendChunkWithRetry,
  type TintImportChunkResult, type TintSyncResult, type TintImportacaoRow,
  type TintImportFileResult, type FileWithPreview,
} from '@/components/tintImport/types';
import { useImportHistory, useTintProductCounts } from '@/components/tintImport/queries';
import { SyncCard } from '@/components/tintImport/SyncCard';
import { ImportCard } from '@/components/tintImport/ImportCard';
import { HistoryTable } from '@/components/tintImport/HistoryTable';

export default function TintImport() {
  const [tipo, setTipo] = useState('');
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [chunkProgress, setChunkProgress] = useState({ currentFile: 0, totalFiles: 0, fileName: '', currentChunk: 0, totalChunks: 0 });
  const [results, setResults] = useState<TintImportFileResult[]>([]);
  const [importMode, setImportMode] = useState<'auto' | 'edge' | 'direct' | 'rpc'>('auto');
  const queryClient = useQueryClient();
  const { data: history, isLoading: histLoading } = useImportHistory();
  const { data: tintCounts } = useTintProductCounts();
  const { runDirectImport, running: directRunning, progress: directProgress, cancel: cancelDirect } = useDirectTintImport();
  const [searchParams] = useSearchParams();
  // Break-glass: importação manual por CSV APOSENTADA (o catálogo agora é automático via
  // sync do Sayersystem). O ImportCard + histórico só aparecem com ?csv=emergencia.
  // Prazo de remoção: 2026-07-13 (deadline test no CI dispara). Ver docs/runbooks/tint-sync-corte-csv.md.
  const csvEmergencia = searchParams.get('csv') === 'emergencia';

  const handleFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const parsed: FileWithPreview[] = [];
    for (const file of Array.from(selected)) {
      const rawText = await file.text();
      const lines = rawText.split(/\r?\n/).filter(l => l.trim());
      const preview = lines.slice(0, 6).map(l => l.split(';'));
      parsed.push({ file, preview, name: file.name, rawText });
    }
    setFiles(parsed);
    setResults([]);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await invokeFunction<TintSyncResult>('tint-omie-sync', { action: 'sync_tint_products' });
      const total = res.total_sincronizado ?? res.totalSynced ?? 0;
      toast.success(`${total} produtos tintométricos sincronizados`);
      queryClient.invalidateQueries({ queryKey: ['tint'] });
      queryClient.invalidateQueries({ queryKey: ['tint-product-counts'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  const shouldUseDirect = useCallback((fileRawText: string): boolean => {
    if (importMode === 'direct' || importMode === 'rpc') return true;
    if (importMode === 'edge') return false;
    const lineCount = fileRawText.split(/\r?\n/).filter(l => l.trim()).length - 1;
    return lineCount >= 500;
  }, [importMode]);

  const handleImportWithMode = async () => {
    if (!tipo) { toast.error('Selecione o tipo de importação'); return; }
    if (files.length === 0) { toast.error('Selecione ao menos um arquivo'); return; }
    const noneDirect = files.every(f => !shouldUseDirect(f.rawText));
    if (noneDirect) { await handleImport(); return; }
    const allResults: TintImportFileResult[] = [];
    for (const f of files) {
      if (shouldUseDirect(f.rawText)) {
        try {
          const useRpc = importMode === 'rpc' || (importMode === 'auto' && (tipo === 'formulas_padrao' || tipo === 'formulas_personalizadas'));
          const result = await runDirectImport(f.rawText, f.name, tipo, useRpc);
          allResults.push({ name: f.name, status: result.status, imported: result.imported, updated: result.updated, errors: result.errors });
        } catch (err) {
          allResults.push({ name: f.name, status: 'erro', error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        const formData = new FormData();
        formData.append('file', f.file);
        formData.append('tipo', tipo);
        formData.append('account', ACCOUNT);
        try {
          const res = await invokeFunction<TintImportChunkResult>('tint-import', formData);
          allResults.push({ name: f.name, ...res });
        } catch (err) {
          allResults.push({ name: f.name, status: 'erro', error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    setResults(allResults);
    queryClient.invalidateQueries({ queryKey: ['tint'] });
    queryClient.invalidateQueries({ queryKey: ['tint-import-history'] });
    toast.success('Importação finalizada');
  };

  const finalizeImport = async (importacaoId: string, totalImported: number, totalUpdated: number, totalErrors: number, failedChunks: number) => {
    try {
      await invokeFunction('tint-import', {
        action: 'finalize_import',
        importacao_id: importacaoId,
        registros_importados: totalImported,
        registros_atualizados: totalUpdated,
        registros_erro: totalErrors,
        failed_chunks: failedChunks,
      });
      console.log(`Import ${importacaoId} finalized: ${totalImported} imported, ${totalUpdated} updated, ${totalErrors} errors, ${failedChunks} failed chunks`);
    } catch (err) {
      console.error('Failed to finalize import:', err);
    }
  };

  const handleImport = async () => {
    if (!tipo) { toast.error('Selecione o tipo de importação'); return; }
    if (files.length === 0) { toast.error('Selecione ao menos um arquivo'); return; }

    setImporting(true);
    const allResults: TintImportFileResult[] = [];

    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];

      const parseResult = Papa.parse<string[]>(f.rawText, {
        delimiter: ';',
        skipEmptyLines: true,
      });

      const allRows = parseResult.data;
      if (allRows.length < 2) {
        allResults.push({ name: f.name, status: 'erro', error: 'CSV vazio ou sem dados' });
        continue;
      }

      const dataRows = allRows.slice(1);
      const totalRows = dataRows.length;

      const chunkSize = getChunkSize(tipo);
      // For small files (≤ chunkSize), use legacy multipart mode
      if (totalRows <= chunkSize) {
        setChunkProgress({ currentFile: fi + 1, totalFiles: files.length, fileName: f.name, currentChunk: 1, totalChunks: 1 });
        const formData = new FormData();
        formData.append('file', f.file);
        formData.append('tipo', tipo);
        formData.append('account', ACCOUNT);
        try {
          const res = await invokeFunction<TintImportChunkResult>('tint-import', formData);
          allResults.push({ name: f.name, ...res });
        } catch (err) {
          allResults.push({ name: f.name, status: 'erro', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      // Large file: chunk mode
      const hash = await sha256(f.rawText);
      const chunks: string[][][] = [];
      for (let i = 0; i < totalRows; i += chunkSize) {
        chunks.push(dataRows.slice(i, i + chunkSize));
      }
      const totalChunks = chunks.length;

      let importacaoId: string | null = null;
      let totalImported = 0;
      let totalUpdated = 0;
      let totalErrors = 0;
      let failedChunks = 0;
      let lastError: string | null = null;

      // Step 1: Create import record
      try {
        setChunkProgress({ currentFile: fi + 1, totalFiles: files.length, fileName: f.name, currentChunk: 0, totalChunks });
        console.log(`Creating import record for ${f.name} (${totalRows} rows, ${totalChunks} chunks)`);
        const createRes = await invokeFunction<TintImportChunkResult>('tint-import', {
          action: 'create_import',
          tipo,
          account: ACCOUNT,
          arquivo_hash: hash,
          arquivo_nome: f.name,
          total_rows: totalRows,
        });

        if (createRes.status === 'duplicado') {
          console.log(`File ${f.name} already imported, skipping`);
          allResults.push({ name: f.name, ...createRes });
          continue;
        }

        importacaoId = createRes.importacao_id ?? null;
        console.log(`Import record created: ${importacaoId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allResults.push({ name: f.name, status: 'erro', error: `Falha ao criar importação: ${msg}` });
        continue;
      }

      if (!importacaoId) {
        allResults.push({ name: f.name, status: 'erro', error: 'Não foi possível obter o ID da importação' });
        continue;
      }

      // Step 2: Send data chunks with retry
      for (let ci = 0; ci < totalChunks; ci++) {
        setChunkProgress({ currentFile: fi + 1, totalFiles: files.length, fileName: f.name, currentChunk: ci + 1, totalChunks });

        const body: Record<string, unknown> = {
          tipo,
          account: ACCOUNT,
          chunk_index: ci,
          total_chunks: totalChunks,
          total_rows: totalRows,
          rows: chunks[ci],
          importacao_id: importacaoId,
        };

        try {
          const res = await sendChunkWithRetry(body, ci, totalChunks);
          totalImported += res.registros_importados ?? 0;
          totalUpdated += res.registros_atualizados ?? 0;
          totalErrors += res.registros_erro ?? 0;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          failedChunks++;
          totalErrors += chunks[ci].length;
          console.error(`Chunk ${ci + 1}/${totalChunks}: ABANDONADO após ${MAX_RETRIES} tentativas`);
          // Continue with next chunk
        }
      }

      // Step 3: Finalize import regardless of failures
      await finalizeImport(importacaoId, totalImported, totalUpdated, totalErrors, failedChunks);

      const status = totalErrors > 0 && totalImported === 0 && totalUpdated === 0
        ? 'erro'
        : failedChunks > 0 ? 'concluido_parcial' : totalErrors > 0 ? 'parcial' : 'concluido';

      allResults.push({
        name: f.name,
        status,
        importacao_id: importacaoId,
        total_registros: totalRows,
        registros_importados: totalImported,
        registros_atualizados: totalUpdated,
        registros_erro: totalErrors,
        failed_chunks: failedChunks,
        error: lastError,
      });
    }

    setResults(allResults);
    setImporting(false);
    queryClient.invalidateQueries({ queryKey: ['tint'] });
    queryClient.invalidateQueries({ queryKey: ['tint-import-history'] });
    toast.success('Importação finalizada');
  };

  const handleResume = async (imp: TintImportacaoRow) => {
    if (!imp.tipo || !imp.id) return;
    setResumingId(imp.id);

    // We need the user to re-select the file to get the data rows
    toast.info('Selecione o mesmo arquivo CSV para retomar a importação, depois clique em "Retomar" novamente.');

    if (files.length === 0) {
      setResumingId(null);
      return;
    }

    // Find matching file by name
    const matchingFile = files.find(f => f.name === imp.arquivo_nome);
    if (!matchingFile) {
      toast.error(`Selecione o arquivo "${imp.arquivo_nome}" para retomar`);
      setResumingId(null);
      return;
    }

    setImporting(true);

    const parseResult = Papa.parse<string[]>(matchingFile.rawText, {
      delimiter: ';',
      skipEmptyLines: true,
    });

    const dataRows = parseResult.data.slice(1);
    const totalRows = dataRows.length;
    const alreadyProcessed = (imp.registros_importados ?? 0) + (imp.registros_atualizados ?? 0) + (imp.registros_erro ?? 0);

    // Skip already-processed rows, then chunk the remainder
    const remainingRows = dataRows.slice(alreadyProcessed);
    if (remainingRows.length === 0) {
      toast.info('Todas as linhas deste arquivo já foram processadas.');
      setImporting(false);
      setResumingId(null);
      return;
    }

    const resumeChunkSize = getChunkSize(imp.tipo);
    const chunks: string[][][] = [];
    for (let i = 0; i < remainingRows.length; i += resumeChunkSize) {
      chunks.push(remainingRows.slice(i, i + resumeChunkSize));
    }
    const totalChunks = chunks.length;
    // The absolute chunk index for the edge function (so it knows position in the full file)
    const baseChunkIndex = Math.floor(alreadyProcessed / resumeChunkSize);

    console.log(`Resuming import ${imp.id}: ${alreadyProcessed} already processed, ${remainingRows.length} remaining in ${totalChunks} chunks`);

    let totalImported = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    let failedChunks = 0;

    for (let ci = 0; ci < totalChunks; ci++) {
      setChunkProgress({ currentFile: 1, totalFiles: 1, fileName: matchingFile.name, currentChunk: ci + 1, totalChunks });

      const absoluteChunkIndex = baseChunkIndex + ci;
      const body: Record<string, unknown> = {
        tipo: imp.tipo,
        account: ACCOUNT,
        chunk_index: absoluteChunkIndex,
        total_chunks: baseChunkIndex + totalChunks,
        total_rows: totalRows,
        rows: chunks[ci],
        importacao_id: imp.id,
      };

      try {
        const res = await sendChunkWithRetry(body, absoluteChunkIndex, baseChunkIndex + totalChunks);
        totalImported += res.registros_importados ?? 0;
        totalUpdated += res.registros_atualizados ?? 0;
        totalErrors += res.registros_erro ?? 0;
      } catch {
        failedChunks++;
        totalErrors += chunks[ci].length;
        console.error(`Chunk ${ci + 1}/${totalChunks}: ABANDONADO após ${MAX_RETRIES} tentativas`);
      }
    }

    // Finalize
    await finalizeImport(imp.id, totalImported, totalUpdated, totalErrors, failedChunks);

    setImporting(false);
    setResumingId(null);
    queryClient.invalidateQueries({ queryKey: ['tint-import-history'] });
    toast.success('Retomada finalizada');
  };

  const progressPct = chunkProgress.totalChunks > 0
    ? ((chunkProgress.currentChunk / chunkProgress.totalChunks) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Produtos &amp; Sincronização</h1>

      <SyncCard syncing={syncing} onSync={handleSync} tintCounts={tintCounts} />

      {csvEmergencia ? (
        <div className="space-y-6">
          <div className="flex items-start gap-3 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4">
            <AlertTriangle className="h-5 w-5 text-status-warning shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-status-warning">Importação CSV em modo emergência</p>
              <p className="text-muted-foreground mt-1">
                O catálogo tintométrico agora é <strong>automático</strong> (sync do Sayersystem em tempo real).
                Use a importação manual abaixo <strong>somente</strong> se o sync estiver fora do ar — importar um
                CSV desatualizado <strong>sobrescreve</strong> o catálogo automático.
              </p>
            </div>
          </div>

          <ImportCard
            tipo={tipo}
            setTipo={setTipo}
            importMode={importMode}
            setImportMode={setImportMode}
            files={files}
            onFiles={handleFiles}
            importing={importing}
            directRunning={directRunning}
            directProgress={directProgress}
            chunkProgress={chunkProgress}
            progressPct={progressPct}
            results={results}
            onImport={handleImportWithMode}
            onCancelDirect={cancelDirect}
          />

          <HistoryTable
            history={(history ?? []) as TintImportacaoRow[]}
            histLoading={histLoading}
            importing={importing}
            resumingId={resumingId}
            onResume={handleResume}
          />
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <AlertTriangle className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Importação manual por CSV aposentada</p>
            <p className="text-muted-foreground mt-1">
              O catálogo tintométrico agora é alimentado <strong>automaticamente</strong> pelo sync do Sayersystem
              (tempo real). A importação manual por CSV foi descontinuada.{' '}
              <Link to="?tab=importar&amp;csv=emergencia" className="text-primary underline underline-offset-2">
                Abrir importação de emergência
              </Link>{' '}
              — use só se o sync estiver fora do ar.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
