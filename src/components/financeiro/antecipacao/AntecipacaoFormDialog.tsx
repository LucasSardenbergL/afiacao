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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
// Preview ao vivo: texto inválido → NaN (custoOperacao degrada e o preview some); '' → 0 (P1-a/Codex).
const numPreview = (v: string): number => {
  const t = (v ?? '').trim();
  if (t === '') return 0;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

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
    // Fluxo declarado sem default (P1-e): força a escolha; lote bloqueia; rollover exige origem.
    fluxo: z.enum(['um_vencimento', 'lote', 'rollover']).optional(),
    operacao_origem_id: z.string(),
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
    if (!v.fluxo) {
      ctx.addIssue({ path: ['fluxo'], code: z.ZodIssueCode.custom, message: 'Escolha o tipo de operação.' });
    } else if (motivoFluxoRegistro({ fluxo: v.fluxo, operacao_origem_id: v.operacao_origem_id || null }) !== 'ok') {
      ctx.addIssue({
        path: [v.fluxo === 'lote' ? 'fluxo' : 'operacao_origem_id'],
        code: z.ZodIssueCode.custom,
        message:
          v.fluxo === 'lote'
            ? 'Lote com vários vencimentos inventa prazo. Registre uma operação por título/vencimento.'
            : 'Selecione a operação de origem do rollover (registra só o caixa novo).',
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
    fluxo: a ? (a.operacao_origem_id ? 'rollover' : 'um_vencimento') : undefined,
    operacao_origem_id: a?.operacao_origem_id ?? '',
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
  /** Operações vivas da empresa (p/ o seletor de origem do rollover, P1-e). */
  operacoes: Antecipacao[];
}

export function AntecipacaoFormDialog({
  open,
  onOpenChange,
  antecipacao,
  defaultCompany,
  operacoes,
}: Props) {
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

  // Preview do custo/taxa AO VIVO (helper puro; nunca gravado). numPreview: inválido → NaN (some).
  const w = watch();
  const origens = operacoes.filter((o) => o.id !== antecipacao?.id);
  const preview = custoOperacao({
    valor_bruto: numPreview(w.valor_bruto ?? ''),
    custos_avulsos: numPreview(w.custos_avulsos ?? ''),
    valor_liquido: numPreview(w.valor_liquido ?? ''),
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
      operacao_origem_id: v.fluxo === 'rollover' ? v.operacao_origem_id || null : null,
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

          {/* Fluxo declarado (P1-e): sem default silencioso — lote bloqueia, rollover exige a origem. */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <Label className="text-sm">Tipo de operação</Label>
            <Controller
              control={control}
              name="fluxo"
              render={({ field }) => (
                <RadioGroup
                  value={field.value ?? ''}
                  onValueChange={field.onChange}
                  className="grid gap-2"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="um_vencimento" id="fluxo-um" />
                    <Label htmlFor="fluxo-um" className="font-normal text-sm">
                      Um único vencimento
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="lote" id="fluxo-lote" />
                    <Label htmlFor="fluxo-lote" className="font-normal text-sm">
                      Lote de vários vencimentos
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="rollover" id="fluxo-roll" />
                    <Label htmlFor="fluxo-roll" className="font-normal text-sm">
                      Renovação/rollover de operação existente
                    </Label>
                  </div>
                </RadioGroup>
              )}
            />
            {errors.fluxo && <p className="text-xs text-status-warning">{errors.fluxo.message}</p>}

            {w.fluxo === 'rollover' && (
              <div className="space-y-1 pt-1">
                <Label className="text-sm">Operação de origem (registra só o caixa NOVO)</Label>
                <Controller
                  control={control}
                  name="operacao_origem_id"
                  render={({ field }) => (
                    <Select value={field.value || undefined} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione a operação renovada" />
                      </SelectTrigger>
                      <SelectContent>
                        {origens.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            Nenhuma operação para renovar.
                          </div>
                        ) : (
                          origens.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {o.banco ?? '—'} · {o.valor_bruto.toLocaleString('pt-BR')} · venc {o.data_vencimento}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.operacao_origem_id && (
                  <p className="text-xs text-status-warning">{errors.operacao_origem_id.message}</p>
                )}
              </div>
            )}
          </div>

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
