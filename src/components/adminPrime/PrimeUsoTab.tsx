// Usos de benefício Prime (staff): registrar, auditar e ESTORNAR.
// Estorno é o ÚNICO update que o banco permite (append-only por trigger) —
// registro estornado fica imutável e FORA do extrato.
import { useMemo, useState } from 'react';
import { ClipboardPlus, Loader2, Undo2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { formatMes } from '@/lib/prime/competencia';
import { formatBRL } from '@/lib/prime/format';
import {
  useEstornarUso,
  usePrimeAssinaturas,
  usePrimeUsos,
} from '@/queries/usePrimeAdmin';
import { PRIME_TIPO_LABEL, type PrimeBeneficioUso } from '@/types/prime';
import { RegistrarUsoDialog } from './RegistrarUsoDialog';

export function PrimeUsoTab() {
  const { user } = useAuth();
  const [filtros, setFiltros] = useUrlState<{ assinatura: string; estornados: boolean }>({
    assinatura: 'all',
    estornados: false,
  });
  const { data: usos, isLoading } = usePrimeUsos(filtros.estornados);
  const { data: assinaturas } = usePrimeAssinaturas();
  const estornar = useEstornarUso();
  const [registrarAberto, setRegistrarAberto] = useState(false);
  const [alvoEstorno, setAlvoEstorno] = useState<PrimeBeneficioUso | null>(null);

  const assinaturaInfo = useMemo(() => {
    const mapa: Record<string, string> = {};
    for (const a of assinaturas ?? []) {
      mapa[a.id] = a.cliente?.name ?? a.customer_user_id.slice(0, 8);
    }
    return mapa;
  }, [assinaturas]);

  const filtrados = useMemo(
    () =>
      (usos ?? []).filter(
        (u) => filtros.assinatura === 'all' || u.assinatura_id === filtros.assinatura,
      ),
    [usos, filtros.assinatura],
  );

  const confirmarEstorno = () => {
    if (!alvoEstorno || !user) return;
    estornar.mutate(
      { id: alvoEstorno.id, userId: user.id, tipo: alvoEstorno.tipo },
      { onSuccess: () => setAlvoEstorno(null) },
    );
  };

  if (isLoading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto my-10" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={filtros.assinatura}
          onValueChange={(v) => setFiltros({ assinatura: v })}
        >
          <SelectTrigger className="h-9 w-64">
            <SelectValue placeholder="Todas as assinaturas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as assinaturas</SelectItem>
            {(assinaturas ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.cliente?.name ?? a.customer_user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch
            id="uso-estornados"
            checked={filtros.estornados}
            onCheckedChange={(v) => setFiltros({ estornados: v })}
          />
          <Label htmlFor="uso-estornados" className="text-sm text-muted-foreground">
            Incluir estornados
          </Label>
        </div>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setRegistrarAberto(true)}>
          <ClipboardPlus className="w-4 h-4 mr-2" />
          Registrar uso
        </Button>
      </div>

      {filtrados.length === 0 ? (
        <EmptyState
          icon={ClipboardPlus}
          title="Nenhum uso registrado"
          description="Registre dentes de afiação (com PV do Omie), bônus cross-sell e eventos operacionais — o extrato mensal nasce daqui."
          actionLabel="Registrar uso"
          onAction={() => setRegistrarAberto(true)}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Benefício</TableHead>
                <TableHead className="text-right">Qtd</TableHead>
                <TableHead className="text-right">Valor tabela</TableHead>
                <TableHead>Competência</TableHead>
                <TableHead>Referência</TableHead>
                <TableHead>Registrado em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtrados.map((u) => {
                const estornado = u.estornado_em !== null;
                return (
                  <TableRow key={u.id} className={estornado ? 'opacity-60' : undefined}>
                    <TableCell className="font-medium">
                      {assinaturaInfo[u.assinatura_id] ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {PRIME_TIPO_LABEL[u.tipo] ?? u.tipo}
                      {estornado && (
                        <Badge className="ml-2 bg-muted text-muted-foreground border-transparent">
                          Estornado
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.quantidade}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(u.valor_tabela)}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatMes(u.competencia)}
                    </TableCell>
                    <TableCell className="text-sm">{u.referencia ?? '—'}</TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {new Date(u.created_at).toLocaleDateString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right">
                      {!estornado && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAlvoEstorno(u)}
                          disabled={estornar.isPending}
                        >
                          <Undo2 className="w-3.5 h-3.5 mr-1" />
                          Estornar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <RegistrarUsoDialog open={registrarAberto} onOpenChange={setRegistrarAberto} />

      <AlertDialog open={alvoEstorno !== null} onOpenChange={(v) => !v && setAlvoEstorno(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Estornar registro?</AlertDialogTitle>
            <AlertDialogDescription>
              {alvoEstorno && (
                <>
                  {PRIME_TIPO_LABEL[alvoEstorno.tipo]} · {alvoEstorno.quantidade}
                  {alvoEstorno.valor_tabela !== null &&
                    ` · ${formatBRL(alvoEstorno.valor_tabela)}`}{' '}
                  · {formatMes(alvoEstorno.competencia)}. O registro sai do extrato e fica
                  IMUTÁVEL (auditoria preservada). Para corrigir um erro: estorne e registre de
                  novo.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction disabled={estornar.isPending} onClick={confirmarEstorno}>
              {estornar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Estornar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
