// src/components/financeiro/antecipacao/AntecipacaoFormDialog.tsx
// F4 — cadastro/edição de uma operação de antecipação. Espelha DividaFormDialog (react-hook-form +
// zodResolver + Controller; toast sonner). Valida os invariantes money-path no cliente (P1-1 líquido ≤
// face+avulsos; prazo positivo) ANTES do banco, e bloqueia lote multi-vencimento (fluxo_nao_suportado).
// Mostra o custo/taxa derivados AO VIVO (helper puro) — o número é honesto, nunca gravado.
import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COMPANIES } from '@/contexts/CompanyContext';
import { useUpsertAntecipacao } from '@/hooks/useAntecipacoes';
import { custoOperacao, motivoFluxoRegistro } from '@/lib/financeiro/antecipacao-helpers';
import type { Antecipacao, Company, TipoAntecipacao } from '@/lib/financeiro/antecipacao-types';

const TIPO_LABEL: Record<TipoAntecipacao, string> = {
  duplicata: 'Desconto de duplicata',
  linha: 'Linha rotativa',
};

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
  .refine((s) => VALOR_REGEX.test(s), 'Informe um valor (ex.: 100000 ou 100000,00)')
  .refine((s) => num(s) > 0, 'Deve ser maior que zero');
const valorOpc = z
  .string()
  .trim()
  .refine((s) => s === '' || VALOR_REGEX.test(s), 'Valor inválido (ex.: 500,00)');

const antecipSchema = z
  .object({
    company: z.enum(['colacor', 'oben', 'colacor_sc']),
    banco: z.string(),
    tipo: z.enum(['duplicata', 'linha']),
    valor_bruto: valorObrig,
    custos_avulsos: valorOpc,
    valor_liquido: valorObrig,
    data_operacao: z.string().min(1, 'Informe a data da operação'),
    data_vencimento: z.string().min(1, 'Informe o vencimento'),
    referencia: z.string(),
    observacao: z.string(),
    lote: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const bruto = num(v.valor_bruto);
    const avulsos = num(v.custos_avulsos);
    const liq = num(v.valor_liquido);
    // P1-1: líquido == face+avulsos é VÁLIDO (custo zero); inválido só se MAIOR.
    if (liq > bruto + avulsos) {
      ctx.addIssue({
        path: ['valor_liquido'],
        code: z.ZodIssueCode.custom,
        message: 'Líquido não pode exceder face + custos avulsos (isso seria ganho, não custo).',
      });
    }
    if (v.data_operacao && v.data_vencimento && v.data_vencimento <= v.data_operacao) {
      ctx.addIssue({
        path: ['data_vencimento'],
        code: z.ZodIssueCode.custom,
        message: 'O vencimento deve ser depois da data da operação.',
      });
    }
    if (motivoFluxoRegistro({ lote: v.lote }) !== 'ok') {
      ctx.addIssue({
        path: ['lote'],
        code: z.ZodIssueCode.custom,
        message: 'Lote com vários vencimentos inventa prazo. Registre uma operação por título/vencimento.',
      });
    }
  });

type AntecipFormValues = z.infer<typeof antecipSchema>;

