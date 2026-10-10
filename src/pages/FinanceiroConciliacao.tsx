import { useState, useEffect, useCallback, useRef } from 'react';
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
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type {
  FinConciliacaoRow,
  FinContaCorrenteRow,
} from '@/services/financeiroTypes';
import { gerarFilaConciliacao, resumirGeracaoConciliacao } from '@/services/financeiroConciliacao';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

type ConciliacaoStatus = 'pendente' | 'conciliado' | 'divergencia' | 'ignorado';

const statusConfig: Record<ConciliacaoStatus, { label: string; color: string; icon: LucideIcon }> = {
  pendente: { label: 'Pendente', color: 'bg-status-warning-bg text-status-warning', icon: AlertTriangle },
  conciliado: { label: 'Conciliado', color: 'bg-status-success-bg text-status-success', icon: CheckCircle2 },
  divergencia: { label: 'Divergência', color: 'bg-status-error-bg text-status-error', icon: XCircle },
  ignorado: { label: 'Ignorado', color: 'bg-muted text-muted-foreground', icon: Ban },
};

/** Janela da lista. Truncar é legítimo; truncar em SILÊNCIO não — o count exato do mesmo
 * filtro acompanha a página e a tela avisa quando há mais (money-path §8). */
const LISTA_LIMITE = 500;
/** Linhas renderizadas na tabela (sem virtualização) — o 2º corte, coberto pelo mesmo aviso. */
const EXIBIR_LIMITE = 200;

type ContaCorrenteFiltro = Pick<FinContaCorrenteRow, 'omie_ncodcc' | 'descricao' | 'banco'>;

