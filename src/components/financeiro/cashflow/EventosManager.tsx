import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import {
  useEventosRecorrentes, useCreateEventoRecorrente,
  useUpdateEventoRecorrente, useDeleteEventoRecorrente,
  type EventoRecorrente,
} from '@/hooks/useEventosRecorrentes';
import {
  useEventosEventuais, useCreateEventoEventual,
  useUpdateEventoEventual, useDeleteEventoEventual,
  type EventoEventual,
} from '@/hooks/useEventosEventuais';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Pencil, History } from 'lucide-react';
import { toast } from 'sonner';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { formatBRL } from '@/lib/financeiro/cashflow-format';

type Tab = 'recorrentes' | 'eventuais';

export function EventosManager() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<Tab>('recorrentes');
  const [editing, setEditing] = useState<EventoRecorrente | EventoEventual | null>(null);
  const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);

  const recQ = useEventosRecorrentes(activeCompany);
  const evQ = useEventosEventuais(activeCompany);

  const delRec = useDeleteEventoRecorrente();
  const delEv = useDeleteEventoEventual();

  const handleDelete = async (kind: Tab, id: string) => {
    try {
      if (kind === 'recorrentes') await delRec.mutateAsync(id);
      else await delEv.mutateAsync(id);
      toast.success('Evento removido');
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={tab === 'recorrentes' ? 'default' : 'outline'} size="sm" onClick={() => setTab('recorrentes')}>
          Recorrentes ({recQ.data?.length ?? 0})
        </Button>
        <Button variant={tab === 'eventuais' ? 'default' : 'outline'} size="sm" onClick={() => setTab('eventuais')}>
          Eventuais ({evQ.data?.length ?? 0})
        </Button>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setEditing({ id: 'new' } as EventoRecorrente | EventoEventual)}>
            <Plus className="h-3 w-3 mr-1" /> Novo
          </Button>
        </div>
      </div>

      {tab === 'recorrentes' && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Dia</TableHead>
                  <TableHead>Início</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recQ.data ?? []).map(r => (
                  <TableRow key={r.id}>
                    <TableCell>{r.descricao}{r.is_folha && <Badge className="ml-2">folha</Badge>}</TableCell>
                    <TableCell><Badge variant={r.tipo === 'entrada' ? 'default' : 'destructive'}>{r.tipo}</Badge></TableCell>
                    <TableCell className="tabular-nums">{formatBRL(r.valor)}</TableCell>
                    <TableCell>{r.dia_do_mes}</TableCell>
                    <TableCell className="font-mono text-xs">{r.inicio}</TableCell>
                    <TableCell>{r.ativo ? '✓' : '✗'}</TableCell>
                    <TableCell className="space-x-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(r)}><Pencil className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAuditTarget({ table: 'fin_eventos_recorrentes', id: r.id, title: `Recorrente: ${r.descricao}` })}><History className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete('recorrentes', r.id)}><Trash2 className="h-3 w-3" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(recQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhum evento recorrente cadastrado. Adicione folha, aluguel, pró-labore, etc.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {tab === 'eventuais' && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Data prevista</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(evQ.data ?? []).map(e => (
                  <TableRow key={e.id}>
                    <TableCell>{e.descricao}</TableCell>
                    <TableCell><Badge variant={e.tipo === 'entrada' ? 'default' : 'destructive'}>{e.tipo}</Badge></TableCell>
                    <TableCell className="tabular-nums">{formatBRL(e.valor)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.data_prevista}</TableCell>
                    <TableCell><Badge variant="outline">{e.status}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(e)}><Pencil className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAuditTarget({ table: 'fin_eventos_eventuais', id: e.id, title: `Eventual: ${e.descricao}` })}><History className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete('eventuais', e.id)}><Trash2 className="h-3 w-3" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(evQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Nenhum evento eventual. Adicione aportes futuros, compras de máquina, etc.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <EventoFormDialog
        kind={tab}
        company={activeCompany}
        editing={editing}
        onClose={() => setEditing(null)}
      />

      {auditTarget && (
        <AuditTrailDrawer
          open
          onOpenChange={(open) => !open && setAuditTarget(null)}
          tableName={auditTarget.table}
          rowId={auditTarget.id}
          title={auditTarget.title}
        />
      )}
    </div>
  );
}

