import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, AlertTriangle, Search, CheckCircle2, Wrench, ListChecks, PackageSearch } from 'lucide-react';
import { toast } from 'sonner';
import { decodeHtmlEntities } from '@/lib/utils';

// Fila de revisão da BOM destilada (Fase 1A). Lê `pcp_bom_excecoes` — divergências
// entre a malha do Omie e o modelo paramétrico destilado por linha de abrasivo.
// A tabela é nova (aplicada via SQL Editor); ainda não está nos types gerados do
// Supabase → cast `as never`/`as unknown as` no acesso (mesmo padrão de ProductionOrders).
interface Excecao {
  pai_codigo: number;
  componente_codigo: number | null;
  papel: string;
  pai_descricao: string | null;
  componente_descricao: string | null;
  observado: number | null;
  esperado: number | null;
  unidade: string | null;
  status: string;
  materializado_em: string;
  disposicao: string | null;
  disposicao_nota: string | null;
}

type PapelFilter = 'todos' | 'abrasivo_base' | 'fita' | 'cola' | 'catalisador';

const papelLabel: Record<string, string> = {
  abrasivo_base: 'Abrasivo (rolo)',
  fita: 'Fita de emenda',
  cola: 'Cola',
  catalisador: 'Catalisador',
};

// Rótulos honestos: descrevem a DIVERGÊNCIA, sem pré-julgar de quem é o erro
// (cadastro do Omie vs. SKU que legitimamente foge do modelo). O founder decide na disposição.
const statusLabel: Record<string, string> = {
  excecao: 'Diverge do modelo',
  regra_instavel: 'Regra instável (poucos dados)',
  unidade_inesperada: 'Unidade inesperada',
  sem_regra: 'Sem regra para a linha',
  cola_ambigua: 'Cola ambígua (2+ colas)',
  sem_base_cola: 'Sem base de cola',
  sem_quantidade: 'Sem quantidade',
  papel_desconhecido: 'Papel não reconhecido',
};

const disposicaoLabel: Record<string, { label: string; className: string }> = {
  aceitar: { label: 'Aceita (é assim mesmo)', className: 'text-status-success' },
  corrigir_omie: { label: 'Corrigir no Omie', className: 'text-status-warning' },
  regra_especifica: { label: 'Regra específica', className: 'text-status-info' },
};

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

// Fator observado/esperado. |ln(fator)| ≥ ln(3) ⇒ ordem de grandeza fora (≥3× ou ≤1/3):
// forte sinal de dígito errado no cadastro. Retorna null quando não há como comparar.
function calcFator(obs: number | null, esp: number | null): number | null {
  if (obs == null || esp == null || esp === 0) return null;
  return obs / esp;
}
function fatorGrave(fator: number | null): boolean {
  return fator != null && fator > 0 && Math.abs(Math.log(fator)) >= Math.log(3);
}
function fmtFator(fator: number | null): string {
  if (fator == null) return '—';
  if (fator >= 1) return `${nf.format(fator)}×`;
  return `1/${nf.format(1 / fator)}`;
}

