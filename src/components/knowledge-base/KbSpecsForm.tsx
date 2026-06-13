import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Loader2, Save, AlertTriangle } from 'lucide-react';
import { useSaveProductSpecs } from '@/hooks/useSaveProductSpecs';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

const nullableNumber = z
  .preprocess((v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }, z.number().nullable());

const nullableInt = z
  .preprocess((v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }, z.number().int().nullable());

const nullableString = z
  .preprocess((v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }, z.string().nullable());

const schema = z.object({
  product_code: z.string().min(1, 'Obrigatório'),
  product_name: z.string().min(1, 'Obrigatório'),
  supplier: z.string().min(1, 'Obrigatório'),
  product_line: nullableString,
  product_category: nullableString,
  densidade_g_cm3: nullableNumber,
  solidos_pct: nullableNumber,
  viscosidade_aplicacao_s: nullableNumber,
  viscosidade_copo: nullableString,
  brilho_ub: nullableNumber,
  dureza: nullableString,
  rendimento_m2_por_litro: nullableNumber,
  demaos_recomendadas: nullableInt,
  gramatura_g_m2_min: nullableInt,
  gramatura_g_m2_max: nullableInt,
  pot_life_horas: nullableNumber,
  temp_aplicacao_c_min: nullableNumber,
  temp_aplicacao_c_max: nullableNumber,
  umidade_aplicacao_pct_min: nullableNumber,
  umidade_aplicacao_pct_max: nullableNumber,
  catalisador_codigo: nullableString,
  catalisador_proporcao_pct: nullableNumber,
  diluente_codigo: nullableString,
  equipamentos_aplicacao: z.string().default(''),
  lixa_recomendada: nullableString,
  substrato: z.string().default(''),
  secagem_manuseio_h: nullableNumber,
  secagem_empilhamento_h: nullableNumber,
  secagem_total_h: nullableNumber,
  validade_dias: nullableInt,
  temp_armazenamento_c_min: nullableInt,
  temp_armazenamento_c_max: nullableInt,
  certificacoes_aplicaveis: z.string().default(''),
  isento_metais_pesados: z.string().default(''),
  isento_substancias: z.string().default(''),
  diferenciais_chave: z.string().default(''),
  uso_recomendado: nullableString,
  publico_alvo: nullableString,
  extraction_confidence: nullableNumber,
});

type FormValues = z.infer<typeof schema>;

interface Props {
  initialValues: KbExtractedSpec;
  documentId?: string;
  onSaved?: () => void;
  /** B2: quando fornecida, o submit chama isto (com os specs montados) em vez de salvar direto.
   *  O wrapper (KbSpecsEditButton) orquestra diff/preview/RPC. */
  onSubmitOverride?: (specs: KbExtractedSpec) => void;
  /** B2: trava product_code/supplier (identidade) — corrige dados, não troca de produto.
   *  Usa readOnly (não disabled) p/ o valor continuar sendo submetido pelo react-hook-form. */
  lockIdentity?: boolean;
  /** Texto do botão de submit. Default "Aprovar e salvar". */
  submitLabel?: string;
}