function EventoFormDialog({
  kind, company, editing, onClose,
}: {
  kind: Tab; company: string;
  editing: (EventoRecorrente | EventoEventual) | null;
  onClose: () => void;
}) {
  const createRec = useCreateEventoRecorrente();
  const updateRec = useUpdateEventoRecorrente();
  const createEv = useCreateEventoEventual();
  const updateEv = useUpdateEventoEventual();

  const isNew = editing?.id === 'new';
  const open = Boolean(editing);

  const [form, setForm] = useState<Record<string, unknown>>({});

  if (open && Object.keys(form).length === 0 && !isNew && editing) {
    setForm(editing as unknown as Record<string, unknown>);
  }
  if (!open && Object.keys(form).length > 0) {
    setForm({});
  }

  const handleSubmit = async () => {
    try {
      if (kind === 'recorrentes') {
        const body = {
          company,
          descricao: String(form.descricao ?? ''),
          valor: Number(form.valor ?? 0),
          tipo: (form.tipo as 'entrada' | 'saida') ?? 'saida',
          categoria_dre: form.categoria_dre as string | null ?? null,
          is_folha: Boolean(form.is_folha),
          dia_do_mes: Number(form.dia_do_mes ?? 1),
          inicio: String(form.inicio ?? new Date().toISOString().slice(0, 10)),
          fim: (form.fim as string | null) ?? null,
          ativo: form.ativo === undefined ? true : Boolean(form.ativo),
          observacao: (form.observacao as string | null) ?? null,
        };
        if (isNew) await createRec.mutateAsync(body);
        else await updateRec.mutateAsync({ id: editing!.id, patch: body });
      } else {
        const body = {
          company,
          descricao: String(form.descricao ?? ''),
          valor: Number(form.valor ?? 0),
          tipo: (form.tipo as 'entrada' | 'saida') ?? 'saida',
          categoria_dre: form.categoria_dre as string | null ?? null,
          data_prevista: String(form.data_prevista ?? new Date().toISOString().slice(0, 10)),
          data_realizada: (form.data_realizada as string | null) ?? null,
          status: (form.status as 'previsto' | 'confirmado' | 'cancelado' | 'realizado') ?? 'previsto',
          observacao: (form.observacao as string | null) ?? null,
        };
        if (isNew) await createEv.mutateAsync(body);
        else await updateEv.mutateAsync({ id: editing!.id, patch: body });
      }
      toast.success(isNew ? 'Evento criado' : 'Evento atualizado');
      onClose();
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'Novo' : 'Editar'} evento {kind === 'recorrentes' ? 'recorrente' : 'eventual'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="descricao">Descrição</Label>
            <Input id="descricao" value={String(form.descricao ?? '')} onChange={e => setForm({ ...form, descricao: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="valor">Valor (R$)</Label>
              <Input id="valor" type="number" step="0.01" value={String(form.valor ?? '')} onChange={e => setForm({ ...form, valor: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="tipo">Tipo</Label>
              <select id="tipo" className="w-full h-9 rounded border px-2"
                value={String(form.tipo ?? 'saida')}
                onChange={e => setForm({ ...form, tipo: e.target.value })}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
            </div>
          </div>
          {kind === 'recorrentes' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="dia_do_mes">Dia do mês</Label>
                  <Input id="dia_do_mes" type="number" min="1" max="31"
                    value={String(form.dia_do_mes ?? '')}
                    onChange={e => setForm({ ...form, dia_do_mes: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="is_folha">É folha?</Label>
                  <select id="is_folha" className="w-full h-9 rounded border px-2"
                    value={form.is_folha ? '1' : '0'}
                    onChange={e => setForm({ ...form, is_folha: e.target.value === '1' })}>
                    <option value="0">Não</option>
                    <option value="1">Sim</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="inicio">Início</Label>
                  <Input id="inicio" type="date" value={String(form.inicio ?? '')} onChange={e => setForm({ ...form, inicio: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="fim">Fim (opcional)</Label>
                  <Input id="fim" type="date" value={String(form.fim ?? '')} onChange={e => setForm({ ...form, fim: e.target.value || null })} />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="data_prevista">Data prevista</Label>
                  <Input id="data_prevista" type="date" value={String(form.data_prevista ?? '')} onChange={e => setForm({ ...form, data_prevista: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <select id="status" className="w-full h-9 rounded border px-2"
                    value={String(form.status ?? 'previsto')}
                    onChange={e => setForm({ ...form, status: e.target.value })}>
                    <option value="previsto">Previsto</option>
                    <option value="confirmado">Confirmado</option>
                    <option value="realizado">Realizado</option>
                    <option value="cancelado">Cancelado</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit}>{isNew ? 'Criar' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
