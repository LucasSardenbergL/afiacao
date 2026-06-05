/**
 * ProvasParaAuditar — lista de instâncias aguardando auditoria (Fase 2, Task 9).
 *
 * Exibe comprovações pendentes de revisão do gestor/master:
 *   - descrição + vendedora responsável
 *   - leitura (se houver) + foto (signed URL via tarefa-comprovacoes)
 *   - botões Aprovar / Reprovar (reprovar pede motivo via textarea inline)
 *
 * Contagem + idade do backlog no topo (ex.: "3 provas aguardando · mais antiga há 2d").
 * Estado vazio → mensagem amigável.
 *
 * Gate: master ou gestor comercial (verificado pelo pai — esta componente não
 * redireciona, só não renderiza sem dados).
 */

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, Clock, Loader2, ImageOff, Camera } from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useProvasParaAuditar, useAuditarTarefa } from '@/hooks/useTarefasFase2';
import { useSalespeople } from '@/hooks/useCoverage';
import type { TarefaInstancia } from '@/lib/tarefas/templates-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Gera signed URL de 60s para path no bucket tarefa-comprovacoes. */
async function gerarSignedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('tarefa-comprovacoes')
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Exibe a distância do timestamp em pt-BR. Ex.: "há 2 dias" */
function idadeTexto(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return '';
  }
}

/** Determina a prova mais antiga para o badge de backlog. */
function maisAntiga(provas: TarefaInstancia[]): TarefaInstancia | null {
  return (
    provas.reduce<TarefaInstancia | null>((acc, p) => {
      if (!p.comprovacao_em) return acc;
      if (!acc || !acc.comprovacao_em) return p;
      return p.comprovacao_em < acc.comprovacao_em ? p : acc;
    }, null) ?? null
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: thumbnail da foto com signed URL
// ---------------------------------------------------------------------------

function FotoProva({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    gerarSignedUrl(path)
      .then((u) => {
        if (!cancelado) {
          setUrl(u);
          if (!u) setErro(true);
        }
      })
      .catch(() => {
        if (!cancelado) setErro(true);
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => { cancelado = true; };
  }, [path]);

  if (carregando) {
    return (
      <div className="w-20 h-20 rounded-md border border-border bg-muted flex items-center justify-center shrink-0">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (erro || !url) {
    return (
      <div className="w-20 h-20 rounded-md border border-border bg-muted flex flex-col items-center justify-center shrink-0 gap-1">
        <ImageOff className="w-5 h-5 text-muted-foreground" />
        <span className="text-2xs text-muted-foreground">Indisponível</span>
      </div>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
      <img
        src={url}
        alt="Comprovação"
        className="w-20 h-20 rounded-md border border-border object-cover hover:opacity-90 transition-opacity"
      />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: controles de auditoria de um item
// ---------------------------------------------------------------------------

interface ControlesAuditoriaProps {
  prova: TarefaInstancia;
  auditarTarefa: (id: string, aprovar: boolean, motivo: string) => Promise<void>;
}

function ControlesAuditoria({ prova, auditarTarefa }: ControlesAuditoriaProps) {
  const [reprovar, setReprovar] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);

  const handleAprovar = async () => {
    setSalvando(true);
    try {
      await auditarTarefa(prova.id, true, '');
    } finally {
      setSalvando(false);
    }
  };

  const handleReprovarConfirmar = async () => {
    if (!motivo.trim()) return;
    setSalvando(true);
    try {
      await auditarTarefa(prova.id, false, motivo.trim());
    } finally {
      setSalvando(false);
      setReprovar(false);
      setMotivo('');
    }
  };

  if (reprovar) {
    return (
      <div className="space-y-2 mt-2">
        <Textarea
          placeholder="Motivo da reprovação…"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          className="text-sm"
          disabled={salvando}
          autoFocus
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={!motivo.trim() || salvando}
            onClick={handleReprovarConfirmar}
          >
            {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Confirmar reprovação'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={salvando}
            onClick={() => { setReprovar(false); setMotivo(''); }}
          >
            Cancelar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <Button
        size="sm"
        variant="outline"
        className="text-status-success border-status-success/40 hover:bg-status-success-bg"
        disabled={salvando}
        onClick={handleAprovar}
      >
        {salvando ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            Aprovar
          </>
        )}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-status-error border-status-error/40 hover:bg-status-error-bg"
        disabled={salvando}
        onClick={() => setReprovar(true)}
      >
        <XCircle className="w-3.5 h-3.5 mr-1" />
        Reprovar
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function ProvasParaAuditar() {
  const { data: provas = [], isLoading } = useProvasParaAuditar();
  const { auditarTarefa } = useAuditarTarefa();
  const { data: salespeople = [] } = useSalespeople();

  const resolverNome = useCallback(
    (userId: string) => salespeople.find((s) => s.user_id === userId)?.name ?? userId.slice(0, 8),
    [salespeople],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="w-4 h-4 animate-spin" />
        Carregando provas…
      </div>
    );
  }

  if (provas.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <Camera className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm font-medium">Nenhuma prova aguardando auditoria</p>
        <p className="text-xs text-muted-foreground mt-1">
          Quando uma tarefa for concluída com comprovação e sorteada para auditoria, ela aparece aqui.
        </p>
      </div>
    );
  }

  // Badge de backlog
  const antiga = maisAntiga(provas);
  const idadeAntiga = antiga?.comprovacao_em ? idadeTexto(antiga.comprovacao_em) : null;

  return (
    <div className="space-y-3">
      {/* Cabeçalho com contagem + idade */}
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-status-warning" />
        <span className="text-sm font-medium">
          {provas.length} {provas.length === 1 ? 'prova aguardando' : 'provas aguardando'}
        </span>
        {idadeAntiga && (
          <span className="text-xs text-muted-foreground">· mais antiga {idadeAntiga}</span>
        )}
      </div>

      {/* Lista de provas */}
      <ul className="space-y-3">
        {provas.map((prova) => {
          const temFoto = !!prova.comprovacao_url;
          const temLeitura = prova.comprovacao_leitura != null;

          return (
            <li key={prova.id}>
              <Card className="p-3">
                <div className="flex items-start gap-3">
                  {/* Foto (se houver) */}
                  {temFoto && prova.comprovacao_url && (
                    <FotoProva path={prova.comprovacao_url} />
                  )}

                  {/* Informações da prova */}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug">{prova.descricao}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {resolverNome(prova.assigned_to)}
                      {prova.comprovacao_em && (
                        <span className="ml-1">· enviada {idadeTexto(prova.comprovacao_em)}</span>
                      )}
                    </p>

                    {/* Leitura numérica */}
                    {temLeitura && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs font-mono">
                          {prova.comprovacao_leitura?.toLocaleString('pt-BR')}
                          {prova.leitura_unidade ? ` ${prova.leitura_unidade}` : ''}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          leitura
                          {prova.leitura_min != null && prova.leitura_max != null
                            ? ` · faixa ${prova.leitura_min.toLocaleString('pt-BR')}–${prova.leitura_max.toLocaleString('pt-BR')}`
                            : ''}
                        </span>
                      </div>
                    )}

                    {/* Tipo de comprovação */}
                    {!temFoto && !temLeitura && (
                      <p className="text-xs text-muted-foreground mt-1 italic">
                        Sem foto nem leitura registrados
                      </p>
                    )}
                  </div>
                </div>

                {/* Botões de auditoria */}
                <ControlesAuditoria prova={prova} auditarTarefa={auditarTarefa} />
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
