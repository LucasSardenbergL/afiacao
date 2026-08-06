import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStandardProcessesList } from '@/hooks/useStandardProcessesList';
import { StandardProcessRow } from '@/components/standard-process/StandardProcessRow';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Factory, Search } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { StandardProcessStatus } from '@/lib/standard-process/types';

const STATUS_TABS: Array<{ key: 'all' | StandardProcessStatus; label: string; statuses?: StandardProcessStatus[] }> = [
  { key: 'all', label: 'Todos', statuses: ['draft', 'in_review', 'published'] },
  { key: 'published', label: 'Publicados', statuses: ['published'] },
  { key: 'in_review', label: 'Em revisão', statuses: ['in_review'] },
  { key: 'draft', label: 'Rascunhos', statuses: ['draft'] },
];

export default function AdminStandardProcesses() {
  const [tab, setTab] = useState<'all' | StandardProcessStatus>('all');
  const [search, setSearch] = useState('');
  const statuses = STATUS_TABS.find((t) => t.key === tab)?.statuses;

  const { data, isLoading } = useStandardProcessesList({ status: statuses });

  const filtered = (data ?? []).filter((p) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(s)
      || p.segmento.toLowerCase().includes(s)
      || p.tags.some((t) => t.toLowerCase().includes(s))
    );
  });

  return (
    <div className="container mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">Processos padrão</h1>
          <p className="text-xs text-muted-foreground">
            Biblioteca de processos modelo da fábrica. Usados pra comparar contra o processo do cliente e sugerir caminhos.
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/admin/standard-processes/new">
            <Plus className="w-3.5 h-3.5" />
            Novo processo
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            {STATUS_TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, segmento, tag..."
            className="pl-8 h-9 text-xs"
          />
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          <Factory className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {data?.length === 0
            ? 'Nenhum processo padrão cadastrado. Crie o primeiro pra começar.'
            : 'Nenhum resultado pra esses filtros.'}
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <StandardProcessRow key={p.id} process={p} />
          ))}
        </div>
      )}
    </div>
  );
}
