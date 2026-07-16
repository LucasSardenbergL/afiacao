// Tela avulsa "Embalagem econômica" — consulta de compra MANUAL.
// Para itens comprados fora do ciclo automático de reposição (ex.: concentrados WP
// da Sayerlack, que existem em quart e galão): informa-se quanto precisa e o app
// recomenda qual embalagem sai mais barata por unidade-base. É uma calculadora de
// decisão — a compra é feita no Omie; esta tela não fecha o ciclo (decisão de design,
// confirmada por consult Codex: não fingir automação que não existe).
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Package, Info, RefreshCw, Download } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { escolherEmbalagemEconomica } from '@/lib/reposicao/embalagem-helpers';
import { useEmbalagemConsulta, type GrupoEmbalagem } from '@/components/reposicao/embalagem/useEmbalagemConsulta';
import { PrecoEmbalagemDialog } from '@/components/reposicao/embalagem/PrecoEmbalagemDialog';

// Feature Oben-only por enquanto (sku_embalagem_equivalencia grava 'oben' minúsculo).
const EMPRESA = 'oben';

function formatBRL(v: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v ?? 0));
}

function GrupoCard({ grupo, limiar }: { grupo: GrupoEmbalagem; limiar: number }) {
  const [necessidadeStr, setNecessidadeStr] = useState('1');
  const [dialogOpen, setDialogOpen] = useState(false);
  const necessidade = Number(necessidadeStr.replace(',', '.'));

  const descPorSku = useMemo(
    () => Object.fromEntries(grupo.membros.map((m) => [m.sku_codigo_omie, m.descricao])),
    [grupo.membros],
  );

  const decisao = useMemo(
    () =>
      escolherEmbalagemEconomica({
        necessidade_base: Number.isFinite(necessidade) ? necessidade : 0,
        opcoes: grupo.membros.map((m) => ({
          sku_codigo_omie: m.sku_codigo_omie,
          fator_para_base: m.fator_para_base,
          preco: m.preco,
          preco_status: m.preco_status,
        })),
        params: {
          custo_capital_anual: grupo.custo_capital_anual,
          limiar_minimo_economia_rs: limiar,
          demanda_base_diaria: grupo.cm_disponivel ? grupo.demanda_base : null,
        },
      }),
    [grupo, necessidade, limiar],
  );

  const recAval = decisao.opcoes.find((o) => o.sku_codigo_omie === decisao.recomendada);
  const recDesc = decisao.recomendada ? descPorSku[decisao.recomendada] ?? decisao.recomendada : null;

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" /> {grupo.titulo}
        </CardTitle>
        <CardDescription>
          Unidade-base: {grupo.unidade_base} · {grupo.membros.length} embalagens
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Preços atuais por embalagem */}
        <div className="grid gap-2 sm:grid-cols-2">
          {grupo.membros.map((m) => (
            <div key={m.sku_codigo_omie} className="border rounded p-2 text-sm">
              <div className="font-medium">{m.descricao}</div>
              <div className="text-muted-foreground text-xs font-tabular">
                cód {m.sku_codigo_omie} · {m.fator_para_base} {grupo.unidade_base}/embalagem
              </div>
              <div className="mt-1">
                {m.preco != null ? (
                  <>
                    {formatBRL(m.preco)} <span className="text-muted-foreground text-xs">/ embalagem</span>
                  </>
                ) : (
                  <span className="text-status-warning">sem preço</span>
                )}
                {m.preco_status === 'stale' && <span className="text-status-warning text-xs"> · ⚠ desatualizado</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Necessidade + atualizar preços */}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[160px] max-w-[220px]">
            <Label htmlFor={`nec-${grupo.grupo_id}`}>Quanto preciso? (em {grupo.unidade_base})</Label>
            <Input
              id={`nec-${grupo.grupo_id}`}
              type="text"
              inputMode="decimal"
              value={necessidadeStr}
              onChange={(e) => setNecessidadeStr(e.target.value)}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            Atualizar preços
          </Button>
        </div>

        {/* Recomendação */}
        {decisao.status === 'indisponivel' ? (
          <div className="text-muted-foreground text-sm">
            {decisao.flags.includes('necessidade_invalida')
              ? 'Informe uma quantidade maior que zero.'
              : 'Informe os preços das duas embalagens pra ver a recomendação.'}
          </div>
        ) : (
          <div className="rounded-md bg-muted/40 border p-3 text-sm space-y-1">
            <div className="font-medium">
              Compre {recAval?.qtd_embalagens ?? 1}× {recDesc}
            </div>
            <div className="text-muted-foreground">
              custo {formatBRL(recAval?.custo_direto)}
              {decisao.economia_vs_alternativa > 0 && (
                <> · economiza {formatBRL(decisao.economia_vs_alternativa)} vs a outra embalagem
                  {decisao.flags.includes('sobra_antecipa_compra') ? ' (ao preço de hoje, contando a sobra como estoque)' : ''}</>
              )}
              {decisao.excedente_base > 0 && (
                <>
                  {' '}· sobra {decisao.excedente_base} {grupo.unidade_base}
                  {decisao.flags.includes('sobra_antecipa_compra') && decisao.dias_escoamento_sobra != null
                    ? ` — vira estoque, escoa em ~${Math.ceil(decisao.dias_escoamento_sobra)}d`
                    : ''}
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {decisao.opcoes.map((o) => (
                <Badge key={o.sku_codigo_omie} variant={o.sku_codigo_omie === decisao.recomendada ? 'default' : 'outline'}>
                  {descPorSku[o.sku_codigo_omie] ?? o.sku_codigo_omie}: {formatBRL(o.custo_por_base)}/{grupo.unidade_base}
                  {o.preco_status === 'stale' ? ' ⚠' : ''}
                </Badge>
              ))}
            </div>
            {decisao.status === 'marginal' && (
              <div className="text-status-warning text-xs">
                Ganho marginal — a embalagem maior quase não compensa pra essa quantidade; confira.
              </div>
            )}
            {decisao.flags.includes('preco_desatualizado') && (
              <div className="text-status-warning text-xs">Preço pode estar desatualizado — confira no portal e atualize.</div>
            )}
            {decisao.flags.includes('escoamento_nao_estimado') && (
              <div className="text-muted-foreground text-xs">
                Sem giro registrado — recomendação pelo menor custo por unidade-base (não estima o carrego da sobra); confira se o item gira antes de levar a embalagem maior.
              </div>
            )}
          </div>
        )}
      </CardContent>

      <PrecoEmbalagemDialog
        empresa={EMPRESA}
        skus={grupo.membros.map((m) => m.sku_codigo_omie)}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        labels={descPorSku}
      />
    </Card>
  );
}

export default function AdminReposicaoEmbalagem() {
  const { grupos, limiar, isLoading, isError } = useEmbalagemConsulta(EMPRESA);
  const { isStaff } = useAuth();
  const queryClient = useQueryClient();

  const sincronizar = useMutation({
    mutationFn: async () => {
      // as never: a RPC ainda não está nos tipos gerados do Supabase (regenerados pós-deploy).
      const { data, error } = await supabase.rpc('reposicao_sincronizar_embalagem_wp' as never, {
        p_empresa: EMPRESA,
      } as never);
      if (error) throw error;
      return data as { cores_elegiveis: number; linhas_inseridas: number };
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['embalagem-consulta'] });
      toast.success('Cadastro sincronizado', {
        description: `${r.cores_elegiveis} cores conferidas · ${r.linhas_inseridas} novas embalagens cadastradas.`,
      });
    },
    onError: (e) =>
      toast.error('Erro ao sincronizar cadastro', {
        description: e instanceof Error ? e.message : 'Tente novamente.',
      }),
  });

  // Dispara a edge de captura (disparo manual staff — roda mesmo com a automação
  // mensal desligada no kill-switch). A edge é síncrona e o full leva minutos;
  // se o fetch cair antes, a captura CONTINUA no servidor e o run-log registra.
  const capturarPortal = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('sayerlack-captura-precos', {
        body: { modo: 'full' },
      });
      if (error) throw error;
      const r = data as {
        ok: boolean;
        motivo?: string;
        status_run?: string;
        total_nao_encontrado?: number;
        total_falha?: number;
        precos_gravados?: number;
        erro?: string | null;
      };
      if (!r.ok) throw new Error(r.motivo ?? r.erro ?? 'captura não rodou');
      return r;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['embalagem-consulta'] });
      const naoEnc = r.total_nao_encontrado ?? 0;
      const falhas = r.total_falha ?? 0;
      // run parcial NÃO é sucesso integral (achado Codex): toast honesto com os
      // números — o cron re-tenta nos dias seguintes do ciclo.
      if (r.status_run === 'parcial') {
        toast.warning('Captura parcial do portal', {
          description: `${r.precos_gravados ?? 0} preços gravados · ${naoEnc} não encontrado(s) · ${falhas} falha(s). A rotina re-tenta nos próximos dias do ciclo.`,
        });
        return;
      }
      toast.success('Preços capturados do portal', {
        description: `${r.precos_gravados ?? 0} preços gravados${naoEnc > 0 ? ` · ${naoEnc} não encontrado(s) no portal (pedir reativação?)` : ''}`,
      });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'run_ativo') {
        toast.info('Já existe uma captura em andamento', { description: 'Aguarde alguns minutos e recarregue.' });
        return;
      }
      toast.error('Captura do portal não concluiu', {
        description: `${msg} — se foi timeout, a captura pode continuar em segundo plano; recarregue em alguns minutos.`,
      });
    },
  });

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display tracking-tight">Embalagem econômica</h1>
          <p className="text-muted-foreground text-sm">
            Compare embalagens (ex.: quart × galão) pelo menor custo por unidade-base. Para a compra manual dos concentrados,
            fora do ciclo automático de reposição.
          </p>
        </div>
        {isStaff && (
          <div className="flex gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => capturarPortal.mutate()}
              disabled={capturarPortal.isPending}
              title="Entra no portal Sayerlack e captura o preço líquido de todas as embalagens cadastradas (leva alguns minutos)"
            >
              <Download className={`w-4 h-4 mr-1.5 ${capturarPortal.isPending ? 'animate-pulse' : ''}`} />
              {capturarPortal.isPending ? 'Capturando…' : 'Atualizar do portal'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => sincronizar.mutate()}
              disabled={sincronizar.isPending}
              title="Detecta no Omie os WP com quartinho e galão ativos e cadastra os pares que faltam"
            >
              <RefreshCw className={`w-4 h-4 mr-1.5 ${sincronizar.isPending ? 'animate-spin' : ''}`} />
              Sincronizar cadastro
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-md border bg-status-info/5 p-3 text-sm flex gap-2">
        <Info className="h-4 w-4 mt-0.5 text-status-info shrink-0" />
        <div>
          Os preços vêm do <strong>portal Sayerlack</strong> — “Atualizar do portal” captura todos de uma vez; dá pra
          ajustar manualmente em cada grupo. A quantidade é sempre em <strong>unidade-base</strong> (a menor embalagem).
          A compra é feita no Omie; esta tela só recomenda <strong>qual embalagem</strong> sai mais barata.
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : isError ? (
        <div className="text-status-error text-sm">Erro ao carregar os grupos de embalagem. Tente recarregar a página.</div>
      ) : grupos.length === 0 ? (
        <EmptyState
          tone="operational"
          icon={Package}
          title="Nenhum grupo de embalagem cadastrado"
          description="Clique em Sincronizar cadastro para detectar os pares QT+GL ativos no Omie, ou confira se os produtos estão ativos lá."
        />
      ) : (
        <div className="space-y-3">
          {grupos.map((g) => (
            <GrupoCard key={g.grupo_id} grupo={g} limiar={limiar} />
          ))}
        </div>
      )}
    </div>
  );
}
