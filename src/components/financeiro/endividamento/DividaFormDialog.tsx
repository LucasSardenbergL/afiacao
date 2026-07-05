// src/components/financeiro/endividamento/DividaFormDialog.tsx
// Cadastro/edição de dívida + editor simples de parcelas (F1 endividamento).
// Espelha IniciativaDialog.tsx: react-hook-form + zodResolver + Controller; toast sonner.
import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COMPANIES } from '@/contexts/CompanyContext';
import { useUpsertDivida, useReplaceParcelas } from '@/hooks/useEndividamento';
import type {
  Divida,
  Parcela,
  Company,
  TipoDivida,
  CpInclusionStatus,
} from '@/lib/financeiro/endividamento-types';

const TIPO_LABEL: Record<TipoDivida, string> = {
  capital_giro: 'Capital de giro',
  financiamento: 'Financiamento',
  antecipacao_recorrente: 'Antecipação recorrente',
  outro: 'Outro',
};

const CP_OPCOES: Array<{ value: CpInclusionStatus; label: string }> = [
  { value: 'sim', label: 'Sim — já aparece' },
  { value: 'nao', label: 'Não aparece' },
  { value: 'parcial', label: 'Em parte' },
  { value: 'nao_sei', label: 'Não sei' },
];

// '' → null; número quando presente. Ausente ≠ zero (money-path).
const numOpcional = (v: string): number | null => {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const num = (v: string): number => numOpcional(v) ?? 0;

const VALOR_REGEX = /^\d{1,15}([.,]\d{1,2})?$/;
const valorObrig = z
  .string()
  .trim()
  .refine((s) => VALOR_REGEX.test(s), 'Informe um valor (ex.: 15000 ou 15000,00)')
  .refine((s) => num(s) > 0, 'Deve ser maior que zero');
const valorOpc = z
  .string()
  .trim()
  .refine((s) => s === '' || VALOR_REGEX.test(s), 'Valor inválido (ex.: 15000,00)');

const dividaSchema = z.object({
  company: z.enum(['colacor', 'oben', 'colacor_sc']),
  credor: z.string().trim().min(1, 'Informe o credor'),
  tipo: z.enum(['capital_giro', 'financiamento', 'antecipacao_recorrente', 'outro']),
  principal_contratado: valorObrig,
  saldo_devedor_informado: valorOpc,
  cp_inclusion_status: z.enum(['sim', 'nao', 'parcial', 'nao_sei']),
  data_contratacao: z.string().min(1, 'Informe a data de contratação'), // NOT NULL no banco
  cet_aa: valorOpc,
  indexador: z.string(),
  coobrigada_por: z.string(), // '' | Company
  observacao: z.string(),
});

type DividaFormValues = z.infer<typeof dividaSchema>;

// ─── Linha de parcela no editor local ────────────────────────────────────────────
interface ParcelaRow {
  key: string; // chave estável de UI
  numero_parcela: string;
  data_vencimento: string;
  valor_amortizacao: string;
  valor_juros: string;
  valor_total: string;
  estimado: boolean;
  pago: boolean;
}

function novaLinha(numero: number): ParcelaRow {
  return {
    key: crypto.randomUUID(),
    numero_parcela: String(numero),
    data_vencimento: '',
    valor_amortizacao: '',
    valor_juros: '',
    valor_total: '',
    estimado: false,
    pago: false,
  };
}

function parcelaToRow(p: Parcela): ParcelaRow {
  return {
    key: p.id,
    numero_parcela: String(p.numero_parcela),
    data_vencimento: p.data_vencimento ?? '',
    valor_amortizacao: p.valor_amortizacao != null ? String(p.valor_amortizacao) : '',
    valor_juros: p.valor_juros != null ? String(p.valor_juros) : '',
    valor_total: p.valor_total != null ? String(p.valor_total) : '',
    estimado: p.estimado === true,
    pago: p.pago === true,
  };
}

function dividaToForm(d: Divida | null): DividaFormValues {
  return {
    company: (d?.company as Company) ?? 'colacor',
    credor: d?.credor ?? '',
    tipo: (d?.tipo as TipoDivida) ?? 'capital_giro',
    principal_contratado: d?.principal_contratado != null ? String(d.principal_contratado) : '',
    saldo_devedor_informado:
      d?.saldo_devedor_informado != null ? String(d.saldo_devedor_informado) : '',
    cp_inclusion_status: (d?.cp_inclusion_status as CpInclusionStatus) ?? 'nao_sei',
    data_contratacao: d?.data_contratacao ?? '',
    cet_aa: d?.cet_aa != null ? String(d.cet_aa) : '',
    indexador: d?.indexador ?? '',
    coobrigada_por: d?.coobrigada_por ?? '',
    observacao: d?.observacao ?? '',
  };
}

const SEM_COOBRIGACAO = '__nenhuma__';

interface DividaFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = criar nova. */
  divida: Divida | null;
  /** Parcelas já existentes da dívida em edição. */
  parcelas: Parcela[];
  /** Empresa pré-selecionada ao criar. */
  defaultCompany: Company;
}

