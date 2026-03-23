import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Upload, RefreshCw, FileText, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import Papa from 'papaparse';

const ACCOUNT = 'oben';
const CHUNK_SIZE = 200;

const TIPO_OPTIONS = [
  { value: 'dados_corantes', label: 'Dados auxiliares — Corantes' },
  { value: 'dados_produto_base_embalagem', label: 'Dados auxiliares — Produto/Base/Embalagem' },
  { value: 'formulas_padrao', label: 'Fórmulas — Cores Padrões' },
  { value: 'formulas_personalizadas', label: 'Fórmulas — Personalizadas' },
];

function useImportHistory() {
  return useQuery({
    queryKey: ['tint-import-history'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_importacoes')
        .select('*')
        .eq('account', ACCOUNT)
        .order('created_at', { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });
}

function useTintProductCounts() {
  return useQuery({
    queryKey: ['tint-product-counts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('omie_products')
        .select('tint_type')
        .eq('is_tintometric', true)
        .eq('account', ACCOUNT);
      const bases = (data ?? []).filter(p => p.tint_type === 'base').length;
      const concentrados = (data ?? []).filter(p => p.tint_type === 'concentrado').length;
      return { bases, concentrados };
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface FileWithPreview {
  file: File;
  preview: string[][];
  name: string;
  rawText: string;
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function TintImport() {
  const [tipo, setTipo] = useState('');
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [chunkProgress, setChunkProgress] = useState({ currentFile: 0, totalFiles: 0, fileName: '', currentChunk: 0, totalChunks: 0 });
  const [results, setResults] = useState<any[]>([]);
  const queryClient = useQueryClient();
  const { data: history, isLoading: histLoading } = useImportHistory();
  const { data: tintCounts } = useTintProductCounts();

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
      const res = await invokeFunction<any>('tint-omie-sync', { action: 'sync_tint_products' });
      const total = res.total_sincronizado ?? res.totalSynced ?? 0;
      toast.success(`${total} produtos tintométricos sincronizados`);
      queryClient.invalidateQueries({ queryKey: ['tint'] });
      queryClient.invalidateQueries({ queryKey: ['tint-product-counts'] });
    } catch (err: any) {
      toast.error(err.message || 'Erro ao sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  const handleImport = async () => {
    if (!tipo) { toast.error('Selecione o tipo de importação'); return; }
    if (files.length === 0) { toast.error('Selecione ao menos um arquivo'); return; }

    setImporting(true);
    const allResults: any[] = [];

    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];

      // Parse CSV in browser with PapaParse
      const parseResult = Papa.parse<string[]>(f.rawText, {
        delimiter: ';',
        skipEmptyLines: true,
      });

      const allRows = parseResult.data;
      if (allRows.length < 2) {
        allResults.push({ name: f.name, status: 'erro', error: 'CSV vazio ou sem dados' });
        continue;
      }

      // Skip header
      const dataRows = allRows.slice(1);
      const totalRows = dataRows.length;

      // For small files (≤ CHUNK_SIZE), use legacy multipart mode
      if (totalRows <= CHUNK_SIZE) {
        setChunkProgress({ currentFile: fi + 1, totalFiles: files.length, fileName: f.name, currentChunk: 1, totalChunks: 1 });
        const formData = new FormData();
        formData.append('file', f.file);
        formData.append('tipo', tipo);
        formData.append('account', ACCOUNT);
        try {
          const res = await invokeFunction<any>('tint-import', formData);
          allResults.push({ name: f.name, ...res });
        } catch (err: any) {
          allResults.push({ name: f.name, status: 'erro', error: err.message });
        }
        continue;
      }

      // Large file: chunk mode
      const hash = await sha256(f.rawText);
      const chunks: string[][][] = [];
      for (let i = 0; i < totalRows; i += CHUNK_SIZE) {
        chunks.push(dataRows.slice(i, i + CHUNK_SIZE));
      }
      const totalChunks = chunks.length;

      let importacaoId: string | null = null;
      let totalImported = 0;
      let totalUpdated = 0;
      let totalErrors = 0;
      let lastError: string | null = null;

      // Step 1: Create import record first (lightweight call, no data processing)
      try {
        setChunkProgress({ currentFile: fi + 1, totalFiles: files.length, fileName: f.name, currentChunk: 0, totalChunks });
        const createRes = await invokeFunction<any>('tint-import', {
          action: 'create_import',
          tipo,
          account: ACCOUNT,
          arquivo_hash: hash,
          arquivo_nome: f.name,
          total_rows: totalRows,
        });

        if (createRes.status === 'duplicado') {
          allResults.push({ name: f.name, ...createRes });
          continue;
        }

        importacaoId = createRes.importacao_id;
      } catch (err: any) {
        allResults.push({ name: f.name, status: 'erro', error: `Falha ao criar importação: ${err.message}` });
        continue;
      }

      if (!importacaoId) {
        allResults.push({ name: f.name, status: 'erro', error: 'Não foi possível obter o ID da importação' });
        continue;
      }

      // Step 2: Send data chunks
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
          const res = await invokeFunction<any>('tint-import', body);

          totalImported += res.registros_importados ?? 0;
          totalUpdated += res.registros_atualizados ?? 0;
          totalErrors += res.registros_erro ?? 0;
        } catch (err: any) {
          lastError = err.message;
          totalErrors++;
          // Continue with next chunks
        }
      }

      if (importacaoId) {
        allResults.push({
          name: f.name,
          status: totalErrors > 0 && totalImported === 0 && totalUpdated === 0 ? 'erro' : totalErrors > 0 ? 'parcial' : 'concluido',
          importacao_id: importacaoId,
          total_registros: totalRows,
          registros_importados: totalImported,
          registros_atualizados: totalUpdated,
          registros_erro: totalErrors,
          error: lastError,
        });
      }
    }

    setResults(allResults);
    setImporting(false);
    queryClient.invalidateQueries({ queryKey: ['tint'] });
    queryClient.invalidateQueries({ queryKey: ['tint-import-history'] });
    toast.success('Importação finalizada');
  };

  const statusColor: Record<string, string> = {
    concluido: 'bg-green-500/10 text-green-700',
    parcial: 'bg-yellow-500/10 text-yellow-700',
    erro: 'bg-red-500/10 text-red-700',
    processando: 'bg-blue-500/10 text-blue-700',
    duplicado: 'bg-gray-500/10 text-gray-700',
  };

  const progressPct = chunkProgress.totalChunks > 0
    ? ((chunkProgress.currentChunk / chunkProgress.totalChunks) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Importação</h1>

      {/* Sync Omie */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sincronizar Produtos Omie</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Importa bases e concentrados tintométricos do Omie para o sistema.
          </p>
          <Button onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Sincronizar Produtos Omie
          </Button>
          {tintCounts && (tintCounts.bases > 0 || tintCounts.concentrados > 0) && (
            <p className="text-sm text-muted-foreground mt-3">
              <span className="font-medium text-foreground">{tintCounts.bases}</span> bases e{' '}
              <span className="font-medium text-foreground">{tintCounts.concentrados}</span> concentrados encontrados no Omie
            </p>
          )}
        </CardContent>
      </Card>

      {/* Import CSV */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Importar CSV do SAYERSYSTEM</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm">
            <label className="text-sm font-medium mb-1 block">Tipo de importação</label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger><SelectValue placeholder="Selecione o tipo" /></SelectTrigger>
              <SelectContent>
                {TIPO_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
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
                onChange={handleFiles}
                className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
              />
            </div>
          </div>

          {/* Preview */}
          {files.length > 0 && (
            <div className="space-y-3">
              {files.map((f, idx) => (
                <div key={idx} className="border rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4" />
                    <span className="text-sm font-medium">{f.name}</span>
                    <Badge variant="outline">{f.preview.length - 1} linhas preview</Badge>
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
              ))}
            </div>
          )}

          {/* Progress */}
          {importing && (
            <div className="space-y-2">
              <p className="text-sm">
                Importando <span className="font-medium">{chunkProgress.fileName}</span>
                {' '}(arquivo {chunkProgress.currentFile}/{chunkProgress.totalFiles})
                {chunkProgress.totalChunks > 1 && (
                  <> — chunk {chunkProgress.currentChunk}/{chunkProgress.totalChunks}</>
                )}
              </p>
              <Progress value={progressPct} />
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Resultado</h3>
              {results.map((r, i) => (
                <div key={i} className="border rounded-md p-3 flex items-start gap-3">
                  {r.status === 'concluido' ? <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5" />}
                  <div className="text-sm">
                    <p className="font-medium">{r.name}</p>
                    <p className="text-muted-foreground">
                      {r.registros_importados ?? 0} importados, {r.registros_atualizados ?? 0} atualizados, {r.registros_erro ?? 0} erros
                    </p>
                    {r.erros && r.erros.length > 0 && (
                      <ul className="text-xs text-destructive mt-1">
                        {r.erros.slice(0, 5).map((e: any, j: number) => <li key={j}>Linha {e.linha}: {e.motivo}</li>)}
                      </ul>
                    )}
                    {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                    {r.status === 'duplicado' && <p className="text-xs text-muted-foreground">{r.message}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button onClick={handleImport} disabled={importing || !tipo || files.length === 0}>
            {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            Importar
          </Button>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico de Importações</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Arquivo</TableHead>
                <TableHead>Registros</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {histLoading ? (
                <TableRow><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              ) : (history ?? []).map((imp: any) => (
                <TableRow key={imp.id}>
                  <TableCell className="text-sm">{new Date(imp.created_at).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell className="text-sm">{imp.tipo}</TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate">{imp.arquivo_nome}</TableCell>
                  <TableCell className="text-sm">{imp.registros_importados ?? 0} / {imp.total_registros ?? 0}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusColor[imp.status] || ''}>{imp.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
