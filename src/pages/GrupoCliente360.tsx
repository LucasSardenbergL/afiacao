import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Building2, Plus, Trash2, Wallet, Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  useClienteGrupos,
  useRemoveMembro,
  type RelationType,
} from '@/queries/useClienteGrupos';
import { AddDocumentoDialog } from '@/components/grupos/AddDocumentoDialog';
import { GrupoFinanceiroTab } from '@/components/grupos/GrupoFinanceiroTab';
import { formatDoc } from '@/lib/grupos/format';

const RELATION_BADGE: Record<RelationType, string> = {
  sucessao: 'sucessão',
  multi_ativo: 'multi-CNPJ',
  incerto: 'incerto',
};

/** Estado "aguardando a view de consolidação" (Financeiro/Contatos chegam na Task 3). */
function PendingRollup({ icon: Icon, titulo, descricao }: { icon: typeof Wallet; titulo: string; descricao: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon className="h-7 w-7 text-muted-foreground" />
        <p className="font-medium">{titulo}</p>
        <p className="max-w-md text-sm text-muted-foreground">{descricao}</p>
      </CardContent>
    </Card>
  );
}

export default function GrupoCliente360() {
  const { grupoId } = useParams<{ grupoId: string }>();
  const navigate = useNavigate();
  const { data: grupos, isLoading } = useClienteGrupos();
  const removeMembro = useRemoveMembro();
  const [addOpen, setAddOpen] = useState(false);

  const grupo = grupos?.find((g) => g.id === grupoId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!grupo) {
    return (
      <div className="container mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate('/gestao/grupos-cliente')}>
          <ArrowLeft className="h-4 w-4" /> Grupos
        </Button>
        <p className="text-sm text-muted-foreground">Grupo não encontrado.</p>
      </div>
    );
  }

  const relationTypes = [...new Set(grupo.membros.map((m) => m.relation_type))];

  const handleRemove = async (membroId: string, doc: string) => {
    try {
      await removeMembro.mutateAsync(membroId);
      toast.success(`Documento ${formatDoc(doc)} removido.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não consegui remover.');
    }
  };

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="gap-1 -ml-2" onClick={() => navigate('/gestao/grupos-cliente')}>
        <ArrowLeft className="h-4 w-4" /> Grupos
      </Button>

      <header className="space-y-2">
        <h1 className="font-display" style={{ fontSize: '2rem', fontWeight: 500 }}>{grupo.nome}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{grupo.membros.length} documento{grupo.membros.length === 1 ? '' : 's'}</span>
          {relationTypes.map((rt) => (
            <Badge key={rt} variant="outline">{RELATION_BADGE[rt]}</Badge>
          ))}
        </div>
        {grupo.notas && <p className="text-sm text-muted-foreground">{grupo.notas}</p>}
      </header>

      {/* Documentos do grupo */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Documentos (CNPJ/CPF)</h2>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Adicionar
          </Button>
        </div>
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
      </section>

      {/* Rollups consolidados */}
      <Tabs defaultValue="financeiro" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
          <TabsTrigger value="financeiro" className="gap-1.5"><Wallet className="h-4 w-4" /> Financeiro</TabsTrigger>
          <TabsTrigger value="contatos" className="gap-1.5"><Users className="h-4 w-4" /> Contatos</TabsTrigger>
        </TabsList>

        <TabsContent value="financeiro" className="m-0">
          <GrupoFinanceiroTab grupoId={grupo.id} />
        </TabsContent>

        <TabsContent value="contatos" className="m-0">
          <PendingRollup
            icon={Users}
            titulo="Contatos consolidados (em implementação)"
            descricao="Telefones, endereços e vendedor dos documentos do grupo, num lugar só — chega com a view de contatos (próximo passo da Fase 1)."
          />
        </TabsContent>
      </Tabs>

      <AddDocumentoDialog open={addOpen} onOpenChange={setAddOpen} grupoId={grupo.id} grupoNome={grupo.nome} />
    </div>
  );
}
