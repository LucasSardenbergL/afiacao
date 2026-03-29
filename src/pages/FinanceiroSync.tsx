import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { useFinanceiro } from '@/hooks/useFinanceiro';
import {
  Loader2, RefreshCw, Database, FolderSync, Building2,
  ArrowDownCircle, ArrowUpCircle, Layers, BarChart3, Wallet,
  CheckCircle2, XCircle, Clock
} from 'lucide-react';

interface SyncResult {
  entity: string;
  company: string;
  status: 'idle' | 'running' | 'done' | 'error';
  total?: number;
  error?: string;
}

const FinanceiroSync = () => {
  const { syncing, syncSpecific, calcularDREAnual, view, setView } = useFinanceiro('all');
  const [results, setResults] = useState<SyncResult[]>([]);
  const [dreAno, setDreAno] = useState(new Date().getFullYear());
  const [globalSyncing, setGlobalSyncing] = useState(false);

  const entities = [
    { key: 'sync_categorias', label: 'Categorias', icon: Layers, desc: 'Plano de contas do Omie' },
    { key: 'sync_contas_correntes', label: 'Contas Correntes', icon: Wallet, desc: 'Contas bancárias e saldos' },
    { key: 'sync_contas_receber', label: 'Contas a Receber', icon: ArrowDownCircle, desc: 'Títulos a receber (180 dias)' },
    { key: 'sync_contas_pagar', label: 'Contas a Pagar', icon: ArrowUpCircle, desc: 'Títulos a pagar (180 dias)' },
    { key: 'sync_movimentacoes', label: 'Movimentações', icon: FolderSync, desc: 'Extratos bancários (90 dias)' },
  ];

  const targetCompanies: Company[] = view === 'all'
    ? ['oben', 'colacor', 'colacor_sc']
    : [view as Company];

  const syncEntity = async (action: string) => {
    for (const co of targetCompanies) {
      setResults(prev => [
        ...prev.filter(r => !(r.entity === action && r.company === co)),
        { entity: action, company: co, status: 'running' },
      ]);
    }

    try {
      const result = await syncSpecific(action);
      if (result?.results) {
        for (const [co, data] of Object.entries(result.results as Record<string, any>)) {
          setResults(prev => [
            ...prev.filter(r => !(r.entity === action && r.company === co)),
            {
              entity: action,
              company: co,
              status: data.error ? 'error' : 'done',
              total: data.totalSynced ?? data.total,
              error: data.error,
            },
          ]);
          ]);
        }
      }
    } catch (e: any) {
      for (const co of targetCompanies) {
        setResults(prev => [
          ...prev.filter(r => !(r.entity === action && r.company === co)),
          { entity: action, company: co, status: 'error', error: e.message },
        ]);
      }
    }
  };

  const syncAll = async () => {
    setGlobalSyncing(true);
    for (const entity of entities) {
      await syncEntity(entity.key);
    }
    setGlobalSyncing(false);
  };

  const getResultFor = (entity: string, company: string) =>
    results.find(r => r.entity === entity && r.company === company);

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sincronização Financeira</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Importar dados do Omie para as tabelas financeiras locais
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={view} onValueChange={v => setView(v as any)}>
            <SelectTrigger className="w-[180px]">
              <Building2 className="w-4 h-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as Empresas</SelectItem>
              {ALL_COMPANIES.map(co => (
                <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={syncAll} disabled={globalSyncing || syncing}>
            {globalSyncing ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Database className="w-4 h-4 mr-2" />
            )}
            Sync Completo
          </Button>
        </div>
      </div>

      {/* Entity cards */}
      <div className="space-y-3">
        {entities.map(entity => {
          const Icon = entity.icon;
          const companyResults = targetCompanies.map(co => ({
            company: co,
            result: getResultFor(entity.key, co),
          }));

          return (
            <Card key={entity.key}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-muted">
                      <Icon className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{entity.label}</p>
                      <p className="text-xs text-muted-foreground">{entity.desc}</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {companyResults.map(({ company, result }) => (
                          <div key={company} className="flex items-center gap-1.5 text-xs">
                            <Badge variant="outline" className="text-[10px]">
                              {COMPANIES[company]?.shortName}
                            </Badge>
                            {!result && <span className="text-muted-foreground">—</span>}
                            {result?.status === 'running' && (
                              <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                            )}
                            {result?.status === 'done' && (
                              <span className="flex items-center gap-0.5 text-emerald-600">
                                <CheckCircle2 className="w-3 h-3" />
                                {result.total != null ? `${result.total}` : 'OK'}
                              </span>
                            )}
                            {result?.status === 'error' && (
                              <span className="flex items-center gap-0.5 text-red-500" title={result.error}>
                                <XCircle className="w-3 h-3" />
                                Erro
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => syncEntity(entity.key)}
                    disabled={syncing || globalSyncing}
                  >
                    <RefreshCw className="w-3.5 h-3.5 mr-1" />
                    Sync
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* DRE Calculation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Cálculo de DRE
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Gera snapshots mensais da DRE gerencial com base nas contas a receber e a pagar sincronizadas.
            A classificação é inferida automaticamente pelo código de categoria do Omie.
          </p>
          <div className="flex items-center gap-3">
            <Select value={String(dreAno)} onValueChange={v => setDreAno(Number(v))}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2024, 2025, 2026].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => calcularDREAnual(dreAno)} disabled={syncing}>
              {syncing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <BarChart3 className="w-4 h-4 mr-2" />}
              Calcular DRE {dreAno}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Env vars reminder */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="p-4">
          <p className="text-sm font-medium text-amber-800 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Variáveis de ambiente necessárias no Supabase
          </p>
          <div className="mt-2 text-xs text-amber-700 space-y-1">
            <p>Oben: <code className="bg-amber-100 px-1 rounded">OMIE_VENDAS_APP_KEY</code> / <code className="bg-amber-100 px-1 rounded">OMIE_VENDAS_APP_SECRET</code></p>
            <p>Colacor: <code className="bg-amber-100 px-1 rounded">OMIE_COLACOR_VENDAS_APP_KEY</code> / <code className="bg-amber-100 px-1 rounded">OMIE_COLACOR_VENDAS_APP_SECRET</code></p>
            <p>Colacor SC: <code className="bg-amber-100 px-1 rounded">OMIE_COLACOR_SC_APP_KEY</code> / <code className="bg-amber-100 px-1 rounded">OMIE_COLACOR_SC_APP_SECRET</code></p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default FinanceiroSync;