const ProducaoBomExcecoes = () => {
  const [rows, setRows] = useState<Excecao[]>([]);
  const [loading, setLoading] = useState(true);
  const [papelFilter, setPapelFilter] = useState<PapelFilter>('todos');
  const [busca, setBusca] = useState('');
  const [verResolvidas, setVerResolvidas] = useState(false);
  const [dispondo, setDispondo] = useState<string | null>(null);

  useEffect(() => {
    loadExcecoes();
  }, []);

  const loadExcecoes = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('pcp_bom_excecoes' as never)
      .select('*')
      .order('materializado_em', { ascending: false });
    if (error) {
      toast.error('Erro ao carregar exceções: ' + error.message);
    } else if (data) {
      setRows(data as unknown as Excecao[]);
    }
    setLoading(false);
  };

  const rowKey = (e: Excecao) => `${e.pai_codigo}|${e.papel}|${e.componente_codigo ?? 0}`;

  const dispor = async (e: Excecao, disposicao: string) => {
    const key = rowKey(e);
    setDispondo(key);
    try {
      const { error } = await supabase.rpc('fn_pcp_dispor_excecao' as never, {
        p_pai: e.pai_codigo,
        p_papel: e.papel,
        p_componente: e.componente_codigo ?? 0,
        p_disposicao: disposicao,
        p_nota: null,
      } as never);
      if (error) throw error;
      // Reflete localmente (evita novo round-trip): materializar não roda aqui, a disposição persiste.
      setRows(prev => prev.map(r => (rowKey(r) === key ? { ...r, disposicao } : r)));
      toast.success(`Marcada como "${disposicaoLabel[disposicao]?.label ?? disposicao}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao dispor exceção');
    } finally {
      setDispondo(null);
    }
  };

  // Pendentes = sem disposição. Contagens por papel são sempre sobre as PENDENTES
  // (é o backlog que importa), independentes da aba selecionada.
  const pendentes = useMemo(() => rows.filter(r => !r.disposicao), [rows]);

  const counts = useMemo(() => ({
    todos: pendentes.length,
    abrasivo_base: pendentes.filter(r => r.papel === 'abrasivo_base').length,
    fita: pendentes.filter(r => r.papel === 'fita').length,
    cola: pendentes.filter(r => r.papel === 'cola').length,
    catalisador: pendentes.filter(r => r.papel === 'catalisador').length,
  }), [pendentes]);

  const cintasAfetadas = useMemo(
    () => new Set(pendentes.map(r => r.pai_codigo)).size,
    [pendentes],
  );

  const filtered = useMemo(() => {
    const base = verResolvidas ? rows : pendentes;
    const q = busca.trim().toLowerCase();
    return base
      .filter(r => papelFilter === 'todos' || r.papel === papelFilter)
      .filter(r => {
        if (!q) return true;
        return (
          String(r.pai_codigo).includes(q) ||
          (r.pai_descricao ?? '').toLowerCase().includes(q) ||
          (r.componente_descricao ?? '').toLowerCase().includes(q)
        );
      })
      // Piores primeiro: maior distância de ordem de grandeza no topo.
      .sort((a, b) => {
        const fa = calcFator(a.observado, a.esperado);
        const fb = calcFator(b.observado, b.esperado);
        const da = fa != null && fa > 0 ? Math.abs(Math.log(fa)) : -1;
        const db = fb != null && fb > 0 ? Math.abs(Math.log(fb)) : -1;
        return db - da;
      });
  }, [rows, pendentes, papelFilter, busca, verResolvidas]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ListChecks className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">Exceções da BOM (revisão de cadastro)</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Divergências entre a malha (estrutura) do Omie e o modelo de consumo destilado por linha de abrasivo.
          Cada linha é um insumo cuja quantidade cadastrada foge do padrão da sua largura/área.
          Revise no Omie e marque a disposição — o restante da BOM (~95% das cintas) já bate exato.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <AlertTriangle className="h-3.5 w-3.5 text-status-warning" />
          {counts.todos} pendentes
        </Badge>
        <Badge variant="outline" className="gap-1">
          <PackageSearch className="h-3.5 w-3.5" />
          {cintasAfetadas} cintas
        </Badge>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={busca}
            onChange={e => setBusca(e.target.value)}
            placeholder="Buscar por código ou descrição da cinta…"
            className="pl-8"
          />
        </div>
        <Button
          variant={verResolvidas ? 'default' : 'outline'}
          size="sm"
          onClick={() => setVerResolvidas(v => !v)}
        >
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          {verResolvidas ? 'Vendo resolvidas' : 'Ver resolvidas'}
        </Button>
      </div>

      <Tabs value={papelFilter} onValueChange={v => setPapelFilter(v as PapelFilter)}>
        <TabsList className="w-full grid grid-cols-3 sm:grid-cols-5 h-auto">
          <TabsTrigger value="todos">Todos ({counts.todos})</TabsTrigger>
          <TabsTrigger value="abrasivo_base">Abrasivo ({counts.abrasivo_base})</TabsTrigger>
          <TabsTrigger value="fita">Fita ({counts.fita})</TabsTrigger>
          <TabsTrigger value="cola">Cola ({counts.cola})</TabsTrigger>
          <TabsTrigger value="catalisador">Catalisador ({counts.catalisador})</TabsTrigger>
        </TabsList>
      </Tabs>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mb-2 text-status-success" />
            <p className="font-medium">Nada aqui</p>
            <p className="text-xs">
              {verResolvidas ? 'Nenhuma exceção resolvida ainda.' : 'Sem exceções pendentes neste filtro.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(e => {
            const fator = calcFator(e.observado, e.esperado);
            const grave = fatorGrave(fator);
            const key = rowKey(e);
            const disp = e.disposicao ? disposicaoLabel[e.disposicao] : null;
            return (
              <Card key={key} className="overflow-hidden">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {decodeHtmlEntities(e.pai_descricao ?? '') || `Cinta ${e.pai_codigo}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Cód. Omie: {e.pai_codigo} · {papelLabel[e.papel] ?? e.papel}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {fator != null && (
                        <Badge variant={grave ? 'destructive' : 'secondary'} className="gap-1">
                          {grave && <AlertTriangle className="h-3 w-3" />}
                          {fmtFator(fator)}
                        </Badge>
                      )}
                      <span className="text-[11px] text-muted-foreground">{statusLabel[e.status] ?? e.status}</span>
                    </div>
                  </div>

                  {e.componente_descricao && (
                    <p className="text-xs text-muted-foreground">
                      Insumo: {decodeHtmlEntities(e.componente_descricao)}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span>
                      Malha diz{' '}
                      <span className="font-mono font-medium text-foreground">
                        {e.observado != null ? nf.format(e.observado) : '—'}
                      </span>{' '}
                      {e.unidade}
                    </span>
                    <span className="text-muted-foreground">
                      modelo espera{' '}
                      <span className="font-mono font-medium text-foreground">
                        {e.esperado != null ? nf.format(e.esperado) : '—'}
                      </span>{' '}
                      {e.unidade}
                    </span>
                  </div>

                  {disp ? (
                    <div className="flex items-center justify-between pt-1">
                      <span className={`text-xs font-medium ${disp.className}`}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1 inline" />
                        {disp.label}
                        {e.disposicao_nota ? ` — ${e.disposicao_nota}` : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={dispondo === key}
                        onClick={() => dispor(e, e.disposicao === 'aceitar' ? 'corrigir_omie' : 'aceitar')}
                      >
                        Reabrir/alterar
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={dispondo === key}
                        onClick={() => dispor(e, 'corrigir_omie')}
                      >
                        {dispondo === key ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wrench className="h-3.5 w-3.5 mr-1" />}
                        Corrigir no Omie
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={dispondo === key}
                        onClick={() => dispor(e, 'aceitar')}
                      >
                        Aceitar (é assim mesmo)
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={dispondo === key}
                        onClick={() => dispor(e, 'regra_especifica')}
                      >
                        Regra específica
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ProducaoBomExcecoes;
