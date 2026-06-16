import { Loader2, Phone, MapPin, Mail, UserCog } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGrupoContatos, type GrupoContato } from '@/queries/useGrupoContatos';
import { formatDoc } from '@/lib/grupos/format';

function ContatoLinha({ c }: { c: GrupoContato }) {
  return (
    <div className="space-y-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.nome ?? 'Sem nome'}</span>
        {c.empresa_omie && <Badge variant="outline" className="uppercase">{c.empresa_omie}</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        {c.phone && (
          <span className="inline-flex items-center gap-1">
            <Phone className="h-3.5 w-3.5" /> {c.phone}
          </span>
        )}
        {(c.cidade || c.endereco) && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" /> {[c.endereco, c.cidade && `${c.cidade}${c.uf ? '/' + c.uf : ''}`].filter(Boolean).join(' — ')}
          </span>
        )}
        {c.email && (
          <span className="inline-flex items-center gap-1">
            <Mail className="h-3.5 w-3.5" /> {c.email}
          </span>
        )}
        {c.omie_codigo_vendedor != null && (
          <span className="inline-flex items-center gap-1">
            <UserCog className="h-3.5 w-3.5" /> vendedor {c.omie_codigo_vendedor}
          </span>
        )}
      </div>
    </div>
  );
}

export function GrupoContatosTab({ grupoId }: { grupoId: string }) {
  const { data, isLoading, error } = useGrupoContatos(grupoId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-status-error">Não consegui carregar os contatos: {error instanceof Error ? error.message : 'erro'}.</p>;
  }

  const contatos = data ?? [];
  if (contatos.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nenhum cadastro encontrado pros documentos deste grupo. (Os documentos podem não ter perfil vinculado no app.)
        </CardContent>
      </Card>
    );
  }

  // agrupa por documento
  const porDoc = new Map<string, GrupoContato[]>();
  for (const c of contatos) {
    const arr = porDoc.get(c.documento) ?? [];
    arr.push(c);
    porDoc.set(c.documento, arr);
  }

  return (
    <div className="space-y-3">
      {[...porDoc.entries()].map(([doc, linhas]) => (
        <div key={doc} className="space-y-1.5">
          <p className="font-mono text-xs text-muted-foreground">{formatDoc(doc)}</p>
          {linhas.map((c) => (
            <ContatoLinha key={`${c.documento}-${c.user_id}`} c={c} />
          ))}
        </div>
      ))}
    </div>
  );
}
