// Card "Importar CSV do SAYERSYSTEM" da Importação Tintométrica.
// Extraído de src/pages/TintImport.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Upload, FileText, CheckCircle, AlertTriangle, Loader2, Zap, Cloud } from 'lucide-react';
import Papa from 'papaparse';
import { TIPO_OPTIONS, type FileWithPreview, type TintImportFileResult } from './types';

type DirectProgress = {
  phase: string;
  currentBatch: number;
  totalBatches: number;
  recordsProcessed: number;
  totalRecords: number;
  imported: number;
  updated: number;
  errors: number;
};

type ChunkProgress = {
  currentFile: number;
  totalFiles: number;
  fileName: string;
  currentChunk: number;
  totalChunks: number;
};

export function ImportCard({
  tipo, setTipo, importMode, setImportMode, files, onFiles,
  importing, directRunning, directProgress, chunkProgress, progressPct, results,
  onImport, onCancelDirect,
}: {
  tipo: string;
  setTipo: (v: string) => void;
  importMode: 'auto' | 'edge' | 'direct' | 'rpc';
  setImportMode: (v: 'auto' | 'edge' | 'direct' | 'rpc') => void;
  files: FileWithPreview[];
  onFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  importing: boolean;
  directRunning: boolean;
  directProgress?: DirectProgress | null;
  chunkProgress: ChunkProgress;
  progressPct: number;
  results: TintImportFileResult[];
  onImport: () => void;
  onCancelDirect: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importar CSV do SAYERSYSTEM</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-4 flex-wrap">
          <div className="max-w-sm flex-1">
            <label className="text-sm font-medium mb-1 block">Tipo de importação</label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger><SelectValue placeholder="Selecione o tipo" /></SelectTrigger>
              <SelectContent>
                {TIPO_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="max-w-xs">
            <label className="text-sm font-medium mb-1 block">Modo de importação</label>
            <Select value={importMode} onValueChange={(v) => setImportMode(v as 'auto' | 'edge' | 'direct' | 'rpc')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automático (recomendado)</SelectItem>
                <SelectItem value="rpc">⚡ RPC Postgres (mais rápido)</SelectItem>
                <SelectItem value="direct">Importação Direta (SQL)</SelectItem>
                <SelectItem value="edge">Edge Function (legacy)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {importMode === 'auto' && 'Fórmulas grandes: RPC Postgres | Auxiliares: Direto | < 500 linhas: Edge'}
              {importMode === 'rpc' && '2.000 linhas por lote, processado nativamente no Postgres (~45s para 29k linhas)'}
              {importMode === 'direct' && 'Sem edge function. 200 linhas por lote via JS client'}
              {importMode === 'edge' && 'Usa edge function com chunks. Pode dar timeout em arquivos grandes'}
            </p>
          </div>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Arquivos CSV</label>
          <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
            <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-2">Arraste arquivos ou clique para selecionar</p>
            <input
              type="file"
              accept=".csv,.txt"
              multiple
              onChange={onFiles}
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
            />
          </div>
        </div>

        {/* Preview */}
        {files.length > 0 && (
          <div className="space-y-3">
            {files.map((f, idx) => {
              const lineCount = Papa.parse(f.rawText, { delimiter: ';', skipEmptyLines: true }).data.length - 1;
              const useDirectMode = importMode === 'direct' || importMode === 'rpc' || (importMode === 'auto' && lineCount >= 500);
              return (
                <div key={idx} className="border rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4" />
                    <span className="text-sm font-medium">{f.name}</span>
                    <Badge variant="outline">{lineCount} linhas</Badge>
                    {useDirectMode ? (
                      <Badge variant="secondary" className="gap-1">
                        <Zap className="w-3 h-3" /> {importMode === 'rpc' || (importMode === 'auto' && (tipo === 'formulas_padrao' || tipo === 'formulas_personalizadas')) ? 'RPC Postgres' : 'Direto'}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1"><Cloud className="w-3 h-3" /> Edge Function</Badge>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="text-xs">
                      <tbody>
                        {f.preview.map((row, ri) => (
                          <tr key={ri} className={ri === 0 ? 'font-semibold bg-muted/50' : ''}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-2 py-0.5 border-b whitespace-nowrap max-w-[200px] truncate">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Progress — Edge Function mode */}
        {importing && !directRunning && (
          <div className="space-y-2">
            <p className="text-sm">
              <Cloud className="w-4 h-4 inline mr-1" />
              Importando <span className="font-medium">{chunkProgress.fileName}</span>
              {' '}(arquivo {chunkProgress.currentFile}/{chunkProgress.totalFiles})
              {chunkProgress.totalChunks > 1 && (
                <> — chunk {chunkProgress.currentChunk}/{chunkProgress.totalChunks}</>
              )}
            </p>
            <Progress value={progressPct} />
          </div>
        )}

        {/* Progress — Direct mode */}
        {directRunning && directProgress && (
          <div className="space-y-2">
            <p className="text-sm">
              <Zap className="w-4 h-4 inline mr-1" />
              {directProgress.phase} — Lote {directProgress.currentBatch}/{directProgress.totalBatches}
              {' '}({directProgress.recordsProcessed.toLocaleString()} / {directProgress.totalRecords.toLocaleString()} registros)
            </p>
            <Progress value={(directProgress.recordsProcessed / directProgress.totalRecords) * 100} />
            <p className="text-xs text-muted-foreground">
              {directProgress.imported} importados, {directProgress.updated} atualizados, {directProgress.errors} erros
            </p>
            <Button size="sm" variant="outline" onClick={onCancelDirect}>Cancelar</Button>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Resultado</h3>
            {results.map((r, i) => (
              <div key={i} className="border rounded-md p-3 flex items-start gap-3">
                {r.status === 'concluido' ? <CheckCircle className="w-4 h-4 text-status-success mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-status-warning mt-0.5" />}
                <div className="text-sm">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-muted-foreground">
                    {r.registros_importados ?? r.imported ?? 0} importados, {r.registros_atualizados ?? r.updated ?? 0} atualizados, {r.registros_erro ?? r.errors ?? 0} erros
                    {(r.failed_chunks ?? 0) > 0 && <span className="text-destructive"> ({r.failed_chunks} chunks falharam)</span>}
                  </p>
                  {r.erros && r.erros.length > 0 && (
                    <ul className="text-xs text-destructive mt-1">
                      {r.erros.slice(0, 5).map((e, j: number) => <li key={j}>Linha {e.linha}: {e.motivo}</li>)}
                    </ul>
                  )}
                  {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                  {r.status === 'duplicado' && <p className="text-xs text-muted-foreground">{r.message || 'Arquivo já importado anteriormente'}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        <Button onClick={onImport} disabled={importing || directRunning || !tipo || files.length === 0}>
          {(importing || directRunning) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          Importar
        </Button>
      </CardContent>
    </Card>
  );
}
