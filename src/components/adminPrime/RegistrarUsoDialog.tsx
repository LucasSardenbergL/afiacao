// Registrar uso de benefício Prime (staff — writer único).
// Gate de UI (decisão do plano PR-1): só assinatura ATIVA aparece aqui — o
// banco também barra por trigger (suspensa/cancelada congela franquia).
// Afiação amarra valor = quantidade × preço/dente (o banco CHECKa o mesmo);
// competência só dentro da vigência (select gerado, nunca mês futuro).
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/contexts/AuthContext';
import { formatMes, gerarMesesVigencia, mesAtualSP, valorAfiacao } from '@/lib/prime/competencia';
import {
  montarInsertUso,
  parseValorBR,
  usoFormSchema,
  VALOR_BR_REGEX,
  type UsoFormValues,
} from '@/lib/prime/uso-form';
import { formatBRL } from '@/lib/prime/format';
import {
  usePrimeAssinaturas,
  usePrimeExtratoCompetencia,
  useRegistrarUso,
} from '@/queries/usePrimeAdmin';
import {
  BONUS_DENTES_TETO,
  PRECO_DENTE_TABELA,
  PRIME_TIPO_LABEL,
  type PrimeBeneficioTipo,
} from '@/types/prime';

const TIPOS_ORDENADOS: PrimeBeneficioTipo[] = [
  'afiacao_dentes',
  'bonus_dentes',
  'desconto_abrasivo',
  'atendimento_tecnico',
  'prioridade_entrega',
  'prioridade_separacao',
  'coleta_rota',
];

interface RegistrarUsoDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function RegistrarUsoDialog({ open, onOpenChange }: RegistrarUsoDialogProps) {
  const { user } = useAuth();
  const registrar = useRegistrarUso();
  const { data: assinaturas } = usePrimeAssinaturas();

  // Gate de UI: registrar uso SÓ em assinatura ativa (o banco barra as demais).
  const ativas = useMemo(
    () => (assinaturas ?? []).filter((a) => a.status === 'ativa'),
    [assinaturas],
  );

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<UsoFormValues>({
    resolver: zodResolver(usoFormSchema),
    defaultValues: {
      assinatura_id: '',
      tipo: 'afiacao_dentes',
      quantidade: '',
      preco_unitario: PRECO_DENTE_TABELA.toFixed(2).replace('.', ','),
      valor_desconto: '',
      competencia: mesAtualSP(),
      referencia: '',
      descricao: '',
    },
  });

  const assinaturaId = watch('assinatura_id');
  const tipo = watch('tipo');
  const quantidade = watch('quantidade');
  const precoUnitario = watch('preco_unitario');
  const competencia = watch('competencia');

  const assinatura = ativas.find((a) => a.id === assinaturaId);
  const meses = useMemo(
    () => (assinatura ? gerarMesesVigencia(assinatura.data_inicio) : [mesAtualSP()]),
    [assinatura],
  );

  const { data: extrato } = usePrimeExtratoCompetencia(assinaturaId || undefined, competencia);

  const ehDentes = tipo === 'afiacao_dentes' || tipo === 'bonus_dentes';
  const valorPrevisto =
    tipo === 'afiacao_dentes' &&
    /^\d+$/.test(quantidade) &&
    VALOR_BR_REGEX.test(precoUnitario)
      ? valorAfiacao(Number(quantidade), parseValorBR(precoUnitario))
      : null;

  const fechar = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const onSubmit = (values: UsoFormValues) => {
    if (!user) return;
    registrar.mutate(montarInsertUso(values, user.id), {
      onSuccess: () => fechar(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar uso de benefício</DialogTitle>
          <DialogDescription>
            Registro é APPEND-ONLY com contrafactual auditável — errou, estorna e registra de
            novo (nunca edita). Monetizável exige lastro no pedido/NF Omie.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Assinatura (só ativas)</Label>
            <Select
              value={assinaturaId}
              onValueChange={(v) => {
                setValue('assinatura_id', v, { shouldValidate: true });
                setValue('competencia', mesAtualSP());
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione o assinante" />
              </SelectTrigger>
              <SelectContent>
                {ativas.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.cliente?.name ?? a.customer_user_id.slice(0, 8)} ·{' '}
                    {a.franquia_dentes_contratada} dentes/mês
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ativas.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nenhuma assinatura ativa — suspensa/cancelada não recebe uso (franquia congelada).
              </p>
            )}
            {errors.assinatura_id && (
              <p className="text-xs text-status-error">{errors.assinatura_id.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Benefício</Label>
              <Select
                value={tipo}
                onValueChange={(v) => setValue('tipo', v as PrimeBeneficioTipo, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS_ORDENADOS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PRIME_TIPO_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Competência</Label>
              <Select
                value={competencia}
                onValueChange={(v) => setValue('competencia', v, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {meses.map((m) => (
                    <SelectItem key={m} value={m}>
                      {formatMes(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {assinatura && extrato && (
            <p className="text-xs text-muted-foreground">
              Franquia em {formatMes(competencia)}: <strong>{extrato.dentes_restantes}</strong> de{' '}
              {extrato.franquia_total} dentes restantes
              {extrato.dentes_excedentes > 0 && (
                <span className="text-status-warning">
                  {' '}
                  · excedente de {extrato.dentes_excedentes} dentes (faturado normal, exposto no
                  extrato)
                </span>
              )}
            </p>
          )}

          {ehDentes && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="uso-qtd">
                  Dentes{tipo === 'bonus_dentes' ? ` (máx. ${BONUS_DENTES_TETO})` : ''}
                </Label>
                <Input id="uso-qtd" inputMode="numeric" placeholder="96" {...register('quantidade')} />
                {errors.quantidade && (
                  <p className="text-xs text-status-error">{errors.quantidade.message}</p>
                )}
              </div>
              {tipo === 'afiacao_dentes' && (
                <div className="space-y-1.5">
                  <Label htmlFor="uso-preco">Preço/dente (R$)</Label>
                  <Input id="uso-preco" inputMode="decimal" {...register('preco_unitario')} />
                  {errors.preco_unitario && (
                    <p className="text-xs text-status-error">{errors.preco_unitario.message}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {tipo === 'afiacao_dentes' && (
            <p className="text-xs text-muted-foreground">
              Valor de tabela (contrafactual):{' '}
              <strong>{valorPrevisto !== null ? formatBRL(valorPrevisto) : '—'}</strong> = dentes ×
              preço/dente (amarrado no banco)
            </p>
          )}

          {tipo === 'desconto_abrasivo' && (
            <div className="space-y-1.5">
              <Label htmlFor="uso-desconto">Valor do desconto concedido (R$)</Label>
              <Input
                id="uso-desconto"
                inputMode="decimal"
                placeholder="25,00"
                {...register('valor_desconto')}
              />
              {errors.valor_desconto && (
                <p className="text-xs text-status-error">{errors.valor_desconto.message}</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="uso-ref">
              Referência Omie (pedido/NF)
              {tipo === 'afiacao_dentes' || tipo === 'desconto_abrasivo' ? '' : ' — opcional'}
            </Label>
            <Input id="uso-ref" placeholder="PV-12345" {...register('referencia')} />
            {errors.referencia && (
              <p className="text-xs text-status-error">{errors.referencia.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="uso-desc">Descrição (opcional)</Label>
            <Textarea
              id="uso-desc"
              rows={2}
              placeholder="Serra esquadrejadeira 96 dentes — coleta na rota de quinta"
              {...register('descricao')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => fechar(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={registrar.isPending || !user || ativas.length === 0}>
              {registrar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Registrar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
