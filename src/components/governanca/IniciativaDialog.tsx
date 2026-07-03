// Dialog de criar/editar iniciativa do Painel Iceberg.
// Espelha no client o CHECK do banco: status 'recorrente' exige evidência.
import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { COMPANIES } from '@/contexts/CompanyContext';
import { useStaffUsersWithDept } from '@/hooks/useDepartmentsAdmin';
import {
  ALAVANCA_INICIATIVA,
  STATUS_INICIATIVA,
  useIniciativaMutations,
  type IniciativaIceberg,
  type NovaIniciativa,
} from '@/hooks/useIniciativasIceberg';
import { track } from '@/lib/analytics';

const SEM_DONO = '__sem_dono__';
const VALOR_REGEX = /^\d{1,12}([.,]\d{1,2})?$/;

const valorOpcional = z
  .string()
  .trim()
  .refine((s) => s === '' || VALOR_REGEX.test(s), 'Valor inválido (use 1234,56)');

/** Exportado para teste: espelha o CHECK gov_iniciativas_recorrente_exige_evidencia. */
export const iniciativaSchema = z
  .object({
    titulo: z.string().trim().min(3, 'Dê um título (mín. 3 caracteres)'),
    empresa: z.enum(['colacor', 'oben', 'colacor_sc']),
    alavanca: z.enum(['receita', 'margem', 'custo', 'caixa', 'risco', 'outro']),
    status: z.enum(['ideia', 'em_execucao', 'maturando', 'recorrente', 'pausada', 'cancelada']),
    dono_id: z.string(),
    ganho_esperado_mensal: valorOpcional,
    ganho_recorrente_mensal: valorOpcional,
    inicio_em: z.string(),
    recorrente_desde: z.string(),
    descricao: z.string(),
    evidencia: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'recorrente' && v.evidencia.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidencia'],
        message: 'Marcar "Recorrente" exige registrar a evidência do ganho.',
      });
    }
  });

export type IniciativaFormValues = z.infer<typeof iniciativaSchema>;

/** '' → null (ausente ≠ zero: campo vazio nunca vira 0). */
function parseValor(s: string): number | null {
  const t = s.trim();
  return t === '' ? null : Number(t.replace(',', '.'));
}

function rowToForm(i: IniciativaIceberg | null): IniciativaFormValues {
  return {
    titulo: i?.titulo ?? '',
    empresa: (i?.empresa as IniciativaFormValues['empresa']) ?? 'colacor',
    alavanca: (i?.alavanca as IniciativaFormValues['alavanca']) ?? 'outro',
    status: (i?.status as IniciativaFormValues['status']) ?? 'ideia',
    dono_id: i?.dono_id ?? SEM_DONO,
    ganho_esperado_mensal: i?.ganho_esperado_mensal != null ? String(i.ganho_esperado_mensal) : '',
    ganho_recorrente_mensal:
      i?.ganho_recorrente_mensal != null ? String(i.ganho_recorrente_mensal) : '',
    inicio_em: i?.inicio_em ?? '',
    recorrente_desde: i?.recorrente_desde ?? '',
    descricao: i?.descricao ?? '',
    evidencia: i?.evidencia ?? '',
  };
}

interface IniciativaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = criar nova. */
  iniciativa: IniciativaIceberg | null;
}

