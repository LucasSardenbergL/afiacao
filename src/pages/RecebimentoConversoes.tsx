import React, { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  ArrowLeftRight, Plus, Loader2, Upload, Pencil, Power, PowerOff, ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const UNIDADES_ORIGEM = ['L', 'KG', 'M', 'M2', 'M3', 'CX'];
const UNIDADES_DESTINO = ['UN', 'PC', 'CX', 'RL', 'GL', 'LT', 'BD'];

const SAYERLACK_CNPJ = '59.104.760/0029-18';

function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 14);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  if (digits.length <= 12) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function validateCnpj(cnpj: string): boolean {
  const digits = cnpj.replace(/\D/g, '');
  return digits.length === 14;
}

interface ConversaoForm {
  cnpj_fornecedor: string;
  codigo_produto_fornecedor: string;
  descricao_produto: string;
  unidade_origem: string;
  unidade_destino: string;
  fator_conversao: string;
}

const EMPTY_FORM: ConversaoForm = {
  cnpj_fornecedor: '',
  codigo_produto_fornecedor: '',
  descricao_produto: '',
  unidade_origem: 'L',
  unidade_destino: 'UN',
  fator_conversao: '',
};

export default function RecebimentoConversoes() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConversaoForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  // Fetch conversions
  const { data: conversoes, isLoading } = useQuery({
    queryKey: ['conversao_unidades'],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from('conversao_unidades' as any)
        .select('*')
        .order('cnpj_fornecedor')
        .order('codigo_produto_fornecedor') as any);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  // Group by supplier
  const grouped = useMemo(() => {
    const map = new Map<string, any[]>();
    (conversoes ?? []).forEach((c: any) => {
      const key = c.cnpj_fornecedor;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    });
    return map;
  }, [conversoes]);

  const updateField = (field: keyof ConversaoForm, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (conv: any) => {
    setEditingId(conv.id);
    setForm({
      cnpj_fornecedor: formatCnpj(conv.cnpj_fornecedor),
      codigo_produto_fornecedor: conv.codigo_produto_fornecedor,
      descricao_produto: conv.descricao_produto ?? '',
      unidade_origem: conv.unidade_origem,
      unidade_destino: conv.unidade_destino,
      fator_conversao: String(conv.fator_conversao),
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const cnpjDigits = form.cnpj_fornecedor.replace(/\D/g, '');
    if (!validateCnpj(form.cnpj_fornecedor)) {
      toast.error('CNPJ inválido — deve ter 14 dígitos');
      return;
    }
    if (!form.codigo_produto_fornecedor.trim()) {
      toast.error('Código do produto é obrigatório');
      return;
    }
    const fator = parseFloat(form.fator_conversao);
    if (isNaN(fator) || fator <= 0) {
      toast.error('Fator de conversão deve ser um número positivo');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        cnpj_fornecedor: cnpjDigits,
        codigo_produto_fornecedor: form.codigo_produto_fornecedor.trim(),
        descricao_produto: form.descricao_produto.trim() || null,
        unidade_origem: form.unidade_origem,
        unidade_destino: form.unidade_destino,
        fator_conversao: fator,
        is_active: true,
      };

      if (editingId) {
        const { error } = await (supabase
          .from('conversao_unidades' as any)
          .update(payload as any)
          .eq('id', editingId) as any);
        if (error) throw error;
        toast.success('Conversão atualizada');
      } else {
        const { error } = await (supabase
          .from('conversao_unidades' as any)
          .insert(payload as any) as any);
        if (error) throw error;
        toast.success('Conversão cadastrada');
      }

      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['conversao_unidades'] });
    } catch (err: any) {
      toast.error('Erro: ' + (err.message ?? 'Tente novamente'));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (conv: any) => {
    try {
      const { error } = await (supabase
        .from('conversao_unidades' as any)
        .update({ is_active: !conv.is_active } as any)
        .eq('id', conv.id) as any);
      if (error) throw error;
      toast.success(conv.is_active ? 'Conversão desativada' : 'Conversão reativada');
      queryClient.invalidateQueries({ queryKey: ['conversao_unidades'] });
    } catch (err: any) {
      toast.error('Erro: ' + err.message);
    }
  };

  // CSV import
  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        toast.error('CSV deve ter cabeçalho e pelo menos 1 linha');
        return;
      }

      // Parse header
      const header = lines[0].toLowerCase().split(/[;,]/).map(h => h.trim());
      const idx = {
        cnpj: header.findIndex(h => h.includes('cnpj')),
        codigo: header.findIndex(h => h.includes('codigo') || h.includes('código')),
        descricao: header.findIndex(h => h.includes('descri')),
        origem: header.findIndex(h => h.includes('origem')),
        destino: header.findIndex(h => h.includes('destino')),
        fator: header.findIndex(h => h.includes('fator')),
      };

      if (idx.cnpj < 0 || idx.codigo < 0 || idx.fator < 0) {
        toast.error('CSV deve ter colunas: cnpj, codigo_produto, fator_conversao');
        return;
      }

      const rows: any[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(/[;,]/).map(c => c.trim().replace(/^"|"$/g, ''));
        const cnpj = cols[idx.cnpj]?.replace(/\D/g, '');
        const codigo = cols[idx.codigo];
        const fator = parseFloat(cols[idx.fator]?.replace(',', '.'));

        if (!cnpj || !codigo || isNaN(fator)) continue;

        rows.push({
          cnpj_fornecedor: cnpj,
          codigo_produto_fornecedor: codigo,
          descricao_produto: idx.descricao >= 0 ? cols[idx.descricao] || null : null,
          unidade_origem: idx.origem >= 0 ? cols[idx.origem] || 'L' : 'L',
          unidade_destino: idx.destino >= 0 ? cols[idx.destino] || 'UN' : 'UN',
          fator_conversao: fator,
          is_active: true,
        });
      }

      if (rows.length === 0) {
        toast.error('Nenhuma linha válida encontrada');
        return;
      }

      const { error } = await (supabase
        .from('conversao_unidades' as any)
        .upsert(rows as any, { onConflict: 'cnpj_fornecedor,codigo_produto_fornecedor' }) as any);
      if (error) throw error;

      toast.success(`${rows.length} conversões importadas`);
      queryClient.invalidateQueries({ queryKey: ['conversao_unidades'] });
    } catch (err: any) {
      toast.error('Erro na importação: ' + (err.message ?? ''));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate('/recebimento')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <ArrowLeftRight className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Conversões de Unidade</h1>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCsvImport}
          />
          <Button
            variant="outline" size="sm"
            className="gap-1.5"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            CSV
          </Button>
          <Button size="sm" className="gap-1.5" onClick={openNew}>
            <Plus className="h-4 w-4" /> Nova
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : grouped.size === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ArrowLeftRight className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="text-lg font-medium">Nenhuma conversão cadastrada</p>
            <p className="text-sm mt-1">Adicione manualmente ou importe via CSV</p>
          </CardContent>
        </Card>
      ) : (
        Array.from(grouped.entries()).map(([cnpj, items]) => {
          const descFornecedor = items[0]?.descricao_produto?.includes(' ')
            ? undefined
            : undefined;
          return (
            <div key={cnpj} className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">
                Fornecedor: {formatCnpj(cnpj)}
              </h2>
              <div className="space-y-2">
                {items.map((conv: any) => (
                  <Card
                    key={conv.id}
                    className={cn(!conv.is_active && 'opacity-50')}
                  >
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {conv.codigo_produto_fornecedor}
                          {conv.descricao_produto && (
                            <span className="text-muted-foreground font-normal"> — {conv.descricao_produto}</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          <span className="font-mono font-medium text-foreground">
                            {conv.fator_conversao} {conv.unidade_origem}
                          </span>
                          {' → '}
                          <span className="font-mono font-medium text-foreground">
                            1 {conv.unidade_destino}
                          </span>
                        </p>
                      </div>
                      {!conv.is_active && (
                        <Badge variant="secondary" className="text-xs">Inativo</Badge>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(conv)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
                        onClick={() => toggleActive(conv)}
                      >
                        {conv.is_active ? (
                          <PowerOff className="h-4 w-4 text-destructive" />
                        ) : (
                          <Power className="h-4 w-4 text-green-600" />
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* Form dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar Conversão' : 'Nova Conversão'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>CNPJ do Fornecedor</Label>
              <Input
                value={form.cnpj_fornecedor}
                onChange={(e) => updateField('cnpj_fornecedor', formatCnpj(e.target.value))}
                placeholder={SAYERLACK_CNPJ}
                maxLength={18}
              />
              <p className="text-[10px] text-muted-foreground">
                Sayerlack (filial vendas): {SAYERLACK_CNPJ}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Código do Produto no Fornecedor</Label>
              <Input
                value={form.codigo_produto_fornecedor}
                onChange={(e) => updateField('codigo_produto_fornecedor', e.target.value)}
                placeholder="Ex: S509-1616"
              />
            </div>

            <div className="space-y-2">
              <Label>Descrição do Produto</Label>
              <Input
                value={form.descricao_produto}
                onChange={(e) => updateField('descricao_produto', e.target.value)}
                placeholder="Ex: Verniz Poliuretano 900ml"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Unidade Origem</Label>
                <Select value={form.unidade_origem} onValueChange={(v) => updateField('unidade_origem', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {UNIDADES_ORIGEM.map(u => (
                      <SelectItem key={u} value={u}>{u}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Unidade Destino</Label>
                <Select value={form.unidade_destino} onValueChange={(v) => updateField('unidade_destino', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {UNIDADES_DESTINO.map(u => (
                      <SelectItem key={u} value={u}>{u}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Fator de Conversão</Label>
              <Input
                type="number"
                step="0.001"
                min="0.001"
                value={form.fator_conversao}
                onChange={(e) => updateField('fator_conversao', e.target.value)}
                placeholder="0.9"
              />
              <p className="text-[10px] text-muted-foreground">
                Qtd da unidade de origem que equivale a 1 unidade de destino (ex: 0.9 L = 1 lata de 900ml)
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {editingId ? 'Salvar' : 'Cadastrar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