export function DividaFormDialog({
  open,
  onOpenChange,
  divida,
  parcelas,
  defaultCompany,
}: DividaFormDialogProps) {
  const upsert = useUpsertDivida();
  const replaceParcelas = useReplaceParcelas();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<DividaFormValues>({
    resolver: zodResolver(dividaSchema),
    defaultValues: dividaToForm(divida),
  });

  const [linhas, setLinhas] = useState<ParcelaRow[]>([]);

  useEffect(() => {
    if (!open) return;
    reset({ ...dividaToForm(divida), company: divida?.company ?? defaultCompany });
    setLinhas(
      parcelas.length > 0
        ? [...parcelas].sort((a, b) => a.numero_parcela - b.numero_parcela).map(parcelaToRow)
        : [],
    );
  }, [open, divida, parcelas, defaultCompany, reset]);

  const addLinha = () => setLinhas((ls) => [...ls, novaLinha(ls.length + 1)]);
  const removeLinha = (key: string) => setLinhas((ls) => ls.filter((l) => l.key !== key));
  const setLinha = (key: string, patch: Partial<ParcelaRow>) =>
    setLinhas((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const salvando = upsert.isPending || replaceParcelas.isPending;

  const onSubmit = async (v: DividaFormValues) => {
    // id estável: reusa o da dívida em edição, senão gera (necessário p/ associar as parcelas).
    const id = divida?.id ?? crypto.randomUUID();
    const company = v.company;

    const payload: Partial<Divida> & { company: Company } = {
      id,
      company,
      credor: v.credor.trim(),
      tipo: v.tipo,
      principal_contratado: num(v.principal_contratado),
      saldo_devedor_informado: numOpcional(v.saldo_devedor_informado),
      cp_inclusion_status: v.cp_inclusion_status,
      data_contratacao: v.data_contratacao, // obrigatória no schema (NOT NULL no banco)
      cet_aa: numOpcional(v.cet_aa),
      indexador: v.indexador.trim() || null,
      coobrigada_por: (v.coobrigada_por || null) as Company | null,
      observacao: v.observacao.trim() || null,
      ativo: divida?.ativo ?? true,
    };

    const parcelasPayload: Array<Omit<Parcela, 'id' | 'divida_id'>> = linhas.map((l, i) => ({
      numero_parcela: Number(l.numero_parcela) || i + 1,
      data_vencimento: l.data_vencimento,
      valor_amortizacao: num(l.valor_amortizacao),
      valor_juros: num(l.valor_juros),
      valor_total: num(l.valor_total),
      estimado: l.estimado,
      pago: l.pago,
    }));

    try {
      await upsert.mutateAsync(payload);
      await replaceParcelas.mutateAsync({ dividaId: id, company, parcelas: parcelasPayload });
      onOpenChange(false);
    } catch {
      // toast já disparado no onError dos hooks
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{divida ? 'Editar dívida' : 'Nova dívida'}</DialogTitle>
          <DialogDescription>
            Cadastro manual do endividamento. Os indicadores (serviço da dívida, DSCR-caixa) leem
            estes dados — capriche na inclusão no contas-a-pagar abaixo.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* ── Identificação ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Empresa</Label>
              <Controller
                control={control}
                name="company"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(COMPANIES) as Array<keyof typeof COMPANIES>).map((c) => (
                        <SelectItem key={c} value={c}>
                          {COMPANIES[c].name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Controller
                control={control}
                name="tipo"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TIPO_LABEL) as TipoDivida[]).map((t) => (
                        <SelectItem key={t} value={t}>
                          {TIPO_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="div-credor">Credor</Label>
            <Input id="div-credor" {...register('credor')} placeholder="Ex.: Banco do Brasil" />
            {errors.credor && <p className="text-xs text-status-error">{errors.credor.message}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="div-principal">Principal contratado (R$)</Label>
              <Input
                id="div-principal"
                inputMode="decimal"
                placeholder="Ex.: 100000"
                {...register('principal_contratado')}
              />
              {errors.principal_contratado && (
                <p className="text-xs text-status-error">{errors.principal_contratado.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="div-saldo">Saldo devedor informado (R$)</Label>
              <Input
                id="div-saldo"
                inputMode="decimal"
                placeholder="Em branco = derivado das parcelas"
                {...register('saldo_devedor_informado')}
              />
              {errors.saldo_devedor_informado && (
                <p className="text-xs text-status-error">
                  {errors.saldo_devedor_informado.message}
                </p>
              )}
            </div>
          </div>

          {/* ── Inclusão no contas-a-pagar (crítico p/ DSCR) ── */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <Label className="text-sm">
              As parcelas desta dívida já aparecem no seu contas-a-pagar do Omie?
            </Label>
            <p className="text-xs text-muted-foreground">
              Isto evita contar a dívida duas vezes na projeção de caixa (o DSCR usa esta resposta).
            </p>
            <Controller
              control={control}
              name="cp_inclusion_status"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  className="grid grid-cols-2 gap-2 pt-1"
                >
                  {CP_OPCOES.map((o) => (
                    <div key={o.value} className="flex items-center gap-2">
                      <RadioGroupItem value={o.value} id={`cp-${o.value}`} />
                      <Label htmlFor={`cp-${o.value}`} className="font-normal text-sm">
                        {o.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              )}
            />
          </div>

          {/* ── Detalhes opcionais ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="div-data">Data de contratação</Label>
              <Input id="div-data" type="date" {...register('data_contratacao')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="div-cet">CET (% a.a.)</Label>
              <Input
                id="div-cet"
                inputMode="decimal"
                placeholder="Ex.: 18,5"
                {...register('cet_aa')}
              />
              {errors.cet_aa && <p className="text-xs text-status-error">{errors.cet_aa.message}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="div-indexador">Indexador</Label>
              <Input id="div-indexador" placeholder="Ex.: CDI+3%" {...register('indexador')} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Coobrigada por</Label>
            <Controller
              control={control}
              name="coobrigada_por"
              render={({ field }) => (
                <Select
                  value={field.value === '' ? SEM_COOBRIGACAO : field.value}
                  onValueChange={(val) => field.onChange(val === SEM_COOBRIGACAO ? '' : val)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SEM_COOBRIGACAO}>Nenhuma</SelectItem>
                    {(Object.keys(COMPANIES) as Array<keyof typeof COMPANIES>).map((c) => (
                      <SelectItem key={c} value={c}>
                        {COMPANIES[c].name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Só preencha se outra empresa do grupo avaliza esta dívida.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="div-obs">Observação</Label>
            <Textarea id="div-obs" rows={2} {...register('observacao')} />
          </div>

          {/* ── Editor de parcelas ── */}
          <ParcelasEditor
            linhas={linhas}
            onAdd={addLinha}
            onRemove={removeLinha}
            onChange={setLinha}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={salvando}>
              {salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {divida ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Editor de parcelas (tabela editável) ────────────────────────────────────────

function ParcelasEditor({
  linhas,
  onAdd,
  onRemove,
  onChange,
}: {
  linhas: ParcelaRow[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  onChange: (key: string, patch: Partial<ParcelaRow>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Parcelas</Label>
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Adicionar
        </Button>
      </div>

      {linhas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Sem parcelas. Adicione ao menos as dos próximos meses para o serviço da dívida ficar
          correto.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-left">
                <th className="px-2 py-1.5 font-medium">Nº</th>
                <th className="px-2 py-1.5 font-medium">Vencimento</th>
                <th className="px-2 py-1.5 font-medium">Amortização</th>
                <th className="px-2 py-1.5 font-medium">Juros</th>
                <th className="px-2 py-1.5 font-medium">Total</th>
                <th className="px-2 py-1.5 font-medium text-center">Estim.</th>
                <th className="px-2 py-1.5 font-medium text-center">Pago</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => {
                const total = num(l.valor_total);
                const soma = num(l.valor_amortizacao) + num(l.valor_juros);
                const inconsistente = total > 0 && total < soma;
                return (
                  <tr key={l.key} className="border-b border-border last:border-0 align-top">
                    <td className="px-1 py-1 w-12">
                      <Input
                        className="h-8"
                        inputMode="numeric"
                        value={l.numero_parcela}
                        onChange={(e) => onChange(l.key, { numero_parcela: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1 w-36">
                      <Input
                        className="h-8"
                        type="date"
                        value={l.data_vencimento}
                        onChange={(e) => onChange(l.key, { data_vencimento: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        className="h-8"
                        inputMode="decimal"
                        value={l.valor_amortizacao}
                        onChange={(e) => onChange(l.key, { valor_amortizacao: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        className="h-8"
                        inputMode="decimal"
                        value={l.valor_juros}
                        onChange={(e) => onChange(l.key, { valor_juros: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        className={`h-8 ${inconsistente ? 'border-status-warning' : ''}`}
                        inputMode="decimal"
                        value={l.valor_total}
                        onChange={(e) => onChange(l.key, { valor_total: e.target.value })}
                      />
                      {inconsistente && (
                        <span className="text-[10px] text-status-warning">
                          menor que amort.+juros
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-center">
                      <Checkbox
                        checked={l.estimado}
                        onCheckedChange={(c) => onChange(l.key, { estimado: c === true })}
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <Checkbox
                        checked={l.pago}
                        onCheckedChange={(c) => onChange(l.key, { pago: c === true })}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => onRemove(l.key)}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