export function IniciativaDialog({ open, onOpenChange, iniciativa }: IniciativaDialogProps) {
  const { criar, atualizar } = useIniciativaMutations();
  const { isMaster } = useAuth();
  const { data: staff } = useStaffUsersWithDept();

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<IniciativaFormValues>({
    resolver: zodResolver(iniciativaSchema),
    defaultValues: rowToForm(iniciativa),
  });

  useEffect(() => {
    if (open) reset(rowToForm(iniciativa));
  }, [open, iniciativa, reset]);

  const statusAtual = watch('status');
  const salvando = criar.isPending || atualizar.isPending;

  const onSubmit = (v: IniciativaFormValues) => {
    const payload: NovaIniciativa = {
      titulo: v.titulo.trim(),
      empresa: v.empresa,
      alavanca: v.alavanca,
      status: v.status,
      dono_id: v.dono_id === SEM_DONO ? null : v.dono_id,
      ganho_esperado_mensal: parseValor(v.ganho_esperado_mensal),
      ganho_recorrente_mensal: parseValor(v.ganho_recorrente_mensal),
      inicio_em: v.inicio_em || null,
      recorrente_desde: v.recorrente_desde || null,
      descricao: v.descricao.trim() || null,
      evidencia: v.evidencia.trim() || null,
    };

    const opts = {
      onSuccess: () => {
        toast.success(iniciativa ? 'Iniciativa atualizada.' : 'Iniciativa criada.');
        track(iniciativa ? 'governanca.iniciativa_atualizada' : 'governanca.iniciativa_criada', {
          empresa: payload.empresa,
          alavanca: payload.alavanca,
          status: payload.status,
        });
        onOpenChange(false);
      },
      onError: (e: Error) => toast.error(`Falha ao salvar: ${e.message}`),
    };

    if (iniciativa) atualizar.mutate({ id: iniciativa.id, patch: payload }, opts);
    else criar.mutate(payload, opts);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{iniciativa ? 'Editar iniciativa' : 'Nova iniciativa'}</DialogTitle>
          <DialogDescription>
            Ganho esperado é aposta; só vira resultado quando o status chega a "Recorrente" com
            evidência registrada.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ini-titulo">Título</Label>
            <Input id="ini-titulo" {...register('titulo')} placeholder="Ex.: Renegociar frete Sayerlack" />
            {errors.titulo && <p className="text-xs text-status-error">{errors.titulo.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Empresa</Label>
              <Controller
                control={control}
                name="empresa"
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
              <Label>Alavanca</Label>
              <Controller
                control={control}
                name="alavanca"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ALAVANCA_INICIATIVA).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Status</Label>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(STATUS_INICIATIVA).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1">
              <Label>Dono</Label>
              {/* Só master reatribui dono — o WITH CHECK da RLS rejeitaria o repasse (achado Codex). */}
              <Controller
                control={control}
                name="dono_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={!isMaster}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_DONO}>Sem dono</SelectItem>
                      {(staff ?? []).map((s) => (
                        <SelectItem key={s.user_id} value={s.user_id}>
                          {s.name ?? s.email ?? s.user_id.slice(0, 8)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ini-esperado">Ganho esperado (R$/mês)</Label>
              <Input
                id="ini-esperado"
                inputMode="decimal"
                placeholder="Em branco = sem estimativa"
                {...register('ganho_esperado_mensal')}
              />
              {errors.ganho_esperado_mensal && (
                <p className="text-xs text-status-error">{errors.ganho_esperado_mensal.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ini-recorrente">Ganho recorrente (R$/mês)</Label>
              <Input
                id="ini-recorrente"
                inputMode="decimal"
                placeholder="Só quando comprovado"
                {...register('ganho_recorrente_mensal')}
              />
              {errors.ganho_recorrente_mensal && (
                <p className="text-xs text-status-error">
                  {errors.ganho_recorrente_mensal.message}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ini-inicio">Início da execução</Label>
              <Input id="ini-inicio" type="date" {...register('inicio_em')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ini-desde">Recorrente desde</Label>
              <Input id="ini-desde" type="date" {...register('recorrente_desde')} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ini-descricao">Descrição</Label>
            <Textarea id="ini-descricao" rows={2} {...register('descricao')} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ini-evidencia">
              Evidência do ganho{statusAtual === 'recorrente' ? ' (obrigatória)' : ''}
            </Label>
            <Textarea
              id="ini-evidencia"
              rows={2}
              placeholder="Como o ganho foi comprovado: relatório, query, comparativo…"
              {...register('evidencia')}
            />
            {errors.evidencia && (
              <p className="text-xs text-status-error">{errors.evidencia.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={salvando}>
              {salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {iniciativa ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
