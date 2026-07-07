import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  CheckCircle2, XCircle, AlertTriangle, ArrowLeftRight,
  Building2, Search, Ban,
  type LucideIcon,
} from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type {
  FinConciliacaoRow,
  FinContaCorrenteRow,
  FinMovimentacaoRow,
} from '@/services/financeiroTypes';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

type ConciliacaoStatus = 'pendente' | 'conciliado' | 'divergencia' | 'ignorado';

const statusConfig: Record<ConciliacaoStatus, { label: string; color: string; icon: LucideIcon }> = {
  pendente: { label: 'Pendente', color: 'bg-status-warning-bg text-status-warning', icon: AlertTriangle },
  conciliado: { label: 'Conciliado', color: 'bg-status-success-bg text-status-success', icon: CheckCircle2 },
  divergencia: { label: 'Divergência', color: 'bg-status-error-bg text-status-error', icon: XCircle },
  ignorado: { label: 'Ignorado', color: 'bg-muted text-muted-foreground', icon: Ban },
};

type ContaCorrenteFiltro = Pick<FinContaCorrenteRow, 'omie_ncodcc' | 'descricao' | 'banco'>;
type MovimentacaoMatch = Pick<
  FinMovimentacaoRow,
  'id' | 'omie_ncodcc' | 'data_movimento' | 'valor' | 'descricao' | 'tipo' | 'omie_codigo_lancamento' | 'conciliado'
>;

