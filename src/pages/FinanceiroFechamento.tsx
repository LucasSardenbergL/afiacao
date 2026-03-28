import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import {
  getFechamentos, criarFechamento, atualizarFechamento, getFechamentoLog,
  type Fechamento, type FechamentoLog,
} from '@/services/financeiroV2Service';
import { triggerFinanceiroSync } from '@/services/financeiroService';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, Building2, Lock, Unlock, CheckCircle2, Clock,
  FileText, Eye, RotateCcw, Plus, History, ShieldCheck, AlertTriangle
} from 'lucide-react';

const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
  aberto: { label: 'Aberto', color: 'bg-blue-100 text-blue-700', icon: Clock },
  em_revisao: { label: 'Em Revisão', color: 'bg-amber-100 text-amber-700', icon: Eye },
  fechado: { label: 'Fechado', color: 'bg-emerald-100 text-emerald-700', icon: Lock },
  reaberto: { label: 'Reaberto', color: 'bg-red-100 text-red-700', icon: Unlock },
};

const FinanceiroFechamento = () => {
  const { toast } = useToast();
  const [company, setCompany] = useState<Company | 'all'>('all');
  const [ano, setAno] = useState(new Date().getFullYear());
  const [fechamentos, setFechamentos] = useState<Fechamento[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [selectedLog, setSelectedLog] = useState<{ id: string; logs: FechamentoLog[] } | null>(null);
  const [motivoReabertura, setMotivoReabertura] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFechamentos(company, ano);
      setFechamentos(data);
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [company, ano]);

  useEffect(() => { load(); }, [load]);

  const handleCriar = async (co: Company, mes: number) => {
    setActing(true);
    try {
      // First recalculate DRE for this month
      await triggerFinanceiroSync('calcular_dre', [co], { ano, meses: [mes] });
      await criarFechamento(co, ano, mes);
      toast({ title: `Fechamento ${mesesNome[mes - 1]}/${ano} criado para ${COMPANIES[co].shortName}` });
      await load();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActing(false);
    }
  };

  const handleAcao = async (id: string, acao: 'revisar' | 'fechar' | 'aprovar' | 'reabrir', detalhes?: any) => {
    setActing(true);
    try {
      await atualizarFechamento(id, acao, detalhes);
      toast({ title: `Ação "${acao}" executada com sucesso` });
      await load();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActing(false);
    }
  };

  const loadLog = async (id: string) => {
    const logs = await getFechamentoLog(id);
    setSelectedLog({ id, logs });
  };

  // Build month grid
  const mesesGrid = Array.from({ length: 12 }, (_, i) => i + 1);
  const targetCompanies: Company[] = company === 'all' ? ['oben', 'colacor', 'colacor_sc'] : [company];

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fechamento Mensal</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Controle de fechamento com aprovação, versionamento e audit trail
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2024, 2025, 2026].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={company} onValueChange={v => setCompany(v as any)}>
            <SelectTrigger className="w-[180px]">
              <Building2 className="w-4 h-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {ALL_COMPANIES.map(co => (
                <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Month grid per company */}
      {targetCompanies.map(co => {
        const coFechamentos = fechamentos.filter(f => f.company === co);

        return (
          <Card key={co}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                {COMPANIES[co].shortName}
                <Badge variant="outline" className="text-[10px]">
                  {COMPANIES[co].regime === 'simples' ? 'Simples Nacional' : 'Lucro Presumido'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {mesesGrid.map(mes => {
                  const fech = coFechamentos
                    .filter(f => f.mes === mes)
                    .sort((a, b) => b.versao - a.versao)[0];
                  const cfg = fech ? statusConfig[fech.status] : null;
                  const Icon = cfg?.icon || Clock;
                  const isFuture = ano > new Date().getFullYear() ||
                    (ano === new Date().getFullYear() && mes > new Date().getMonth() + 1);

                  return (
                    <div
                      key={mes}
                      className={`p-3 rounded-lg border text-center space-y-2 ${
                        isFuture ? 'opacity-40' : ''
                      } ${fech?.status === 'fechado' ? 'border-emerald-200 bg-emerald-50/30' : ''}`}
                    >
                      <p className="text-xs font-medium">{mesesNome[mes - 1].slice(0, 3)}</p>

                      {fech ? (
                        <>
                          <Badge className={`text-[10px] ${cfg?.color}`}>
                            <Icon className="w-3 h-3 mr-1" />
                            {cfg?.label}
                          </Badge>
                          {fech.versao > 1 && (
                            <p className="text-[10px] text-muted-foreground">v{fech.versao}</p>
                          )}
                          <div className="flex flex-col gap-1">
                            {fech.status === 'aberto' && (
                              <Button size="sm" variant="outline" className="text-[10px] h-6"
                                onClick={() => handleAcao(fech.id, 'revisar')} disabled={acting}>
                                <Eye className="w-3 h-3 mr-1" /> Revisar
                              </Button>
                            )}
                            {fech.status === 'em_revisao' && (
                              <Button size="sm" variant="outline" className="text-[10px] h-6"
                                onClick={() => handleAcao(fech.id, 'fechar')} disabled={acting}>
                                <Lock className="w-3 h-3 mr-1" /> Fechar
                              </Button>
                            )}
                            {fech.status === 'fechado' && !fech.aprovado_por && (
                              <Button size="sm" variant="outline" className="text-[10px] h-6"
                                onClick={() => handleAcao(fech.id, 'aprovar')} disabled={acting}>
                                <ShieldCheck className="w-3 h-3 mr-1" /> Aprovar
                              </Button>
                            )}
                            {fech.status === 'fechado' && (
                              <Button size="sm" variant="ghost" className="text-[10px] h-6 text-red-500"
                                onClick={() => {
                                  if (motivoReabertura || confirm('Confirma reabertura?')) {
                                    handleAcao(fech.id, 'reabrir', { motivo: motivoReabertura || 'Correção necessária' });
                                  }
                                }} disabled={acting}>
                                <RotateCcw className="w-3 h-3 mr-1" /> Reabrir
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="text-[10px] h-6"
                              onClick={() => loadLog(fech.id)}>
                              <History className="w-3 h-3 mr-1" /> Log
                            </Button>
                          </div>
                        </>
                      ) : !isFuture ? (
                        <Button size="sm" variant="outline" className="text-[10px] h-6"
                          onClick={() => handleCriar(co, mes)} disabled={acting}>
                          {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
                          Iniciar
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">Futuro</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Log modal */}
      {selectedLog && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="w-4 h-4" />
                Histórico de Ações
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setSelectedLog(null)}>Fechar</Button>
            </div>
          </CardHeader>
          <CardContent>
            {selectedLog.logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma ação registrada.</p>
            ) : (
              <div className="space-y-2">
                {selectedLog.logs.map(log => (
                  <div key={log.id} className="flex items-start gap-3 py-2 border-b last:border-0">
                    <Badge variant="outline" className="text-xs shrink-0">{log.acao}</Badge>
                    <div className="flex-1">
                      <p className="text-sm">{log.usuario_nome || 'Sistema'}</p>
                      {log.detalhes && Object.keys(log.detalhes).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {JSON.stringify(log.detalhes)}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(log.created_at).toLocaleString('pt-BR')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default FinanceiroFechamento;
