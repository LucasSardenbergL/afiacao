// Catálogo de planos Prime (staff). v1 SEM edição de plano — decisão do PR-2
// (lição Rappi, minor 9 do review do PR-1): o descritivo `beneficios` NÃO é
// snapshotado na assinatura, então mudar o copy de um plano com assinantes
// mudaria o que o grandfathered vê. Mudança de oferta = criar plano NOVO;
// desativar plano com assinaturas vivas é bloqueado (a policy de leitura do
// cliente exige `ativo` — desativar cegaria o assinante no /prime do PR-3).
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, PackagePlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/EmptyState';
import { formatBRL } from '@/lib/prime/format';
import { parseValorBR, VALOR_BR_REGEX } from '@/lib/prime/uso-form';
import {
  useCriarPlano,
  usePrimeAssinaturas,
  usePrimePlanos,
  useTogglePlanoAtivo,
} from '@/queries/usePrimeAdmin';
import { toast } from 'sonner';

const planoSchema = z.object({
  nome: z.string().trim().min(3, 'Dê um nome ao plano (mín. 3 caracteres)'),
  preco_mensal: z
    .string()
    .trim()
    .refine((s) => VALOR_BR_REGEX.test(s) && parseValorBR(s) > 0, 'Preço inválido (ex.: 99,00)'),
  franquia_dentes: z
    .string()
    .trim()
    .refine((s) => /^\d{1,6}$/.test(s), 'Franquia em dentes inteiros (0 ou mais)'),
  /** Uma linha por benefício (vira a lista jsonb `beneficios`). */
  beneficios: z.string(),
});

type PlanoFormValues = z.infer<typeof planoSchema>;

function NovoPlanoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const criar = useCriarPlano();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PlanoFormValues>({
    resolver: zodResolver(planoSchema),
    defaultValues: { nome: '', preco_mensal: '', franquia_dentes: '', beneficios: '' },
  });

  const onSubmit = (values: PlanoFormValues) => {
    criar.mutate(
      {
        nome: values.nome.trim(),
        preco_mensal: parseValorBR(values.preco_mensal),
        franquia_dentes: Number(values.franquia_dentes),
        beneficios: values.beneficios
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo plano no catálogo</DialogTitle>
          <DialogDescription>
            Preço e franquia do CATÁLOGO — cada assinatura congela os seus na adesão
            (grandfathering). Plano publicado não se edita: mudança de oferta = novo plano.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plano-nome">Nome</Label>
            <Input id="plano-nome" placeholder="Prime Piloto" {...register('nome')} />
            {errors.nome && <p className="text-xs text-status-error">{errors.nome.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="plano-preco">Mensalidade (R$)</Label>
              <Input
                id="plano-preco"
                inputMode="decimal"
                placeholder="99,00"
                {...register('preco_mensal')}
              />
              {errors.preco_mensal && (
                <p className="text-xs text-status-error">{errors.preco_mensal.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plano-franquia">Franquia (dentes/mês)</Label>
              <Input
                id="plano-franquia"
                inputMode="numeric"
                placeholder="200"
                {...register('franquia_dentes')}
              />
              {errors.franquia_dentes && (
                <p className="text-xs text-status-error">{errors.franquia_dentes.message}</p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plano-beneficios">Benefícios (um por linha — copy do extrato)</Label>
            <Textarea
              id="plano-beneficios"
              rows={4}
              placeholder={'Franquia 200 dentes/mês\nColeta e devolução na rota\nPrioridade separação + entrega'}
              {...register('beneficios')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={criar.isPending}>
              {criar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Criar plano
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PrimePlanosTab() {
  const { data: planos, isLoading } = usePrimePlanos();
  const { data: assinaturas } = usePrimeAssinaturas();
  const toggle = useTogglePlanoAtivo();
  const [novoAberto, setNovoAberto] = useState(false);

  // Assinaturas vivas (não-canceladas) por plano — gate do desativar.
  const vivasPorPlano = useMemo(() => {
    const contagem: Record<string, number> = {};
    for (const a of assinaturas ?? []) {
      if (a.status !== 'cancelada') {
        contagem[a.plano_id] = (contagem[a.plano_id] ?? 0) + 1;
      }
    }
    return contagem;
  }, [assinaturas]);

  const handleToggle = (id: string, ativo: boolean) => {
    if (!ativo && (vivasPorPlano[id] ?? 0) > 0) {
      toast.error(
        `Plano tem ${vivasPorPlano[id]} assinatura(s) viva(s) — desativar esconderia o descritivo dos assinantes. Mudança de oferta = criar plano novo.`,
      );
      return;
    }
    toggle.mutate({ id, ativo });
  };

  if (isLoading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto my-10" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Catálogo — a assinatura congela preço e franquia na adesão (grandfathering).
        </p>
        <Button size="sm" onClick={() => setNovoAberto(true)}>
          <PackagePlus className="w-4 h-4 mr-2" />
          Novo plano
        </Button>
      </div>

      {(planos ?? []).length === 0 ? (
        <EmptyState
          icon={PackagePlus}
          title="Nenhum plano no catálogo"
          description="Crie o plano do piloto quando o preço estiver cravado (spec §5: fórmula da mensalidade)."
          actionLabel="Novo plano"
          onAction={() => setNovoAberto(true)}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plano</TableHead>
                <TableHead className="text-right">Mensalidade</TableHead>
                <TableHead className="text-right">Franquia</TableHead>
                <TableHead className="text-right">Assinaturas vivas</TableHead>
                <TableHead>Benefícios</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(planos ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.nome}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(p.preco_mensal)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.franquia_dentes} dentes</TableCell>
                  <TableCell className="text-right tabular-nums">{vivasPorPlano[p.id] ?? 0}</TableCell>
                  <TableCell className="max-w-[280px]">
                    <span className="text-xs text-muted-foreground line-clamp-2">
                      {p.beneficios.length > 0 ? p.beneficios.join(' · ') : '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    {p.ativo ? (
                      <Badge className="bg-status-success-bg text-status-success border-transparent">
                        Ativo
                      </Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground border-transparent">
                        Desativado
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggle.isPending}
                      onClick={() => handleToggle(p.id, !p.ativo)}
                    >
                      {p.ativo ? 'Desativar' : 'Reativar'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <NovoPlanoDialog open={novoAberto} onOpenChange={setNovoAberto} />
    </div>
  );
}