const FinanceiroConciliacao = () => {
  const [company, setCompany] = useState<Company>('oben');
  const [statusFilter, setStatusFilter] = useState<ConciliacaoStatus | 'todos'>('pendente');
  const [items, setItems] = useState<FinConciliacaoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Record<ConciliacaoStatus, number>>({
    pendente: 0, conciliado: 0, divergencia: 0, ignorado: 0,
  });
  const [search, setSearch] = useState('');
  const [contas, setContas] = useState<ContaCorrenteFiltro[]>([]);
  const [selectedCC, setSelectedCC] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Load contas correntes for filter
      const { data: ccs } = await supabase
        .from('fin_contas_correntes')
        .select('omie_ncodcc, descricao, banco')
        .eq('company', company).eq('ativo', true);
      setContas(ccs || []);

      // Load conciliação items
      let query = supabase
        .from('fin_conciliacao')
        .select('*')
        .eq('company', company)
        .order('mov_data', { ascending: false });

      if (statusFilter !== 'todos') query = query.eq('status', statusFilter);
      if (selectedCC !== 'all') query = query.eq('omie_ncodcc', Number(selectedCC));

      const { data } = await query.limit(500);
      setItems(data || []);

      // Stats
      const { data: allItems } = await supabase
        .from('fin_conciliacao')
        .select('status')
        .eq('company', company);

      const s: Record<ConciliacaoStatus, number> = { pendente: 0, conciliado: 0, divergencia: 0, ignorado: 0 };
      for (const item of allItems || []) {
        const key = item.status as ConciliacaoStatus;
        if (s[key] !== undefined) s[key]++;
      }
      setStats(s);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Erro', { description: message });
    } finally {
      setLoading(false);
    }
  }, [company, statusFilter, selectedCC]);

  useEffect(() => { load(); }, [load]);

  const resolver = async (id: string, status: 'conciliado' | 'ignorado', obs?: string) => {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    await supabase
      .from('fin_conciliacao')
      .update({
        status,
        resolvido_por: userId,
        resolvido_em: new Date().toISOString(),
        observacao: obs || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    toast.success(status === 'conciliado' ? 'Conciliado' : 'Ignorado');
    load();
  };

  const gerarConciliacao = async () => {
    toast.success('Gerando fila de conciliação...');
    try {
      // Buscar movimentações não conciliadas
      const { data: movs } = await supabase
        .from('fin_movimentacoes')
        .select('id, omie_ncodcc, data_movimento, valor, descricao, tipo, omie_codigo_lancamento, conciliado')
        .eq('company', company)
        .eq('conciliado', false);

      let criados = 0;
      for (const mov of (movs || []) as MovimentacaoMatch[]) {
        // Tentar match automático por omie_codigo_lancamento
        let tituloId: string | null = null;
        let tituloValor: number | null = null;
        let tipoTitulo: 'CR' | 'CP' | null = null;
        let tipoMatch: string | null = null;

        if (mov.omie_codigo_lancamento) {
          // Buscar em CR
          const { data: cr } = await supabase
            .from('fin_contas_receber')
            .select('id, valor_documento')
            .eq('company', company)
            .eq('omie_codigo_lancamento', mov.omie_codigo_lancamento)
            .limit(1);
          if (cr && cr.length > 0) {
            tituloId = cr[0].id;
            tituloValor = cr[0].valor_documento;
            tipoTitulo = 'CR';
            tipoMatch = 'automatico';
          } else {
            // Buscar em CP
            const { data: cp } = await supabase
              .from('fin_contas_pagar')
              .select('id, valor_documento')
              .eq('company', company)
              .eq('omie_codigo_lancamento', mov.omie_codigo_lancamento)
              .limit(1);
            if (cp && cp.length > 0) {
              tituloId = cp[0].id;
              tituloValor = cp[0].valor_documento;
              tipoTitulo = 'CP';
              tipoMatch = 'automatico';
            }
          }
        }

        const status = tipoMatch === 'automatico'
          ? (Math.abs(mov.valor - (tituloValor || 0)) < 0.01 ? 'conciliado' : 'divergencia')
          : 'pendente';

        if (mov.omie_ncodcc == null) continue;

        const { error } = await supabase
          .from('fin_conciliacao')
          .upsert({
            company,
            omie_ncodcc: mov.omie_ncodcc,
            mov_id: mov.id,
            mov_data: mov.data_movimento,
            mov_valor: mov.valor,
            mov_descricao: mov.descricao,
            tipo_titulo: tipoTitulo,
            titulo_id: tituloId,
            titulo_valor: tituloValor,
            status,
            tipo_match: tipoMatch,
          }, { onConflict: 'id' });

        if (!error) criados++;
      }
      toast.success(`${criados} itens gerados na fila de conciliação`);
      load();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Erro', { description: message });
    }
  };

  const filtered = items.filter(i => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (i.mov_descricao || '').toLowerCase().includes(s);
  });

  const total = stats.pendente + stats.conciliado + stats.divergencia + stats.ignorado;
  const pctConciliado = total > 0 ? ((stats.conciliado / total) * 100).toFixed(0) : '0';

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Conciliação Bancária</h1>
          <p className="text-sm text-muted-foreground mt-1">Fila de exceções e resolução de divergências</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={company} onValueChange={v => setCompany(v as Company)}>
            <SelectTrigger className="w-[150px]">
              <Building2 className="w-4 h-4 mr-2" /><SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_COMPANIES.map(co => (
                <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={gerarConciliacao}>
            <ArrowLeftRight className="w-4 h-4 mr-1" /> Gerar Fila
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-3 rounded-lg bg-muted/50 text-center">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-lg font-bold">{total}</p>
        </div>
        {Object.entries(statusConfig).map(([key, cfg]) => {
          const Icon = cfg.icon;
          const count = stats[key as keyof typeof stats] || 0;
          return (
            <button key={key} onClick={() => setStatusFilter(key as ConciliacaoStatus)}
              className={`p-3 rounded-lg text-center transition-all ${statusFilter === key ? 'ring-2 ring-primary' : ''} ${cfg.color.replace('text-', 'bg-').split(' ')[0]}/30`}>
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                <Icon className="w-3 h-3" />{cfg.label}
              </p>
              <p className="text-lg font-bold">{count}</p>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar por descrição..." value={search}
            onChange={e => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={selectedCC} onValueChange={setSelectedCC}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Conta corrente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as contas</SelectItem>
            {contas.map(cc => (
              <SelectItem key={cc.omie_ncodcc} value={String(cc.omie_ncodcc)}>
                {cc.descricao} ({cc.banco})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="secondary">{pctConciliado}% conciliado</Badge>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <PageSkeleton variant="list" className="p-4" />
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              {total === 0
                ? 'Nenhum item. Clique "Gerar Fila" para processar movimentações.'
                : 'Nenhum item com este filtro.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Data</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="text-right w-28">Mov.</TableHead>
                    <TableHead className="text-right w-28">Título</TableHead>
                    <TableHead className="text-right w-24">Dif.</TableHead>
                    <TableHead className="w-24">Match</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-32"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 200).map(item => {
                    const cfg = statusConfig[item.status as ConciliacaoStatus] || statusConfig.pendente;
                    const Icon = cfg.icon;
                    return (
                      <TableRow key={item.id} className={item.status === 'divergencia' ? 'bg-status-error-bg/50' : ''}>
                        <TableCell className="text-sm">{fmtDate(item.mov_data)}</TableCell>
                        <TableCell>
                          <p className="text-sm truncate max-w-[250px]">{item.mov_descricao || '—'}</p>
                          {item.tipo_titulo && (
                            <Badge variant="outline" className="text-[9px] mt-0.5">{item.tipo_titulo}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">{fmt(item.mov_valor || 0)}</TableCell>
                        <TableCell className="text-right text-sm">{item.titulo_valor ? fmt(item.titulo_valor) : '—'}</TableCell>
                        <TableCell className={`text-right text-sm font-bold ${
                          Math.abs(item.diferenca || 0) > 0.01 ? 'text-status-error' : 'text-status-success'
                        }`}>
                          {item.diferenca != null ? fmt(item.diferenca) : '—'}
                        </TableCell>
                        <TableCell>
                          {item.tipo_match
                            ? <Badge variant="outline" className="text-[9px]">{item.tipo_match}</Badge>
                            : <span className="text-xs text-muted-foreground">sem match</span>}
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${cfg.color}`}>
                            <Icon className="w-3 h-3 mr-0.5" />{cfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {(item.status === 'pendente' || item.status === 'divergencia') && (
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 text-[10px] text-status-success"
                                onClick={() => resolver(item.id, 'conciliado')}>
                                <CheckCircle2 className="w-3 h-3 mr-0.5" /> OK
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-[10px] text-gray-500"
                                onClick={() => resolver(item.id, 'ignorado')}>
                                <Ban className="w-3 h-3 mr-0.5" /> Ign.
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default FinanceiroConciliacao;