function toForm(a: Antecipacao | null): AntecipFormValues {
  return {
    company: (a?.company as Company) ?? 'oben',
    banco: a?.banco ?? '',
    tipo: (a?.tipo as TipoAntecipacao) ?? 'duplicata',
    valor_bruto: a?.valor_bruto != null ? String(a.valor_bruto) : '',
    custos_avulsos: a?.custos_avulsos ? String(a.custos_avulsos) : '',
    valor_liquido: a?.valor_liquido != null ? String(a.valor_liquido) : '',
    data_operacao: a?.data_operacao ?? '',
    data_vencimento: a?.data_vencimento ?? '',
    referencia: a?.referencia ?? '',
    observacao: a?.observacao ?? '',
    lote: false,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = criar nova. */
  antecipacao: Antecipacao | null;
  /** Empresa pré-selecionada ao criar. */
  defaultCompany: Company;
}

export function AntecipacaoFormDialog({ open, onOpenChange, antecipacao, defaultCompany }: Props) {
  const upsert = useUpsertAntecipacao();
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<AntecipFormValues>({
    resolver: zodResolver(antecipSchema),
    defaultValues: toForm(antecipacao),
  });

  useEffect(() => {
    if (!open) return;
    reset({ ...toForm(antecipacao), company: antecipacao?.company ?? defaultCompany });
  }, [open, antecipacao, defaultCompany, reset]);

  // Preview do custo/taxa AO VIVO (helper puro; nunca gravado).
  const w = watch();
  const preview = custoOperacao({
    valor_bruto: num(w.valor_bruto ?? ''),
    custos_avulsos: num(w.custos_avulsos ?? ''),
    valor_liquido: num(w.valor_liquido ?? ''),
    data_operacao: w.data_operacao ?? '',
    data_vencimento: w.data_vencimento ?? '',
  });

  const onSubmit = async (v: AntecipFormValues) => {
    const id = antecipacao?.id ?? crypto.randomUUID();
    const payload: Partial<Antecipacao> & { company: Company } = {
      id,
      company: v.company,
      banco: v.banco.trim() || null,
      tipo: v.tipo,
      valor_bruto: num(v.valor_bruto),
      custos_avulsos: num(v.custos_avulsos),
      valor_liquido: num(v.valor_liquido),
      data_operacao: v.data_operacao,
      data_vencimento: v.data_vencimento,
      referencia: v.referencia.trim() || null,
      observacao: v.observacao.trim() || null,
    };
    try {
      await upsert.mutateAsync(payload);
      onOpenChange(false);
    } catch {
      // toast já disparado no onError do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{antecipacao ? 'Editar operação' : 'Nova antecipação'}</DialogTitle>
          <DialogDescription>
            Registre uma operação de antecipação (uma face antecipada, um vencimento). O custo e a taxa são
            calculados a partir dos valores — não os digite.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
                      {(Object.keys(TIPO_LABEL) as TipoAntecipacao[]).map((t) => (
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

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ant-bruto">Face antecipada (R$)</Label>
              <Input id="ant-bruto" inputMode="decimal" placeholder="Ex.: 100000" {...register('valor_bruto')} />
              {errors.valor_bruto && (
                <p className="text-xs text-status-error">{errors.valor_bruto.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ant-avulsos">Custos avulsos (IOF/tarifa, R$)</Label>
              <Input id="ant-avulsos" inputMode="decimal" placeholder="Fora do líquido" {...register('custos_avulsos')} />
              {errors.custos_avulsos && (
                <p className="text-xs text-status-error">{errors.custos_avulsos.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ant-liquido">Líquido recebido (R$)</Label>
              <Input id="ant-liquido" inputMode="decimal" placeholder="O que caiu na conta" {...register('valor_liquido')} />
              {errors.valor_liquido && (
                <p className="text-xs text-status-error">{errors.valor_liquido.message}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ant-oper">Data da operação (dinheiro entrou)</Label>
              <Input id="ant-oper" type="date" {...register('data_operacao')} />
              {errors.data_operacao && (
                <p className="text-xs text-status-error">{errors.data_operacao.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ant-venc">Vencimento do título</Label>
              <Input id="ant-venc" type="date" {...register('data_vencimento')} />
              {errors.data_vencimento && (
                <p className="text-xs text-status-error">{errors.data_vencimento.message}</p>
              )}
            </div>
          </div>

          {/* Preview do custo derivado (helper puro) */}
          {preview.motivo === 'ok' && preview.custo != null && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">Custo desta operação: </span>
              <strong className="tabular-nums">{brl(preview.custo)}</strong>
              <span className="text-muted-foreground">
                {' '}
                em {preview.dias} dias · taxa do período {pct(preview.taxa_periodo ?? 0)} ·{' '}
                {pct(preview.taxa_efetiva_aa ?? 0)} a.a.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ant-ref">Referência (contrato/banco)</Label>
              <Input id="ant-ref" placeholder="Dedup — ex.: nº do contrato" {...register('referencia')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ant-banco">Banco</Label>
              <Input id="ant-banco" placeholder="Ex.: Itaú" {...register('banco')} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ant-obs">Observação</Label>
            <Textarea id="ant-obs" rows={2} {...register('observacao')} />
          </div>

          {/* Guard de lote (fluxo_nao_suportado) */}
          <Controller
            control={control}
            name="lote"
            render={({ field }) => (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="ant-lote"
                    checked={field.value}
                    onCheckedChange={(c) => field.onChange(c === true)}
                  />
                  <Label htmlFor="ant-lote" className="font-normal text-sm">
                    Esta operação cobre vários títulos com vencimentos diferentes?
                  </Label>
                </div>
                {errors.lote && <p className="text-xs text-status-warning">{errors.lote.message}</p>}
              </div>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {antecipacao ? 'Salvar' : 'Registrar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
