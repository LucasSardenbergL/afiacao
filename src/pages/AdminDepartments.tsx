import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import {
  useStaffUsersWithDept,
  useAssignDepartment,
  useRemoveAllDepartments,
} from '@/hooks/useDepartmentsAdmin';
import {
  DEPARTMENT_LABELS,
  DEPARTMENT_VALUES,
  type Department,
} from '@/integrations/supabase/types-departments';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

export default function AdminDepartments() {
  const { isMaster } = useAuth();
  const { data: users, isLoading, refetch, isFetching } = useStaffUsersWithDept();
  const assignMutation = useAssignDepartment();
  const removeMutation = useRemoveAllDepartments();

  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState<Department | 'all' | 'none'>('all');

  useEffect(() => {
    track('department.page_viewed', {});
  }, []);

  const filtered = useMemo(() => {
    if (!users) return [];
    return users.filter((u) => {
      if (search) {
        const q = search.toLowerCase();
        const matches =
          (u.name ?? '').toLowerCase().includes(q) ||
          (u.email ?? '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      if (filterDept === 'none') return u.department === null;
      if (filterDept !== 'all') return u.department === filterDept;
      return true;
    });
  }, [users, search, filterDept]);

  const countByDept = useMemo(() => {
    const counts: Record<string, number> = { __none: 0 };
    DEPARTMENT_VALUES.forEach((d) => (counts[d] = 0));
    (users ?? []).forEach((u) => {
      if (u.department) counts[u.department] = (counts[u.department] ?? 0) + 1;
      else counts.__none++;
    });
    return counts;
  }, [users]);

  if (!isMaster) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Apenas master pode gerenciar departamentos.
        </CardContent>
      </Card>
    );
  }

  const handleAssign = (userId: string, department: Department) => {
    assignMutation.mutate(
      { userId, department },
      {
        onSuccess: () => {
          toast.success(`Departamento atualizado: ${DEPARTMENT_LABELS[department]}`);
          track('department.assigned', { user_id: userId, department });
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'erro';
          toast.error(`Falha ao atribuir: ${msg}`);
        },
      },
    );
  };

  const handleRemove = (userId: string) => {
    removeMutation.mutate(
      { userId },
      {
        onSuccess: () => {
          toast.success('Departamento removido');
          track('department.removed', { user_id: userId });
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'erro';
          toast.error(`Falha ao remover: ${msg}`);
        },
      },
    );
  };

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Departamentos</h1>
          <p className="text-sm text-muted-foreground">
            Atribuição de departamento operacional aos staff. Persona do dashboard
            usa esse valor como prioridade sobre heurística por uso.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('w-3 h-3 mr-1.5', isFetching && 'animate-spin')} />
          Atualizar
        </Button>
      </div>

      {/* Contagem por departamento */}
      <div className="flex flex-wrap gap-2">
        <Badge variant={countByDept.__none > 0 ? 'destructive' : 'secondary'}>
          {countByDept.__none} sem dept
        </Badge>
        {DEPARTMENT_VALUES.map((d) => (
          <Badge key={d} variant="outline">
            {countByDept[d]} {DEPARTMENT_LABELS[d]}
          </Badge>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-64">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou email…"
            className="pl-8 h-9"
          />
        </div>
        <Select
          value={filterDept}
          onValueChange={(v) => setFilterDept(v as typeof filterDept)}
        >
          <SelectTrigger className="w-48 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="none">Sem departamento</SelectItem>
            {DEPARTMENT_VALUES.map((d) => (
              <SelectItem key={d} value={d}>
                {DEPARTMENT_LABELS[d]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            {filtered.length} staff
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Nenhum staff encontrado com esses filtros.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Nome</th>
                  <th className="text-left px-4 py-2 font-medium">Email</th>
                  <th className="text-left px-4 py-2 font-medium">Departamento</th>
                  <th className="text-right px-4 py-2 font-medium w-16"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.user_id} className="border-b border-border/60 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <div className="font-medium">{u.name ?? '(sem nome)'}</div>
                      {!u.is_approved && (
                        <Badge variant="outline" className="text-[10px] mt-1">
                          não aprovado
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs">{u.email ?? '—'}</td>
                    <td className="px-4 py-2">
                      <Select
                        value={u.department ?? '__none'}
                        onValueChange={(v) => {
                          if (v === '__none') return; // ignorável; usar X pra remover
                          handleAssign(u.user_id, v as Department);
                        }}
                      >
                        <SelectTrigger className="h-8 w-44 text-xs">
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          {DEPARTMENT_VALUES.map((d) => (
                            <SelectItem key={d} value={d}>
                              {DEPARTMENT_LABELS[d]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {u.department && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleRemove(u.user_id)}
                          aria-label="Remover departamento"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
