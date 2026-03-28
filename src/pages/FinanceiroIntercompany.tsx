import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getEliminacoes, upsertEliminacao, deleteEliminacao, type EliminacaoRegra } from '@/services/financeiroV2Service';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Trash2, ArrowRight, Building2, Save, BarChart3 } from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FinanceiroIntercompany = () => {
  const { toast } = useToast();
  const [regras, setRegras] = useState<EliminacaoRegra[]>([]);
  const [loading, setLoading] = useState(true);
  const [consolidado, setConsolidado] = useState<any[]>([]);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [mes, setMes] = useState(new Date().getMonth() + 1);

  // New rule form
  const [newRegra, setNewRegra] = useState({
    empresa_origem: 'oben' as string,
    empresa_destino: 'colacor' as string,
    tipo: 'receita_despesa' as string,
    match_por: 'cnpj' as string,
    cnpj_origem: '',
    cnpj_destino: '',
    descricao: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getEliminacoes();
      setRegras(data);
      // Load consolidado via RPC
      try {
        const { data: cons } = await supabase.rpc('fin_consolidado_intercompany' as any, {
          p_ano: ano, p_mes: mes,
        }) as any;
        setConsolidado(cons || []);
      } catch { /* RPC may not exist */ }
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [ano, mes]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newRegra.descricao) return toast({ title: 'Preencha a descrição' });
    try {
      await upsertEliminacao({
        ...newRegra,
        cnpj_origem: newRegra.cnpj_origem || null,
        cnpj_destino: newRegra.cnpj_destino || null,
        categoria_origem: null,
        categoria_destino: null,
        ativo: true,
      } as any);
      toast({ title: 'Regra criada' });
      setNewRegra(prev => ({ ...prev, descricao: '', cnpj_origem: '', cnpj_destino: '' }));
      load();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    await deleteEliminacao(id);
    toast({ title: 'Regra removida' });
    load();
  };

  const dreLabels: Record<string, string> = {
    receita_bruta: 'Receita Bruta', receita_liquida: 'Receita Líquida',
    cmv: 'CMV', lucro_bruto: 'Lucro Bruto',
    resultado_operacional: 'Resultado Operacional', impostos: 'Impostos',
    resultado_liquido: 'Resultado Líquido', deducoes: 'Deduções',
    despesas_operacionais: 'Desp. Operacionais', despesas_administrativas: 'Desp. Administrativas',
    despesas_comerciais: 'Desp. Comerciais', despesas_financeiras: 'Desp. Financeiras',
    receitas_financeiras: 'Rec. Financeiras',
  };

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Consolidação Intercompany</h1>
          <p className="text-sm text-muted-foreground mt-1">Regras de eliminação e DRE consolidado líquido</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(mes)} onValueChange={v => setMes(Number(v))}>
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'].map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Consolidado with eliminations */}
      {consolidado.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              DRE Consolidado — {['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mes - 1]}/{ano}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Linha</TableHead>
                  <TableHead className="text-right">Bruto (soma)</TableHead>
                  <TableHead className="text-right">Eliminações</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consolidado.map((row: any) => (
                  <TableRow key={row.dre_linha} className={
                    ['lucro_bruto', 'resultado_operacional', 'resultado_liquido'].includes(row.dre_linha) ? 'bg-muted/30 font-bold' : ''
                  }>
                    <TableCell className="text-sm">{dreLabels[row.dre_linha] || row.dre_linha}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(row.valor_bruto)}</TableCell>
                    <TableCell className={`text-right text-sm ${row.eliminacoes !== 0 ? 'text-red-600 font-medium' : ''}`}>
                      {row.eliminacoes !== 0 ? fmt(row.eliminacoes) : '—'}
                    </TableCell>
                    <TableCell className={`text-right text-sm font-medium ${
                      row.dre_linha === 'resultado_liquido'
                        ? (row.valor_liquido >= 0 ? 'text-emerald-600' : 'text-red-600')
                        : ''
                    }`}>{fmt(row.valor_liquido)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Regras */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Regras de Eliminação ({regras.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {regras.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground mb-4">Nenhuma regra configurada. Adicione regras para eliminar operações entre empresas.</p>
          )}
          <div className="space-y-2 mb-4">
            {regras.map(r => (
              <div key={r.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/40">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{COMPANIES[r.empresa_origem as Company]?.shortName}</Badge>
                  <ArrowRight className="w-3 h-3" />
                  <Badge variant="outline">{COMPANIES[r.empresa_destino as Company]?.shortName}</Badge>
                  <span className="text-muted-foreground">·</span>
                  <span>{r.descricao}</span>
                  <Badge variant="secondary" className="text-[9px]">{r.match_por}</Badge>
                </div>
                <Button variant="ghost" size="sm" className="text-red-500" onClick={() => handleDelete(r.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* Add form */}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-medium">Nova regra</p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Origem</label>
                <Select value={newRegra.empresa_origem} onValueChange={v => setNewRegra(p => ({ ...p, empresa_origem: v }))}>
                  <SelectTrigger className="w-[130px] mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ALL_COMPANIES.map(co => <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Destino</label>
                <Select value={newRegra.empresa_destino} onValueChange={v => setNewRegra(p => ({ ...p, empresa_destino: v }))}>
                  <SelectTrigger className="w-[130px] mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ALL_COMPANIES.filter(co => co !== newRegra.empresa_origem).map(co => (
                      <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Match por</label>
                <Select value={newRegra.match_por} onValueChange={v => setNewRegra(p => ({ ...p, match_por: v }))}>
                  <SelectTrigger className="w-[120px] mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cnpj">CNPJ</SelectItem>
                    <SelectItem value="categoria">Categoria</SelectItem>
                    <SelectItem value="documento">Documento</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground">Descrição</label>
                <Input value={newRegra.descricao} onChange={e => setNewRegra(p => ({ ...p, descricao: e.target.value }))}
                  placeholder="Ex: Venda de produtos Colacor para Oben" className="mt-1" />
              </div>
              <Button onClick={handleAdd}><Plus className="w-4 h-4 mr-1" /> Adicionar</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default FinanceiroIntercompany;
