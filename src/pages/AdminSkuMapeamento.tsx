import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Search, ShieldQuestion } from 'lucide-react';
import { toast } from 'sonner';

interface Mapeamento {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  sku_omie: string;
  sku_portal: string | null;
  unidade_portal: string;
  fator_conversao: number;
  ativo: boolean;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface DescricaoLookup {
  sku_codigo_omie: string;
  sku_descricao: string;
}

interface ValidacaoResult {
  faltantes: { empresa: string; fornecedor_nome: string; sku_codigo_omie: string; sku_descricao: string }[];
  suspeitos: Mapeamento[];
  total: number;
  automaticos: number;
  manuais: number;
}

const EMPTY_FORM = {
  empresa: 'OBEN',
  fornecedor_nome: 'RENNER SAYERLACK S/A',
  sku_omie: '',
  sku_portal: '',
  unidade_portal: 'UN',
  fator_conversao: 1,
  ativo: true,
  observacoes: '',
};

export default function AdminSkuMapeamento() {
  const qc = useQueryClient();
  const [filtroEmpresa, setFiltroEmpresa] = useState<string>('__all__');
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>('__all__');
  const [filtroAtivo, setFiltroAtivo] = useState<string>('__all__');
  const [busca, setBusca] = useState('');
  const [openAdd, setOpenAdd] = useState(false);
  const [openValidar, setOpenValidar] = useState(false);
  const [editing, setEditing] = useState<Mapeamento | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [validacao, setValidacao] = useState<ValidacaoResult | null>(null);
  const [validando, setValidando] = useState(false);

  const { data: mapeamentos, isLoading } = useQuery({
    queryKey: ['sku-mapeamento'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sku_fornecedor_externo')
        .select('*')
        .order('empresa')
        .order('fornecedor_nome')
        .order('sku_omie');
      if (error) throw error;
      return data as Mapeamento[];
    },
  });

  // Lookup de descrições do Omie a partir de pedido_compra_item (último valor visto)
  const skusOmie = useMemo(() => (mapeamentos ?? []).map((m) => m.sku_omie), [mapeamentos]);

  const { data: descricoes } = useQuery({
    queryKey: ['sku-descricoes', skusOmie],
    enabled: skusOmie.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao')
        .in('sku_codigo_omie', skusOmie);
      if (error) throw error;
      const map = new Map<string, string>();
      (data as DescricaoLookup[]).forEach((d) => {
        if (!map.has(d.sku_codigo_omie) && d.sku_descricao) {
          map.set(d.sku_codigo_omie, d.sku_descricao);
        }
      });
      return map;
    },
  });

