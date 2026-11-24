// Lista de clientes (segmentos, busca, filtros, tabela densa, scroll infinito).
// Extraído verbatim de src/pages/AdminCustomers.tsx (god-component split).
import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Loader2, Search, ChevronRight, Filter, Users, Save, Bookmark, X as XIcon,
  AlertTriangle, ArrowDownWideNarrow, ArrowDownAZ, Info,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUrlState } from '@/hooks/useUrlState';
import { useCustomerSegments } from '@/hooks/useCustomerSegments';
import { decodeHtmlEntities } from '@/lib/format';
import { lerRolagemARestaurar } from '@/lib/nav/clientes';
import {
  HEALTH_CLASSES, NAO_APURADO, classeSaudeExibida, estadoFiltroSaude, fmtContagem, fmtGasto, fmtPrioridade, formatDocument,
  metricasExibiveis, motivoContato, normalizarOrdem, prioridadeDisponivel, rotuloContagem, TAMANHO_PAGINA_CLIENTES,
  type EstadoScores, type OrdemClientes,
} from './config';
import { modoClientes, registrarUsoClientes, type ModoClientes } from '@/lib/nav/sensor-clientes';
import type { Customer, ClientScore } from './types';
import { rotuloUltimoContato } from './ultimoContato';
import { useUltimoContato } from './useUltimoContato';
import { explicarPrioridade } from '@/lib/scoring/prioridadeValor';

/** Ajuda da coluna "Prioridade", em linguagem de vendedor. */
const TEXTO_AJUDA_PRIORIDADE =
  'Nota que ordena quem contatar primeiro: quanto maior, mais cedo. No topo, quem passou da recompra '
  + 'habitual — quanto mais compra e mais atrasado, maior. Depois quem está em dia; por último, os '
  + 'inativos (fila de reativação). Passe o mouse na nota para ver o porquê. '
  + '"—" = sem histórico de compra: não entra na fila de recompra.';