const FinanceiroConciliacao = () => {
  const [company, setCompany] = useState<Company>('oben');
  const [statusFilter, setStatusFilter] = useState<ConciliacaoStatus | 'todos'>('pendente');
  const [items, setItems] = useState<FinConciliacaoRow[]>([]);
  const [totalFiltro, setTotalFiltro] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // null = indisponível (leitura falhou ou ainda não carregou) — os cards mostram "—", nunca 0.
  const [stats, setStats] = useState<Record<ConciliacaoStatus, number> | null>(null);
  const [falhaLeitura, setFalhaLeitura] = useState(false);
  const geracao = useRef(0);
  const [search, setSearch] = useState('');
  const [contas, setContas] = useState<ContaCorrenteFiltro[]>([]);
  const [selectedCC, setSelectedCC] = useState<string>('all');

  const load = useCallback(async () => {
    // Geração + publicação ATÔMICA: lista, total e cards saem do MESMO load ou de nenhum. Antes
    // os itens eram publicados antes dos counts — um count que falhava deixava a lista da
    // empresa nova sob os cards ("100% conciliado") da empresa anterior (achado Codex).
    const minha = ++geracao.current;
    setLoading(true);
    try {
      // Contas correntes do filtro — falha LANÇA (cai no catch com toast): o descarte do
      // error deixava o seletor de conta MUDO, como se a empresa não tivesse conta cadastrada.
      const { data: ccs, error: ccsError } = await supabase
        .from('fin_contas_correntes')
        .select('omie_ncodcc, descricao, banco')
        .eq('company', company).eq('ativo', true);
      if (ccsError) throw new Error(`Falha ao carregar contas correntes: ${ccsError.message}`);
      if (ccs == null) throw new Error('Falha ao carregar contas correntes: data=null sem error');

      // Itens — janela de LISTA_LIMITE com TRUNCAGEM HONESTA: o count exato do mesmo filtro
      // vem no próprio request, então a tela distingue "é tudo" de "tem mais" (padrão
      // useSalesOrders). `.order('id')` desempata mov_data repetida.
      let query = supabase
        .from('fin_conciliacao')
        .select('*', { count: 'exact' })
        .eq('company', company);

      if (statusFilter !== 'todos') query = query.eq('status', statusFilter);
      if (selectedCC !== 'all') query = query.eq('omie_ncodcc', Number(selectedCC));

      const { data, error, count } = await query
        .order('mov_data', { ascending: false })
        .order('id', { ascending: true })
        .range(0, LISTA_LIMITE - 1);
      if (error) throw new Error(`Falha ao carregar itens de conciliação: ${error.message}`);
      if (data == null) throw new Error('Falha ao carregar itens de conciliação: data=null sem error');
      if (count == null) throw new Error("Falha ao carregar itens de conciliação: count=null com count:'exact'");

      // Stats contadas NO SERVIDOR (count exact + head), uma por status. Antes a página baixava
      // `select('status')` da tabela INTEIRA para contar no browser — e fin_conciliacao espelha
      // fin_movimentacoes (60k), então a capa de 1.000 do PostgREST truncava a contagem: os
      // cards mostravam um retrato do começo da fila como se fosse o total, e o "% conciliado"
      // derivava dele.
      const statusList: ConciliacaoStatus[] = ['pendente', 'conciliado', 'divergencia', 'ignorado'];
      const contagens = await Promise.all(
        statusList.map((st) =>
          supabase
            .from('fin_conciliacao')
            .select('id', { count: 'exact', head: true })
            .eq('company', company)
            .eq('status', st),
        ),
      );
      const s: Record<ConciliacaoStatus, number> = { pendente: 0, conciliado: 0, divergencia: 0, ignorado: 0 };
      statusList.forEach((st, idx) => {
        const res = contagens[idx];
        if (res.error) throw new Error(`Falha ao contar itens "${st}": ${res.error.message}`);
        if (res.count == null) throw new Error(`Falha ao contar itens "${st}": count=null com count:'exact'`);
        s[st] = res.count;
      });
      if (minha !== geracao.current) return;
      setContas(ccs);
      setItems(data);
      setTotalFiltro(count);
      setStats(s);
      setFalhaLeitura(false);
    } catch (e) {
      if (minha !== geracao.current) return;
      // Falha NÃO preserva o retrato anterior (podia ser de outra empresa/filtro): tudo
      // indisponível até a próxima leitura boa.
      setItems([]);
      setTotalFiltro(null);
      setStats(null);
      setFalhaLeitura(true);
      const message = mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
      toast.error('Erro', { description: message });
    } finally {
      if (minha === geracao.current) setLoading(false);
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
      // Só a ótica BANCÁRIA vira item, e gravação recusada é contada — ver o service.
      const resumo = resumirGeracaoConciliacao(await gerarFilaConciliacao(company));
      if (resumo.tipo === 'sucesso') toast.success(resumo.titulo);
      else toast.error(resumo.titulo, { description: resumo.descricao });
      load();
    } catch (e) {
      const message = mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
      toast.error('Erro', { description: message });
    }
  };

  const filtered = items.filter(i => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (i.mov_descricao || '').toLowerCase().includes(s);
  });

  const total = stats ? stats.pendente + stats.conciliado + stats.divergencia + stats.ignorado : null;
  // Nota: os 4 counts são requests separados (não um snapshot) — sob conciliação concorrente a
  // soma pode descasar por instantes. Agregação atômica pediria uma RPC; limite registrado.
  const pctConciliado = stats && total !== null && total > 0 ? ((stats.conciliado / total) * 100).toFixed(0) : '—';
  const exibidos = Math.min(filtered.length, EXIBIR_LIMITE);

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
          <p className="text-lg font-bold">{total ?? '—'}</p>
        </div>
        {Object.entries(statusConfig).map(([key, cfg]) => {
          const Icon = cfg.icon;
          const count = stats ? stats[key as keyof typeof stats] : '—';
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
        <Badge variant="secondary">{pctConciliado === '—' ? 'conciliação indisponível' : `${pctConciliado}% conciliado`}</Badge>
      </div>

      {/* Truncagem HONESTA: a janela é de LISTA_LIMITE e o filtro tem mais — a busca por
          descrição cobre só o que está carregado, e dizer isso separa recorte de mentira. */}
      {/* Dois cortes existem: a janela do request (LISTA_LIMITE) e o da renderização
          (EXIBIR_LIMITE) — o aviso tem de cobrir os dois, senão afirma 500 e mostra 200. */}
      {totalFiltro !== null && (totalFiltro > items.length || filtered.length > exibidos) && (
        <p className="text-xs text-muted-foreground">
          Exibindo {exibidos} de {totalFiltro} itens do filtro — a busca por descrição cobre só os
          {' '}{items.length} carregados. Refine por status ou conta corrente para ver o resto.
        </p>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <PageSkeleton variant="list" className="p-4" />
          ) : falhaLeitura ? (
            <div role="alert" className="text-center py-16 text-sm text-status-error">
              Não foi possível carregar a conciliação — os números acima ficam indisponíveis até a
              leitura voltar. Recarregue a página.
            </div>
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
                  {filtered.slice(0, EXIBIR_LIMITE).map(item => {
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