function splitTags(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function joinTags(arr: string[] | undefined | null): string {
  return (arr ?? []).join(', ');
}

export function KbSpecsForm({ initialValues, documentId, onSaved, onSubmitOverride, lockIdentity, submitLabel }: Props) {
  const save = useSaveProductSpecs();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema) as unknown as import('react-hook-form').Resolver<FormValues>,
    defaultValues: {
      product_code: initialValues.product_code ?? '',
      product_name: initialValues.product_name ?? '',
      supplier: initialValues.supplier ?? '',
      product_line: initialValues.product_line,
      product_category: initialValues.product_category,
      densidade_g_cm3: initialValues.densidade_g_cm3,
      solidos_pct: initialValues.solidos_pct,
      viscosidade_aplicacao_s: initialValues.viscosidade_aplicacao_s,
      viscosidade_copo: initialValues.viscosidade_copo,
      brilho_ub: initialValues.brilho_ub,
      dureza: initialValues.dureza,
      rendimento_m2_por_litro: initialValues.rendimento_m2_por_litro,
      demaos_recomendadas: initialValues.demaos_recomendadas,
      gramatura_g_m2_min: initialValues.gramatura_g_m2_min,
      gramatura_g_m2_max: initialValues.gramatura_g_m2_max,
      pot_life_horas: initialValues.pot_life_horas,
      temp_aplicacao_c_min: initialValues.temp_aplicacao_c_min,
      temp_aplicacao_c_max: initialValues.temp_aplicacao_c_max,
      umidade_aplicacao_pct_min: initialValues.umidade_aplicacao_pct_min,
      umidade_aplicacao_pct_max: initialValues.umidade_aplicacao_pct_max,
      catalisador_codigo: initialValues.catalisador_codigo,
      catalisador_proporcao_pct: initialValues.catalisador_proporcao_pct,
      diluente_codigo: initialValues.diluente_codigo,
      equipamentos_aplicacao: joinTags(initialValues.equipamentos_aplicacao),
      lixa_recomendada: initialValues.lixa_recomendada,
      substrato: joinTags(initialValues.substrato),
      secagem_manuseio_h: initialValues.secagem_manuseio_h,
      secagem_empilhamento_h: initialValues.secagem_empilhamento_h,
      secagem_total_h: initialValues.secagem_total_h,
      validade_dias: initialValues.validade_dias,
      temp_armazenamento_c_min: initialValues.temp_armazenamento_c_min,
      temp_armazenamento_c_max: initialValues.temp_armazenamento_c_max,
      certificacoes_aplicaveis: joinTags(initialValues.certificacoes_aplicaveis),
      isento_metais_pesados: joinTags(initialValues.isento_metais_pesados),
      isento_substancias: joinTags(initialValues.isento_substancias),
      diferenciais_chave: joinTags(initialValues.diferenciais_chave),
      uso_recomendado: initialValues.uso_recomendado,
      publico_alvo: initialValues.publico_alvo,
      extraction_confidence: initialValues.extraction_confidence,
    },
  });

  const onSubmit = (values: FormValues) => {
    const specs: KbExtractedSpec = {
      product_code: values.product_code,
      product_name: values.product_name,
      supplier: values.supplier,
      product_line: values.product_line,
      product_category: values.product_category,
      densidade_g_cm3: values.densidade_g_cm3,
      solidos_pct: values.solidos_pct,
      viscosidade_aplicacao_s: values.viscosidade_aplicacao_s,
      viscosidade_copo: values.viscosidade_copo,
      brilho_ub: values.brilho_ub,
      dureza: values.dureza,
      rendimento_m2_por_litro: values.rendimento_m2_por_litro,
      demaos_recomendadas: values.demaos_recomendadas,
      gramatura_g_m2_min: values.gramatura_g_m2_min,
      gramatura_g_m2_max: values.gramatura_g_m2_max,
      pot_life_horas: values.pot_life_horas,
      temp_aplicacao_c_min: values.temp_aplicacao_c_min,
      temp_aplicacao_c_max: values.temp_aplicacao_c_max,
      umidade_aplicacao_pct_min: values.umidade_aplicacao_pct_min,
      umidade_aplicacao_pct_max: values.umidade_aplicacao_pct_max,
      catalisador_codigo: values.catalisador_codigo,
      catalisador_proporcao_pct: values.catalisador_proporcao_pct,
      diluente_codigo: values.diluente_codigo,
      equipamentos_aplicacao: splitTags(values.equipamentos_aplicacao),
      lixa_recomendada: values.lixa_recomendada,
      substrato: splitTags(values.substrato),
      secagem_manuseio_h: values.secagem_manuseio_h,
      secagem_empilhamento_h: values.secagem_empilhamento_h,
      secagem_total_h: values.secagem_total_h,
      validade_dias: values.validade_dias,
      temp_armazenamento_c_min: values.temp_armazenamento_c_min,
      temp_armazenamento_c_max: values.temp_armazenamento_c_max,
      certificacoes_aplicaveis: splitTags(values.certificacoes_aplicaveis),
      isento_metais_pesados: splitTags(values.isento_metais_pesados),
      isento_substancias: splitTags(values.isento_substancias),
      diferenciais_chave: splitTags(values.diferenciais_chave),
      uso_recomendado: values.uso_recomendado,
      publico_alvo: values.publico_alvo,
      extraction_confidence: values.extraction_confidence,
      extraction_gaps: initialValues.extraction_gaps,
    };
    if (onSubmitOverride) {
      onSubmitOverride(specs);
      return;
    }
    save.mutate(
      { specs, documentId },
      { onSuccess: () => onSaved?.() },
    );
  };

  const Field = ({
    name,
    label,
    type = 'text',
    placeholder,
    readOnly,
  }: {
    name: keyof FormValues;
    label: string;
    type?: string;
    placeholder?: string;
    readOnly?: boolean;
  }) => (
    <div>
      <Label htmlFor={name as string} className="text-xs">
        {label}
      </Label>
      <Input
        id={name as string}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        placeholder={placeholder}
        readOnly={readOnly}
        {...register(name)}
        className={`text-xs h-8 ${readOnly ? 'bg-muted cursor-not-allowed' : ''}`}
      />
      {errors[name] && (
        <div className="text-[10px] text-status-error mt-0.5">
          {String(errors[name]?.message ?? 'inválido')}
        </div>
      )}
    </div>
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {initialValues.extraction_gaps.length > 0 && (
        <Card className="p-2.5 bg-status-warning-bg border-status-warning">
          <div className="flex items-center gap-1.5 text-xs text-status-warning">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>
              Claude não conseguiu extrair: {initialValues.extraction_gaps.join(', ')}
            </span>
          </div>
        </Card>
      )}

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Identificação
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <Field name="product_code" label="Código *" readOnly={lockIdentity} />
          <Field name="supplier" label="Fornecedor *" readOnly={lockIdentity} />
        </div>
        <Field name="product_name" label="Nome *" />
        <div className="grid grid-cols-2 gap-2">
          <Field name="product_line" label="Linha" placeholder="wood_pu, wood_nitro…" />
          <Field
            name="product_category"
            label="Categoria"
            placeholder="primer, verniz, tinta…"
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Físico-químico
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <Field name="densidade_g_cm3" label="Densidade (g/cm³)" type="number" />
          <Field name="solidos_pct" label="Sólidos (%)" type="number" />
          <Field
            name="viscosidade_aplicacao_s"
            label="Viscosidade aplic. (s)"
            type="number"
          />
          <Field name="viscosidade_copo" label="Copo (CF4/CF6/CF8)" />
          <Field name="brilho_ub" label="Brilho (UB)" type="number" />
          <Field name="dureza" label="Dureza (ex: 3H)" />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Aplicação
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <Field name="rendimento_m2_por_litro" label="Rendimento (m²/L)" type="number" />
          <Field name="demaos_recomendadas" label="Demãos" type="number" />
          <Field name="gramatura_g_m2_min" label="Gramatura min (g/m²)" type="number" />
          <Field name="gramatura_g_m2_max" label="Gramatura max (g/m²)" type="number" />
          <Field name="pot_life_horas" label="Pot life (h)" type="number" />
          <Field name="temp_aplicacao_c_min" label="Temp min (°C)" type="number" />
          <Field name="temp_aplicacao_c_max" label="Temp max (°C)" type="number" />
          <Field name="umidade_aplicacao_pct_min" label="Umidade min (%)" type="number" />
          <Field name="umidade_aplicacao_pct_max" label="Umidade max (%)" type="number" />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Compatibilidade
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <Field name="catalisador_codigo" label="Catalisador (código)" />
          <Field
            name="catalisador_proporcao_pct"
            label="Catalisador (%)"
            type="number"
          />
          <Field name="diluente_codigo" label="Diluente (código)" />
          <Field name="lixa_recomendada" label="Lixa" />
        </div>
        <Field
          name="equipamentos_aplicacao"
          label="Equipamentos (vírgula)"
          placeholder="pistola_convencional, tanque_pressao"
        />
        <Field name="substrato" label="Substrato (vírgula)" placeholder="madeira, mdf" />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Secagem & Armazenamento
        </legend>
        <div className="grid grid-cols-3 gap-2">
          <Field name="secagem_manuseio_h" label="Manuseio (h)" type="number" />
          <Field name="secagem_empilhamento_h" label="Empilhamento (h)" type="number" />
          <Field name="secagem_total_h" label="Total (h)" type="number" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field name="validade_dias" label="Validade (dias)" type="number" />
          <Field name="temp_armazenamento_c_min" label="Temp armaz. min" type="number" />
          <Field name="temp_armazenamento_c_max" label="Temp armaz. max" type="number" />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Compliance
        </legend>
        <Field
          name="certificacoes_aplicaveis"
          label="Certificações (vírgula)"
          placeholder="IKEA, LGA, Proposition_65"
        />
        <Field
          name="isento_metais_pesados"
          label="Isento metais pesados (vírgula)"
          placeholder="Cd, Pb, Hg"
        />
        <Field
          name="isento_substancias"
          label="Isento substâncias (vírgula)"
          placeholder="amianto, formaldeido"
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          Notas qualitativas
        </legend>
        <Field
          name="diferenciais_chave"
          label="Diferenciais (vírgula)"
          placeholder="resistencia_risco_superior, toque_sedoso"
        />
        <div>
          <Label htmlFor="uso_recomendado" className="text-xs">
            Uso recomendado
          </Label>
          <Textarea
            id="uso_recomendado"
            {...register('uso_recomendado')}
            className="text-xs min-h-[60px]"
          />
        </div>
        <Field name="publico_alvo" label="Público alvo" />
      </fieldset>

      <div className="flex items-center justify-between pt-2 border-t border-border">
        <div className="text-[10px] text-muted-foreground">
          Confiança da extração:{' '}
          {Math.round((initialValues.extraction_confidence ?? 0) * 100)}%
        </div>
        <Button type="submit" disabled={save.isPending} size="sm">
          {save.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
          ) : (
            <Save className="w-3.5 h-3.5 mr-2" />
          )}
          {submitLabel ?? 'Aprovar e salvar'}
        </Button>
      </div>
    </form>
  );
}