/** Nota da prioridade com os 2–3 fatores que a decidiram (tooltip). Sem fatores confirmáveis, só a nota. */
function NotaPrioridade({ valor, fatores }: { valor: number; fatores: string[] | null }) {
  const nota = <span className="text-xs font-semibold tabular-nums">{fmtPrioridade(valor)}</span>;
  if (!fatores) return nota;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`Prioridade ${fmtPrioridade(valor)}: ${fatores.join('; ')}`} className="cursor-help underline decoration-dotted underline-offset-2">
            {nota}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 text-left font-normal">
          <ul className="space-y-0.5">
            {fatores.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function CustomerListView({
  customers,
  scores,
  loading,
  isError,
  onRetry,
  total,
  contagemPendente = false,
  isCarteira,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  buscaNoServidor = false,
  buscando = false,
  filtroNoServidor = false,
  totalRecorte = null,
  scoresEstado = 'ok',
  onRetryScores,
}: {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  loading: boolean;
  /** Falha da fonte da lista (§7): vazia por FALHA ≠ vazia de verdade. */
  isError: boolean;
  onRetry: () => void;
  /** Total CONFIRMADO pela fonte; `null` = ainda não chegou ou indisponível (nunca vira 0). */
  total: number | null;
  /** A contagem ainda está sendo buscada (com `total` null → "N clientes carregados"). */
  contagemPendente?: boolean;
  isCarteira: boolean;
  onSelect: (c: Customer) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** `customers` já é o resultado da busca feita no servidor — não re-filtrar o texto em memória. */
  buscaNoServidor?: boolean;
  /** Resultado do termo anterior à vista enquanto o novo é buscado. */
  buscando?: boolean;
  /** Filtro de saúde e ordem já aplicados pelo servidor antes de paginar (base completa). */
  filtroNoServidor?: boolean;
  /** Tamanho do recorte (busca + saúde) no servidor; `null` = não informado. */
  totalRecorte?: number | null;
  /** Leitura dos scores: na carteira o filtro de saúde e a prioridade dependem dela (em memória). */
  scoresEstado?: EstadoScores;
  /** Retry só dos scores. */
  onRetryScores?: () => void;
}) {
  // Filtros sincronizados com URL (compartilhável, sobrevive a F5)
  const [urlState, setUrlState] = useUrlState({ search: '', health: 'all', ordem: 'prioridade' });
  const searchQuery = urlState.search;
  const filterHealth = urlState.health;
  // A ordem vale nos DOIS modos: na base completa o servidor a aplica antes de paginar; na carteira
  // (lida inteira em memória, com os scores) ela é aplicada aqui — espelho da ordem do servidor.
  const ordem: OrdemClientes = normalizarOrdem(urlState.ordem);
  // Sensor de uso (lib/nav/sensor-clientes.ts): o modo que o vendedor VÊ, carteira e base separadas.
  const modo: ModoClientes = modoClientes(isCarteira, ordem);
  const setFilterHealth = (v: string) => {
    if (v !== filterHealth) registrarUsoClientes({ acao: 'filtro_saude', modo, valor: v });
    setUrlState({ health: v });
  };
  const setOrdem = (v: OrdemClientes, origem: 'menu' | 'cabecalho') => {
    if (v !== ordem) {
      registrarUsoClientes({ acao: 'modo_trocado', de: modo, para: modoClientes(isCarteira, v), origem });
    }
    setUrlState({ ordem: v });
  };
  const carregarMais = () => {
    // Página que está SENDO pedida (1ª = a que já veio com a lista).
    const pagina = Math.ceil(customers.length / TAMANHO_PAGINA_CLIENTES) + 1;
    registrarUsoClientes({ acao: 'pagina_carregada', modo, pagina });
    onLoadMore();
  };
  const sentinelRef = useInfiniteScroll(carregarMais, hasNextPage && !isFetchingNextPage);
  // Ordenável nos dois modos (antes só na base completa: a vendedora só tinha o A–Z).
  const ordenavel = true;
  const filtrando = !!searchQuery || filterHealth !== 'all';
  const estadoSaude = estadoFiltroSaude({ filtro: filterHealth, filtroNoServidor, scoresEstado });
  const prioridadeOk = prioridadeDisponivel({ ordem, filtroNoServidor, scoresEstado });

  // O input de busca tem estado LOCAL e empurra pra URL com debounce: escrever
  // na URL a cada tecla (history.replace) re-renderizava todos os subscribers
  // do router — sidebar inteira (~60 itens), breadcrumbs, mobile nav — por
  // caractere digitado. A URL continua sendo a fonte da verdade do filtro.
  //
  // Os DOIS efeitos abaixo têm deps mínimas DE PROPÓSITO (cada um reage só ao
  // seu gatilho). Incluir urlState.search nas deps do 1º faria ele rodar
  // também quando a URL muda por FORA (segmento/limpar/back) e re-empurrar o
  // termo antigo do debounce, revertendo a ação externa por ~300ms.
  const [searchInput, setSearchInput] = useState(searchQuery);
  const debouncedInput = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    // Digitação → URL: dispara SÓ quando o termo debounced muda.
    if (debouncedInput !== urlState.search) {
      // Sensor: só o FATO de buscar (o termo nunca sai daqui). Gatilho = digitação, não URL externa.
      if (debouncedInput.trim()) registrarUsoClientes({ acao: 'busca_usada', modo });
      setUrlState({ search: debouncedInput });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedInput]);
  useEffect(() => {
    // URL → input (segmento aplicado, "limpar filtros", back/forward). O guard
    // contra debouncedInput evita sobrescrever digitação em andamento na
    // janela entre o debounce expirar e a URL atualizar.
    if (urlState.search !== debouncedInput) setSearchInput(urlState.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlState.search]);

  const { segments, save: saveSegment, remove: removeSegment } = useCustomerSegments();
  const [savingSegment, setSavingSegment] = useState(false);
  const [newSegmentName, setNewSegmentName] = useState('');

  const filtered = useMemo(() => {
    let result = customers;
    // Base completa: a busca foi ao servidor (filtrar aqui só enxergaria as páginas já
    // carregadas). Carteira: lida inteira, então o filtro local é completo — mesmas colunas
    // da busca no servidor (RPC listar_clientes_base: name/email/document/phone).
    if (searchQuery && !buscaNoServidor) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.document?.includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q)
      );
    }
    // Base completa: o filtro de saúde também foi ao servidor, ANTES da paginação. Carteira sem os
    // scores lidos (carregando/falha): NÃO filtra — o mapa vazio diria "nenhum Crítico"; a tela avisa.
    if (filterHealth !== 'all' && !filtroNoServidor && estadoSaude === 'aplicado') {
      result = result.filter(c => {
        const score = scores.get(c.user_id);
        // sem_historico tem filtro próprio; nos filtros de SAÚDE ele NÃO entra (o badge dele é
        // "Sem histórico", não uma classe de saúde) — senão o filtro "Crítico" mentiria (achado /codex).
        if (filterHealth === 'sem_historico') return score?.sales_history_status === 'sem_historico';
        if (score?.sales_history_status === 'sem_historico') return false;
        return score?.health_class === filterHealth;
      });
    }
    // A ordem já vem aplicada: do servidor (base completa) ou do useClientesScope (carteira).
    return result;
  }, [customers, searchQuery, filterHealth, scores, buscaNoServidor, filtroNoServidor, estadoSaude]);

  // Último contato (onda 3): UMA leitura em lote dos clientes desta tela — nunca uma por linha.
  const idsVisiveis = useMemo(() => filtered.map((c) => c.user_id), [filtered]);
  const ultimoContato = useUltimoContato(idsVisiveis);
  const hoje = useMemo(() => new Date(), []);

  // Voltar da ficha: a lista volta na mesma posição (a rolagem viaja no `location.state`).
  const location = useLocation();
  const rolagemRestaurada = useRef(false);
  useEffect(() => {
    if (loading || rolagemRestaurada.current) return;
    rolagemRestaurada.current = true;
    const y = lerRolagemARestaurar(location.state);
    if (y != null) requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, [loading, location.state]);

  // Sensor: a lista montou PRONTA, 1x por montagem, no modo em que abriu (o ledger dedupa por dia).
  const aberturaRegistrada = useRef(false);
  useEffect(() => {
    if (loading || aberturaRegistrada.current) return;
    aberturaRegistrada.current = true;
    registrarUsoClientes({ acao: 'lista_aberta', modo });
  }, [loading, modo]);

  if (loading) {
    // PageSkeleton (não Loader2 full-page) — convenção §9; mesma troca feita
    // nas outras telas deste PR.
    return <PageSkeleton variant="list" />;
  }

  const rotuloBase = rotuloContagem({ total, pendente: contagemPendente, carregados: customers.length, isCarteira });

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            {/* Sob falha sem dado, "0 clientes na base" afirmaria base vazia — não medimos nada. */}
            {isError && customers.length === 0
              ? 'contagem indisponível'
              : filtroNoServidor && filtrando && totalRecorte != null
                ? `${fmtContagem(totalRecorte)} com esses filtros · ${rotuloBase}`
                : rotuloBase}
          </p>
        </div>
      </div>

      {isError && customers.length > 0 && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida — a atualização mais recente falhou. A lista
          pode estar desatualizada.
        </div>
      )}

      {/* Segmentos salvos (chips) */}
      {(segments.length > 0 || savingSegment || (searchQuery || filterHealth !== 'all')) && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Bookmark className="w-3 h-3" />
            Segmentos
          </span>
          {segments.map((seg) => (
            <span
              key={seg.id}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md text-xs bg-muted hover:bg-muted/70 border border-border"
            >
              <button
                type="button"
                onClick={() => setUrlState({ search: seg.filters.search ?? '', health: seg.filters.health ?? 'all' })}
                className="font-medium"
                title="Aplicar segmento"
              >
                {seg.name}
              </button>
              <button
                type="button"
                onClick={() => removeSegment(seg.id)}
                className="text-muted-foreground hover:text-destructive p-0.5"
                aria-label={`Remover segmento ${seg.name}`}
              >
                <XIcon className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(searchQuery || filterHealth !== 'all') && !savingSegment && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => setSavingSegment(true)}
            >
              <Save className="w-3 h-3" />
              Salvar como segmento
            </Button>
          )}
          {savingSegment && (
            <span className="inline-flex items-center gap-1.5">
              <Input
                placeholder="Nome do segmento"
                value={newSegmentName}
                autoFocus
                onChange={(e) => setNewSegmentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newSegmentName.trim()) {
                    saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                    setNewSegmentName('');
                    setSavingSegment(false);
                  } else if (e.key === 'Escape') {
                    setNewSegmentName('');
                    setSavingSegment(false);
                  }
                }}
                className="h-7 w-48 text-xs"
              />
              <Button
                size="sm"
                variant="default"
                className="h-7"
                disabled={!newSegmentName.trim()}
                onClick={() => {
                  saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Cancelar
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Search + Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CPF/CNPJ, e-mail ou telefone..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 pr-9 h-9"
          />
          {buscando && (
            <Loader2
              aria-label="Buscando"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground"
            />
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              Saúde
              {filterHealth !== 'all' && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                  {filterHealth === 'sem_historico' ? 'Sem histórico' : HEALTH_CLASSES[filterHealth]?.label}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFilterHealth('all')}>Todos</DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setFilterHealth('saudavel')}><span className="h-2 w-2 rounded-full bg-status-success" aria-hidden />Saudável</DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setFilterHealth('estavel')}><span className="h-2 w-2 rounded-full bg-status-info" aria-hidden />Estável</DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setFilterHealth('atencao')}><span className="h-2 w-2 rounded-full bg-status-warning" aria-hidden />Atenção</DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setFilterHealth('critico')}><span className="h-2 w-2 rounded-full bg-status-error" aria-hidden />Crítico</DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setFilterHealth('sem_historico')}><span className="h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />Sem histórico</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {ordenavel && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5" aria-label="Ordenar lista">
                {ordem === 'nome'
                  ? <ArrowDownAZ className="w-3.5 h-3.5" />
                  : <ArrowDownWideNarrow className="w-3.5 h-3.5" />}
                {ordem === 'nome' ? 'A–Z' : 'Priorizar contatos'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setOrdem('prioridade', 'menu')}>Priorizar contatos</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setOrdem('nome', 'menu')}>A–Z</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {(estadoSaude === 'carregando' || estadoSaude === 'falha') && (
        <div
          role={estadoSaude === 'falha' ? 'alert' : 'status'}
          className={cn(
            'flex items-center justify-between gap-3 rounded-lg border p-3 text-xs',
            estadoSaude === 'falha'
              ? 'border-status-warning/30 bg-status-warning/5 text-status-warning'
              : 'border-border bg-muted/30 text-muted-foreground',
          )}
        >
          <span className="inline-flex items-center gap-2">
            {estadoSaude === 'carregando' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
            {estadoSaude === 'carregando'
              ? 'Carregando a saúde dos clientes — o filtro de saúde ainda não foi aplicado.'
              : 'Não foi possível ler a saúde dos clientes — o filtro de saúde NÃO foi aplicado. A lista abaixo mostra todos os clientes da busca.'}
          </span>
          {estadoSaude === 'falha' && onRetryScores && (
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetryScores}>Tentar novamente</Button>
          )}
        </div>
      )}
      {!prioridadeOk && estadoSaude !== 'carregando' && estadoSaude !== 'falha' && (
        <div
          role={scoresEstado === 'falha' ? 'alert' : 'status'}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
        >
          <span className="inline-flex items-center gap-2">
            {scoresEstado === 'carregando' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
            {scoresEstado === 'carregando'
              ? 'Carregando as prioridades — por enquanto a lista está em ordem alfabética.'
              : 'Não foi possível ler as prioridades — a lista está em ordem alfabética.'}
          </span>
          {scoresEstado === 'falha' && onRetryScores && (
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetryScores}>Tentar novamente</Button>
          )}
        </div>
      )}

      {/* Dense Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th
                  className="text-left px-4 py-2.5 font-medium text-muted-foreground"
                  aria-sort={ordenavel ? (ordem === 'nome' ? 'ascending' : 'none') : undefined}
                >
                  {ordenavel ? (
                    <button type="button" onClick={() => setOrdem('nome', 'cabecalho')} className="inline-flex items-center gap-1 hover:text-foreground">
                      Cliente {ordem === 'nome' && <ArrowDownAZ className="w-3 h-3" aria-hidden />}
                    </button>
                  ) : 'Cliente'}
                </th>
                <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Documento</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground">Saúde</th>
                <th className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Média mensal (180d)</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Dias s/ compra</th>
                <th
                  className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell"
                  aria-sort={ordenavel ? (ordem === 'prioridade' ? 'descending' : 'none') : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {ordenavel ? (
                      <button type="button" onClick={() => setOrdem('prioridade', 'cabecalho')} className="inline-flex items-center gap-1 hover:text-foreground">
                        {ordem === 'prioridade' && <ArrowDownWideNarrow className="w-3 h-3" aria-hidden />} Prioridade
                      </button>
                    ) : 'Prioridade'}
                    <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label="O que é a prioridade" className="hover:text-foreground">
                          <Info className="w-3 h-3" aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64 text-left font-normal">
                        {TEXTO_AJUDA_PRIORIDADE}
                      </TooltipContent>
                    </Tooltip>
                    </TooltipProvider>
                  </span>
                </th>
                <th className="w-10 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((customer, indice) => {
                const score = scores.get(customer.user_id);
                const healthInfo = score ? classeSaudeExibida(score.health_class) : undefined;
                const isSemHistorico = score?.sales_history_status === 'sem_historico';
                // Sem histórico: 999d / R$ 0 / prioridade são sentinelas da edge, não medidas.
                const metricas = score ? metricasExibiveis(score) : null;
                const motivo = motivoContato(score);
                const contato = rotuloUltimoContato(ultimoContato.porCliente.get(customer.user_id), ultimoContato.estado, hoje, ultimoContato.contexto);

                return (
                  <tr
                    key={customer.user_id}
                    className="border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => {
                      registrarUsoClientes({
                        acao: 'cliente_aberto', modo, posicao: indice + 1, filtroSaude: filterHealth, comBusca: !!searchQuery,
                      });
                      onSelect(customer);
                    }}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="min-w-0">
                          <p className="font-medium truncate text-foreground flex items-center gap-1.5">
                            <span className="truncate">{decodeHtmlEntities(customer.name)}</span>
                            {customer.coberto_de && (
                              <Badge variant="outline" className="text-[10px] shrink-0 text-status-info border-status-info/40">
                                cobertura
                              </Badge>
                            )}
                          </p>
                          {motivo && (
                            <p className="text-xs text-muted-foreground truncate">{motivo}</p>
                          )}
                          {contato && (
                            <p className="text-xs text-muted-foreground truncate" data-testid="ultimo-contato">{contato}</p>
                          )}
                          {customer.phone && (
                            <p className="text-xs text-muted-foreground">{customer.phone}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell">
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDocument(customer.document)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {isSemHistorico ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">Sem histórico</Badge>
                      ) : (
                        <Badge variant="outline" className={cn('text-[10px]', healthInfo?.className)}>
                          {healthInfo?.label ?? 'Não avaliado'}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right hidden lg:table-cell">
                      <span className="text-xs font-medium tabular-nums">
                        {metricas ? fmtGasto(metricas.gasto) : NAO_APURADO}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center hidden lg:table-cell">
                      {metricas?.dias != null ? (
                        <span className={cn(
                          'text-xs font-medium tabular-nums',
                          metricas.dias > 60 ? 'text-status-error' :
                          metricas.dias > 30 ? 'text-status-warning' :
                          'text-muted-foreground'
                        )}>
                          {metricas.dias}d
                        </span>
                      ) : <span className="text-xs text-muted-foreground">{NAO_APURADO}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right hidden md:table-cell">
                      {metricas?.prioridade != null ? (
                        <NotaPrioridade valor={metricas.prioridade} fatores={score ? explicarPrioridade(score, fmtGasto) : null} />
                      ) : <span className="text-xs text-muted-foreground">{NAO_APURADO}</span>}
                    </td>
                    <td className="px-2 py-2.5">
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          isError && customers.length === 0 ? (
            // Falha de leitura ≠ base vazia: o empty state de sucesso mandaria "cadastre um
            // cliente" sobre uma lista que NÃO foi lida (§7 — ausente ≠ vazio).
            <div role="alert">
              <EmptyState
                icon={AlertTriangle}
                title="Não foi possível carregar os clientes"
                description="A leitura da base falhou — a lista não está vazia, está indisponível. Nenhum cliente foi omitido de propósito."
                actionLabel="Tentar novamente"
                onAction={onRetry}
              />
            </div>
          ) : hasNextPage && !filtroNoServidor ? (
            // Ainda há páginas e o filtro é em memória: "nenhum cliente" seria afirmar sobre a
            // parte NÃO lida. (Na base completa o filtro vai ao servidor — página vazia é fim.)
            <EmptyState
              icon={Search}
              title="Nenhum cliente nas páginas carregadas até agora"
              description={`Dos ${customers.length} clientes carregados, nenhum passa no filtro. Carregue mais para continuar procurando no resto da base.`}
            />
          ) : (
          <EmptyState
            icon={searchQuery || filterHealth !== 'all' ? Search : Users}
            title={searchQuery || filterHealth !== 'all' ? 'Nenhum cliente com esses filtros' : 'Nenhum cliente na carteira'}
            description={
              searchQuery || filterHealth !== 'all'
                ? 'Tente buscar por nome, CNPJ ou e-mail; ou trocar o filtro de saúde.'
                : 'Quando um cliente for cadastrado ele vai aparecer aqui automaticamente.'
            }
            actionLabel={searchQuery || filterHealth !== 'all' ? 'Limpar filtros' : undefined}
            onAction={searchQuery || filterHealth !== 'all' ? () => setUrlState({ search: '', health: 'all' }) : undefined}
          />
          )
        )}

        {/* Infinite scroll sentinel + fallback botão */}
        {hasNextPage && (
          <div ref={sentinelRef} className="py-4 flex justify-center border-t">
            {isFetchingNextPage ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <Button variant="outline" size="sm" onClick={carregarMais}>
                Carregar mais
              </Button>
            )}
          </div>
        )}
        {!hasNextPage && customers.length > 0 && !isCarteira && (
          <p className="text-center text-xs text-muted-foreground py-4 border-t">
            {filtrando
              ? `Todos os resultados carregados (${fmtContagem(totalRecorte ?? customers.length)})`
              : `Todos os clientes carregados (${fmtContagem(customers.length)})`}
          </p>
        )}
      </Card>
    </div>
  );
}