  const empresas = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.empresa))).sort(),
    [mapeamentos],
  );
  const fornecedores = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.fornecedor_nome))).sort(),
    [mapeamentos],
  );

  const filtrados = useMemo(() => {
    return (mapeamentos ?? []).filter((m) => {
      if (filtroEmpresa !== '__all__' && m.empresa !== filtroEmpresa) return false;
      if (filtroFornecedor !== '__all__' && m.fornecedor_nome !== filtroFornecedor) return false;
      if (filtroAtivo === 'ativos' && !m.ativo) return false;
      if (filtroAtivo === 'inativos' && m.ativo) return false;
      if (busca.trim()) {
        const t = busca.trim().toLowerCase();
        const desc = descricoes?.get(m.sku_omie) ?? '';
        return (
          m.sku_omie.toLowerCase().includes(t) ||
          (m.sku_portal ?? '').toLowerCase().includes(t) ||
          desc.toLowerCase().includes(t)
        );
      }
      return true;
    });
  }, [mapeamentos, filtroEmpresa, filtroFornecedor, filtroAtivo, busca, descricoes]);

  const upsertMut = useMutation({
    mutationFn: async (payload: typeof EMPTY_FORM & { id?: number }) => {
      const { id, ...rest } = payload;
      if (id) {
        const { error } = await supabase
          .from('sku_fornecedor_externo')
          .update({ ...rest, atualizado_em: new Date().toISOString() })
          .eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('sku_fornecedor_externo').insert(rest);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sku-mapeamento'] });
      toast.success(editing ? 'Mapeamento atualizado' : 'Mapeamento criado');
      setOpenAdd(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
    onError: (e: any) => toast.error(e?.message ?? 'Erro ao salvar'),
  });

  const handleEdit = (m: Mapeamento) => {
    setEditing(m);
    setForm({
      empresa: m.empresa,
      fornecedor_nome: m.fornecedor_nome,
      sku_omie: m.sku_omie,
      sku_portal: m.sku_portal ?? '',
      unidade_portal: m.unidade_portal,
      fator_conversao: Number(m.fator_conversao),
      ativo: m.ativo,
      observacoes: m.observacoes ?? '',
    });
    setOpenAdd(true);
  };

  const handleNovo = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpenAdd(true);
  };

  const handleValidar = async () => {
    setValidando(true);
    setOpenValidar(true);
    try {
      // SKUs em pedidos Sayerlack OBEN sem mapeamento ativo
      const { data: itens, error: e1 } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao, pedido_id, pedido_compra_sugerido!inner(empresa, fornecedor_nome)')
        .ilike('pedido_compra_sugerido.fornecedor_nome', '%SAYERLACK%')
        .eq('pedido_compra_sugerido.empresa', 'OBEN');
      if (e1) throw e1;

      const skusUnicos = new Map<string, string>();
      (itens as any[] | null)?.forEach((i) => {
        if (!skusUnicos.has(i.sku_codigo_omie)) skusUnicos.set(i.sku_codigo_omie, i.sku_descricao);
      });

      const mapAtivos = new Set(
        (mapeamentos ?? [])
          .filter((m) => m.ativo && m.empresa === 'OBEN' && /SAYERLACK/i.test(m.fornecedor_nome))
          .map((m) => m.sku_omie),
      );

      const faltantes: ValidacaoResult['faltantes'] = [];
      skusUnicos.forEach((desc, sku) => {
        if (!mapAtivos.has(sku)) {
          faltantes.push({
            empresa: 'OBEN',
            fornecedor_nome: 'RENNER SAYERLACK S/A',
            sku_codigo_omie: sku,
            sku_descricao: desc,
          });
        }
      });

      const suspeitos = (mapeamentos ?? []).filter(
        (m) =>
          (m.sku_portal ?? '').trim() === '' ||
          (m.sku_portal ?? '').length < 4 ||
          !/[A-Z]/i.test(m.sku_portal ?? ''),
      );

      const automaticos = (mapeamentos ?? []).filter((m) =>
        (m.observacoes ?? '').toLowerCase().includes('extraído automaticamente'),
      ).length;
      const manuais = (mapeamentos ?? []).length - automaticos;

      setValidacao({
        faltantes,
        suspeitos,
        total: mapeamentos?.length ?? 0,
        automaticos,
        manuais,
      });
    } catch (e: any) {
      toast.error(e?.message ?? 'Erro ao validar');
    } finally {
      setValidando(false);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mapeamento SKU</h1>
          <p className="text-muted-foreground mt-1">
            Liga o código interno (Omie) ao código comercial usado nos portais de fornecedores.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleValidar}>
            <ShieldQuestion className="h-4 w-4 mr-2" />
            Validar mapeamentos
          </Button>
          <Button onClick={handleNovo}>
            <Plus className="h-4 w-4 mr-2" />
            Adicionar mapeamento
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Select value={filtroEmpresa} onValueChange={setFiltroEmpresa}>
            <SelectTrigger><SelectValue placeholder="Empresa" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas as empresas</SelectItem>
              {empresas.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
            <SelectTrigger><SelectValue placeholder="Fornecedor" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos os fornecedores</SelectItem>
              {fornecedores.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filtroAtivo} onValueChange={setFiltroAtivo}>
            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos</SelectItem>
              <SelectItem value="ativos">Apenas ativos</SelectItem>
              <SelectItem value="inativos">Apenas inativos</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar SKU ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mapeamentos</CardTitle>
          <CardDescription>{filtrados.length} de {mapeamentos?.length ?? 0} registros</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Empresa</TableHead>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>SKU Omie</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>SKU Portal</TableHead>
                    <TableHead>Unid.</TableHead>
                    <TableHead>Fator</TableHead>
                    <TableHead>Ativo</TableHead>
                    <TableHead>Observações</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtrados.map((m) => {
                    const desc = descricoes?.get(m.sku_omie);
                    return (
                      <TableRow key={m.id}>
                        <TableCell><Badge variant="outline">{m.empresa}</Badge></TableCell>
                        <TableCell className="text-xs">{m.fornecedor_nome}</TableCell>
                        <TableCell className="font-mono text-xs">{m.sku_omie}</TableCell>
                        <TableCell className="text-xs max-w-[260px] truncate" title={desc ?? ''}>{desc ?? '—'}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {m.sku_portal
                            ? <span>{m.sku_portal}</span>
                            : <Badge variant="destructive">vazio</Badge>}
                        </TableCell>
                        <TableCell>{m.unidade_portal}</TableCell>
                        <TableCell>{Number(m.fator_conversao)}</TableCell>
                        <TableCell>
                          {m.ativo
                            ? <Badge className="bg-green-600">Ativo</Badge>
                            : <Badge variant="secondary">Inativo</Badge>}
                        </TableCell>
                        <TableCell className="text-xs max-w-[220px] truncate" title={m.observacoes ?? ''}>
                          {m.observacoes ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => handleEdit(m)}>Editar</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtrados.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground py-10">
                        Nenhum mapeamento encontrado.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit dialog */}
      <Dialog open={openAdd} onOpenChange={(v) => { setOpenAdd(v); if (!v) { setEditing(null); setForm(EMPTY_FORM); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar mapeamento' : 'Novo mapeamento'}</DialogTitle>
            <DialogDescription>
              Liga um código Omie ao código equivalente no portal do fornecedor.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Empresa</Label>
              <Input value={form.empresa} onChange={(e) => setForm({ ...form, empresa: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <Label>Fornecedor</Label>
              <Input value={form.fornecedor_nome} onChange={(e) => setForm({ ...form, fornecedor_nome: e.target.value })} />
            </div>
            <div>
              <Label>SKU Omie</Label>
              <Input value={form.sku_omie} onChange={(e) => setForm({ ...form, sku_omie: e.target.value })} disabled={!!editing} />
            </div>
            <div>
              <Label>SKU Portal</Label>
              <Input value={form.sku_portal} onChange={(e) => setForm({ ...form, sku_portal: e.target.value })} />
            </div>
            <div>
              <Label>Unidade Portal</Label>
              <Input value={form.unidade_portal} onChange={(e) => setForm({ ...form, unidade_portal: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <Label>Fator de conversão</Label>
              <Input
                type="number"
                step="0.0001"
                value={form.fator_conversao}
                onChange={(e) => setForm({ ...form, fator_conversao: Number(e.target.value) })}
              />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <Switch checked={form.ativo} onCheckedChange={(v) => setForm({ ...form, ativo: v })} />
              <Label>Ativo</Label>
            </div>
            <div className="col-span-2">
              <Label>Observações</Label>
              <Textarea value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAdd(false)}>Cancelar</Button>
            <Button
              onClick={() => upsertMut.mutate({ ...form, id: editing?.id })}
              disabled={upsertMut.isPending || !form.empresa || !form.fornecedor_nome || !form.sku_omie}
            >
              {upsertMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Validar dialog */}
      <Dialog open={openValidar} onOpenChange={setOpenValidar}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Validação dos mapeamentos</DialogTitle>
            <DialogDescription>
              Confere se todos os SKUs usados em pedidos Sayerlack OBEN têm correspondência no portal.
            </DialogDescription>
          </DialogHeader>
          {validando || !validacao ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <Card><CardContent className="pt-4">
                  <div className="text-xs text-muted-foreground">Total</div>
                  <div className="text-2xl font-bold">{validacao.total}</div>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <div className="text-xs text-muted-foreground">Auto</div>
                  <div className="text-2xl font-bold">{validacao.automaticos}</div>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <div className="text-xs text-muted-foreground">Manual</div>
                  <div className="text-2xl font-bold">{validacao.manuais}</div>
                </CardContent></Card>
              </div>

              {validacao.faltantes.length > 0 ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{validacao.faltantes.length} SKU(s) sem mapeamento</AlertTitle>
                  <AlertDescription>
                    <div className="max-h-48 overflow-y-auto mt-2 space-y-1 text-xs">
                      {validacao.faltantes.map((f) => (
                        <div key={f.sku_codigo_omie} className="font-mono">
                          {f.sku_codigo_omie} — {f.sku_descricao}
                        </div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Todos os SKUs do histórico estão mapeados</AlertTitle>
                </Alert>
              )}

              {validacao.suspeitos.length > 0 && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{validacao.suspeitos.length} mapeamento(s) com SKU portal suspeito</AlertTitle>
                  <AlertDescription>
                    <div className="max-h-32 overflow-y-auto mt-2 space-y-1 text-xs">
                      {validacao.suspeitos.map((s) => (
                        <div key={s.id} className="font-mono">
                          {s.sku_omie} → {s.sku_portal ?? '(vazio)'}
                        </div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
