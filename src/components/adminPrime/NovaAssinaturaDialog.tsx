// Nova assinatura Prime — o preço/franquia CONTRATADOS nascem do plano e podem
// ser ajustados aqui (preço de convite do piloto); depois de criados são
// IMUTÁVEIS no banco (grandfathering por trigger). O banco também barra 2ª
// assinatura viva e sobreposição de competência — a UI traduz esses erros.
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { hojeSP } from '@/lib/prime/competencia';
import { formatBRL } from '@/lib/prime/format';
import { parseValorBR, VALOR_BR_REGEX } from '@/lib/prime/uso-form';
import {
  useBuscarClientes,
  useCriarAssinatura,
  usePrimePlanos,
  type ClienteResumo,
} from '@/queries/usePrimeAdmin';

const assinaturaSchema = z.object({
  customer_user_id: z.string().min(1, 'Selecione o cliente'),
  plano_id: z.string().min(1, 'Selecione o plano'),
  preco_contratado: z
    .string()
    .trim()
    .refine((s) => VALOR_BR_REGEX.test(s) && parseValorBR(s) > 0, 'Preço inválido (ex.: 99,00)'),
  franquia_dentes_contratada: z
    .string()
    .trim()
    .refine((s) => /^\d{1,6}$/.test(s), 'Franquia em dentes inteiros (0 ou mais)'),
  data_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data de início'),
  observacao: z.string(),
});

type AssinaturaFormValues = z.infer<typeof assinaturaSchema>;

interface NovaAssinaturaDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function NovaAssinaturaDialog({ open, onOpenChange }: NovaAssinaturaDialogProps) {
  const { user } = useAuth();
  const criar = useCriarAssinatura();
  const { data: planos } = usePrimePlanos();
  const planosAtivos = useMemo(() => (planos ?? []).filter((p) => p.ativo), [planos]);

  const [buscaCliente, setBuscaCliente] = useState('');
  const [clienteAberto, setClienteAberto] = useState(false);
  const [clienteSelecionado, setClienteSelecionado] = useState<ClienteResumo | null>(null);
  const { data: clientes, isFetching: buscandoClientes } = useBuscarClientes(buscaCliente);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<AssinaturaFormValues>({
    resolver: zodResolver(assinaturaSchema),
    defaultValues: {
      customer_user_id: '',
      plano_id: '',
      preco_contratado: '',
      franquia_dentes_contratada: '',
      data_inicio: hojeSP(),
      observacao: '',
    },
  });

  const planoId = watch('plano_id');

  const selecionarPlano = (id: string) => {
    setValue('plano_id', id, { shouldValidate: true });
    const plano = planosAtivos.find((p) => p.id === id);
    if (plano) {
      // Default do catálogo — editável ANTES de criar; imutável depois.
      setValue('preco_contratado', String(plano.preco_mensal).replace('.', ','));
      setValue('franquia_dentes_contratada', String(plano.franquia_dentes));
    }
  };

  const selecionarCliente = (c: ClienteResumo) => {
    setClienteSelecionado(c);
    setValue('customer_user_id', c.user_id, { shouldValidate: true });
    setClienteAberto(false);
  };

  const fechar = (v: boolean) => {
    if (!v) {
      reset();
      setClienteSelecionado(null);
      setBuscaCliente('');
    }
    onOpenChange(v);
  };

  const onSubmit = (values: AssinaturaFormValues) => {
    if (!user) return;
    criar.mutate(
      {
        customer_user_id: values.customer_user_id,
        plano_id: values.plano_id,
        preco_contratado: parseValorBR(values.preco_contratado),
        franquia_dentes_contratada: Number(values.franquia_dentes_contratada),
        data_inicio: values.data_inicio,
        observacao: values.observacao.trim() || null,
        created_by: user.id,
      },
      { onSuccess: () => fechar(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova assinatura</DialogTitle>
          <DialogDescription>
            Preço e franquia são CONGELADOS na adesão (grandfathering) — depois de criada,
            mudança de condição = cancelar e abrir novo ciclo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Cliente</Label>
            <Popover open={clienteAberto} onOpenChange={setClienteAberto}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={clienteAberto}
                  className="w-full justify-between font-normal"
                >
                  {clienteSelecionado
                    ? `${clienteSelecionado.name}${clienteSelecionado.document ? ` · ${clienteSelecionado.document}` : ''}`
                    : 'Buscar cliente aprovado…'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Nome, razão social ou documento (mín. 2 letras)"
                    value={buscaCliente}
                    onValueChange={setBuscaCliente}
                  />
                  <CommandList>
                    <CommandEmpty>
                      {buscandoClientes
                        ? 'Buscando…'
                        : buscaCliente.trim().length < 2
                          ? 'Digite pelo menos 2 caracteres'
                          : 'Nenhum cliente aprovado encontrado'}
                    </CommandEmpty>
                    <CommandGroup>
                      {(clientes ?? []).map((c) => (
                        <CommandItem
                          key={c.user_id}
                          value={c.user_id}
                          onSelect={() => selecionarCliente(c)}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4',
                              clienteSelecionado?.user_id === c.user_id
                                ? 'opacity-100'
                                : 'opacity-0',
                            )}
                          />
                          <span className="truncate">
                            {c.name}
                            {c.razao_social && c.razao_social !== c.name && (
                              <span className="text-muted-foreground"> · {c.razao_social}</span>
                            )}
                            {c.document && (
                              <span className="text-muted-foreground"> · {c.document}</span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {errors.customer_user_id && (
              <p className="text-xs text-status-error">{errors.customer_user_id.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Plano (catálogo ativo)</Label>
            <Select value={planoId} onValueChange={selecionarPlano}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione o plano" />
              </SelectTrigger>
              <SelectContent>
                {planosAtivos.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.nome} — {formatBRL(p.preco_mensal)} · {p.franquia_dentes} dentes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {planosAtivos.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nenhum plano ativo — crie o plano na aba Planos primeiro.
              </p>
            )}
            {errors.plano_id && (
              <p className="text-xs text-status-error">{errors.plano_id.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ass-preco">Preço contratado (R$)</Label>
              <Input id="ass-preco" inputMode="decimal" {...register('preco_contratado')} />
              {errors.preco_contratado && (
                <p className="text-xs text-status-error">{errors.preco_contratado.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ass-franquia">Franquia contratada (dentes)</Label>
              <Input
                id="ass-franquia"
                inputMode="numeric"
                {...register('franquia_dentes_contratada')}
              />
              {errors.franquia_dentes_contratada && (
                <p className="text-xs text-status-error">
                  {errors.franquia_dentes_contratada.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ass-inicio">Data de início</Label>
            <Input id="ass-inicio" type="date" {...register('data_inicio')} />
            {errors.data_inicio && (
              <p className="text-xs text-status-error">{errors.data_inicio.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ass-obs">Observação (opcional)</Label>
            <Textarea id="ass-obs" rows={2} {...register('observacao')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => fechar(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={criar.isPending || !user}>
              {criar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Criar assinatura
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
