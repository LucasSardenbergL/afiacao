import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Users, Plus, Trash2, ArrowRight, Building2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useClienteGrupos,
  useRemoveMembro,
  type ClienteGrupo,
  type RelationType,
} from '@/queries/useClienteGrupos';
import { GrupoFormDialog } from '@/components/grupos/GrupoFormDialog';
import { AddDocumentoDialog } from '@/components/grupos/AddDocumentoDialog';
import { formatDoc } from '@/lib/grupos/format';

const RELATION_BADGE: Record<RelationType, string> = {
  sucessao: 'sucessão',
  multi_ativo: 'multi-CNPJ',
  incerto: 'incerto',
};

function GrupoCard({ grupo }: { grupo: ClienteGrupo }) {
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const removeMembro = useRemoveMembro();

  const handleRemove = async (membroId: string, doc: string) => {
    try {
      await removeMembro.mutateAsync(membroId);
      toast.success(`Documento ${formatDoc(doc)} removido do grupo.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não consegui remover.');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">{grupo.nome}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {grupo.membros.length} documento{grupo.membros.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate(`/gestao/grupos-cliente/${grupo.id}`)}>
          Ver 360 <ArrowRight className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {grupo.membros.length === 0 && (
          <p className="text-sm text-muted-foreground">Nenhum documento ainda — adicione os CNPJs/CPFs do dono.</p>
        )}
        {grupo.membros.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono">{formatDoc(m.documento)}</span>
              <Badge variant="outline" className="shrink-0">{RELATION_BADGE[m.relation_type]}</Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-status-error"
              onClick={() => handleRemove(m.id, m.documento)}
              disabled={removeMembro.isPending}
              aria-label="Remover documento"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="mt-1 gap-1" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Adicionar documento
        </Button>
      </CardContent>
      <AddDocumentoDialog open={addOpen} onOpenChange={setAddOpen} grupoId={grupo.id} grupoNome={grupo.nome} />
    </Card>
  );
}

export default function GestaoGruposCliente() {
  const { data: grupos, isLoading, error } = useClienteGrupos();
  const [novoOpen, setNovoOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-primary" />
          <div>
            <h1 className="font-display" style={{ fontSize: '2rem', fontWeight: 500 }}>
              Grupos de Cliente
            </h1>
            <p className="text-sm text-muted-foreground">
              Junte os CNPJs/CPFs de um mesmo dono numa identidade só — dados e cobrança somados nas 3 empresas.
            </p>
          </div>
        </div>
        <Button className="gap-2" onClick={() => setNovoOpen(true)}>
          <Plus className="h-4 w-4" /> Novo grupo
        </Button>
      </header>

      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <p className="text-sm text-status-error">Não consegui carregar os grupos: {error instanceof Error ? error.message : 'erro'}.</p>
      )}

      {!isLoading && !error && grupos && grupos.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Nenhum grupo ainda</p>
              <p className="text-sm text-muted-foreground">Crie o primeiro grupo pra consolidar um dono que tem mais de um documento.</p>
            </div>
            <Button className="gap-2" onClick={() => setNovoOpen(true)}>
              <Plus className="h-4 w-4" /> Criar grupo
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && grupos && grupos.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {grupos.map((g) => (
            <GrupoCard key={g.id} grupo={g} />
          ))}
        </div>
      )}

      <GrupoFormDialog
        open={novoOpen}
        onOpenChange={setNovoOpen}
        onCreated={(id) => navigate(`/gestao/grupos-cliente/${id}`)}
      />
    </div>
  );
}
