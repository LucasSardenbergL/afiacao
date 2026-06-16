/**
 * Painel de cobertura de carteira (carteira-Omie, Sub-PR B).
 * "Tati cobre Regina de hoje até D2" → a lista de sugestões da Tati passa a incluir
 * a carteira da Regina, selada "Cobertura — Regina". Posse não muda.
 *
 * Gate: master cria pra qualquer par; vendedor só pode se cobrir a si mesmo (covered = eu).
 * A RLS (Sub-PR A) é a barreira real; a UI só espelha a regra.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, X, CalendarClock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  useSalespeople,
  useCoverageList,
  useCreateCoverage,
  useEndCoverage,
} from '@/hooks/useCoverage';

export function CoveragePanel() {
  const { user, isMaster, isStaff } = useAuth();
  const { data: people = [] } = useSalespeople();
  const { data: coverages = [], isLoading } = useCoverageList();
  const createCoverage = useCreateCoverage();
  const endCoverage = useEndCoverage();

  const [covering, setCovering] = useState<string>('');
  const [covered, setCovered] = useState<string>(isMaster ? '' : (user?.id ?? ''));
  const [validUntil, setValidUntil] = useState<string>('');

  if (!isStaff || !user) return null;

  const nameOf = (id: string) => people.find((p) => p.user_id === id)?.name ?? id.slice(0, 8);

  const handleCreate = () => {
    const coveredId = isMaster ? covered : user.id;
    if (!covering || !coveredId) {
      toast.error('Escolha quem cobre e quem está coberto.');
      return;
    }
    if (covering === coveredId) {
      toast.error('Quem cobre e quem está coberto não podem ser a mesma pessoa.');
      return;
    }
    createCoverage.mutate(
      {
        covering_user_id: covering,
        covered_user_id: coveredId,
        valid_until: validUntil ? new Date(validUntil).toISOString() : null,
      },
      {
        onSuccess: () => {
          toast.success('Cobertura criada.');
          setCovering('');
          setValidUntil('');
          if (isMaster) setCovered('');
        },
        onError: (e) =>
          toast.error(`Não foi possível criar a cobertura: ${e instanceof Error ? e.message : 'erro'}`),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          Cobertura de carteira (férias)
        </CardTitle>
        <p className="text-2xs text-muted-foreground">
          Quem cobre passa a ver a carteira de quem está coberto na própria lista de sugestões,
          marcada como "Cobertura". A posse do cliente não muda.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Formulário */}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <div className="space-y-1">
            <label className="text-2xs font-medium text-muted-foreground">Quem cobre</label>
            <Select value={covering} onValueChange={setCovering}>
              <SelectTrigger><SelectValue placeholder="Vendedor que cobre" /></SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-2xs font-medium text-muted-foreground">Quem está coberto (de férias)</label>
            {isMaster ? (
              <Select value={covered} onValueChange={setCovered}>
                <SelectTrigger><SelectValue placeholder="Vendedor coberto" /></SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={nameOf(user.id)} disabled className="text-muted-foreground" />
            )}
          </div>

          <div className="space-y-1">
            <label className="text-2xs font-medium text-muted-foreground flex items-center gap-1">
              <CalendarClock className="w-3 h-3" /> Até (opcional)
            </label>
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>

          <Button onClick={handleCreate} disabled={createCoverage.isPending}>
            Criar cobertura
          </Button>
        </div>

        {/* Lista de coberturas ativas */}
        <div className="border-t border-border pt-3">
          {isLoading ? (
            <p className="text-2xs text-muted-foreground">Carregando…</p>
          ) : coverages.length === 0 ? (
            <p className="text-2xs text-muted-foreground">Nenhuma cobertura ativa.</p>
          ) : (
            <ul className="space-y-2">
              {coverages.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 text-xs">
                  <span>
                    <span className="font-medium">{nameOf(c.covering_user_id)}</span>
                    {' cobre '}
                    <span className="font-medium">{nameOf(c.covered_user_id)}</span>
                    {c.valid_until && (
                      <span className="text-muted-foreground">
                        {' '}até {new Date(c.valid_until).toLocaleDateString('pt-BR')}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-status-error"
                    onClick={() =>
                      endCoverage.mutate(c.id, {
                        onSuccess: () => toast.success('Cobertura encerrada.'),
                        onError: (e) =>
                          toast.error(`Não foi possível encerrar: ${e instanceof Error ? e.message : 'erro'}`),
                      })
                    }
                  >
                    <X className="w-3.5 h-3.5 mr-1" /> Encerrar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
