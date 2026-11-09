import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MapPin, Radar, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useUrlState } from '@/hooks/useUrlState';
import { useAuth } from '@/contexts/AuthContext';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useRadarLista, FILTROS_MEUS_ATENDIMENTOS, CHAVE_VISAO_MEUS, type RadarFiltros, type RadarEmpresa } from '@/queries/useRadarLista';
import { useRadarParaVisitarContagem, TETO_CONTAGEM_VISITAR } from '@/queries/useRadarContatoContabil';
import { useRadarAtendimentosAtivos } from '@/queries/useRadarAtendimentos';
import { useRadarMeuTerritorio } from '@/queries/useRadarMeuTerritorio';
import {
  PERTO_DESLIGADO, cidadeDoTerritorioAtiva, patchMexeEmLugar, recorteDaCidade, territorioAutomatico,
} from '@/lib/radar/territorio';
import { tituloMunicipio } from '@/lib/radar/prospectar-hoje';
import { diaMes } from '@/lib/radar/atendimento';
import { useRadarIrmaos } from '@/queries/useRadarIrmaos';
import { useHojeBRT } from '@/lib/radar/useHojeBRT';
import { RadarAgendaHoje } from '@/components/radar/RadarAgendaHoje';
import { useRadarVinculosLista } from '@/queries/useRadarVinculosLista';
import { useRadarKpis } from '@/queries/useRadarKpis';
import { useRadarLoteOmie } from '@/queries/useRadarLote';
import { useRadarLoteVigente } from '@/queries/useRadarLoteVigente';
import { RadarKpis, RadarChipsLote } from '@/components/radar/RadarKpis';
import { RadarFavoritos } from '@/components/radar/RadarFavoritos';
import type { FiltrosSalvos } from '@/lib/radar/favoritos';
import { RadarFiltros as Filtros } from '@/components/radar/RadarFiltros';
import { RadarLinha } from '@/components/radar/RadarLinha';
import { RadarAmostraRegra } from '@/components/radar/RadarAmostraRegra';
import { useRadarAmostra } from '@/queries/useRadarAmostra';
import { casaFiltrosExplicitos, intercalarAmostra, pendenteNaAmostra, resumirAmostra } from '@/lib/radar/amostra';
import { proximoDaFila, type PassoFila } from '@/lib/radar/fila';
import { RadarDetailSheet } from '@/components/radar/RadarDetailSheet';
import { RadarRankingCidades } from '@/components/radar/RadarRankingCidades';
import { RadarAcoesLote } from '@/components/radar/RadarAcoesLote';
import { RadarLoteDialog } from '@/components/radar/RadarLoteDialog';
import { RadarConflitosIndicador } from '@/components/radar/RadarConflitosCadastro';
import { buscarEmpresaRadar, useRadarEmpresa } from '@/queries/useRadarEmpresa';
import { registrarFichaEntregue } from '@/queries/useRadarRegistroEmpurrado';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { escolherFichaAberta } from '@/lib/radar/ficha-aberta';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ROTULO_PRESET, filtrosDaCidade, type CidadeEscolhida, type PresetRadar, type RegiaoRadar } from '@/lib/radar/ui-helpers';
import { TETO_LOTE } from '@/lib/radar/lote';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const RadarMapa = lazy(() => import('@/components/radar/RadarMapa'));

// useUrlState exige um shape com index signature (Record<string, Primitive>).
// RadarFiltros é uma interface (sem index signature) e tem `preset` como union
// PresetRadar — incompatível direto com a restrição StateShape. Em vez de um
// duplo cast `as unknown`, usamos um tipo de transporte para a URL com `preset`
// alargado para `string` + index signature, e NARROW para RadarFiltros uma vez
// na fronteira (typecheck strict, sem `any`). O `set` resultante (Partial do
// transporte) é aceito onde se espera Partial<RadarFiltros> por contravariância
// (PresetRadar ⊆ string).
type RadarUrlState = {
  busca: string;
  uf: string;
  municipio: string;
  municipioCodigo: string;
  cnae: string;
  cnaeSecundario: string;
  status: string;
  incluirJaClientes: boolean;
  comTelefone: boolean;
  incluirSaiuDoDump: boolean;
  soIneditos: boolean;
  soSugeridos: boolean;
  preset: string;
  regiao: string;
  incluirSemContato: boolean;
  paraVisitar: boolean;
  vista: string;
  visao: string;
  perto: string;
  [k: string]: string | boolean;
};

const DEFAULTS: RadarUrlState = {
  busca: '',
  uf: '',
  municipio: '',
  // Cidade escolhida no ranking/mapa: código RFB, filtro EXATO (o nome em `municipio` fica como rótulo).
  municipioCodigo: '',
  cnae: '',
  cnaeSecundario: '',
  status: '',
  incluirJaClientes: false,
  comTelefone: false,
  incluirSaiuDoDump: false,
  soIneditos: false,
  soSugeridos: false,
  preset: 'score',
  // Abre onde a carteira está (MG e vizinhos); "Brasil" é 1 clique e fica na URL.
  regiao: 'atuacao',
  // Lead sem telefone E sem e-mail fica fora por padrão (o toggle "incluir sem contato" traz de volta).
  incluirSemContato: false,
  // "Para visitar" (migration 20261109140000): só leads cujo contato todo parece ser da contabilidade. Filtro (entra
  // na chave e nos favoritos); o recorte é do servidor.
  paraVisitar: false,
  vista: 'lista',
  // "Fila" | "Meus atendimentos" (pacote B2): qual conjunto de leads a lista mostra. Navegação, não filtro.
  visao: 'fila',
  // "Perto dos seus clientes" (pacote F): vazio = automático (a cidade nº 1 do território, se houver e a URL não disser
  // nada de lugar); 'nao' = o vendedor pediu "Toda a região". Navegação, não filtro: fora da chave e dos favoritos.
  perto: '',
};

/** O que um favorito guarda: os filtros da URL, sem a vista, a visão nem o `perto` (navegação, não filtro). */
const { vista: _vista, visao: _visao, perto: _perto, ...PADRAO_FILTROS } = DEFAULTS;
const PADRAO_FAVORITO: FiltrosSalvos = PADRAO_FILTROS;

function narrowPreset(v: string): PresetRadar {
  return v === 'estabelecidas' || v === 'novas' ? v : 'score';
}
function narrowRegiao(v: string): RegiaoRadar {
  return v === 'brasil' ? 'brasil' : 'atuacao';
}

export default function RadarClientes() {
  const [raw, set] = useUrlState<RadarUrlState>(DEFAULTS);
  const qc = useQueryClient();
  // Apresentação ≠ dados (pacote A6): `vista` (lista/mapa) fica FORA dos filtros. Ela entrava pelo spread, então
  // trocar Lista↔Mapa mudava a chave da consulta (refetch da fila) e o efeito abaixo apagava a seleção.
  // A visão "Meus atendimentos" (B2) também fica FORA: entrar nela não muda os filtros nem os favoritos, e voltar à
  // fila devolve o recorte de antes.
  const { vista, visao, perto, ...filtrosAtuais } = raw;
  const meus = visao === 'meus';
  // Pacote F (achado 2): a fila de hoje é do VENDEDOR — com território, abre perto dos clientes dele (a cidade nº 1,
  // a mesma escolha do card e do e-mail). O recorte é VIRTUAL: vale enquanto a URL não diz nada de lugar. Staff sem
  // território (vazio) e leitura que falhou ficam no default de antes; a falha é DITA no resumo.
  const territorio = useRadarMeuTerritorio();
  const cidadesTerritorio = territorio.data ?? null;
  const aguardandoTerritorio = !meus && territorio.isPending && territorio.fetchStatus !== 'idle';
  const cidadeAuto = territorioAutomatico({ ...filtrosAtuais, perto }, cidadesTerritorio);
  const lugar = cidadeAuto ? recorteDaCidade(cidadeAuto) : null;
  const filtros: RadarFiltros = {
    ...filtrosAtuais,
    ...(lugar ?? {}),
    preset: narrowPreset(filtrosAtuais.preset),
    regiao: lugar ? lugar.regiao : narrowRegiao(filtrosAtuais.regiao),
  };
  const cidadeAtiva = cidadeDoTerritorioAtiva(filtros.municipioCodigo ?? '', cidadesTerritorio);
  // Mexer em LUGAR com o automático ligado o desliga — senão limpar o campo "cidade" traria a cidade de volta.
  const setFiltros = useCallback(
    (patch: Partial<RadarUrlState>) => set(cidadeAuto && patchMexeEmLugar(patch) ? { ...patch, perto: PERTO_DESLIGADO } : patch),
    [set, cidadeAuto],
  );
  // Na visão, filtros NEUTROS (já-clientes, fora da região, lote antigo e sem contato continuam sendo seus) e o
  // recorte "é meu" vai à RPC (p_so_meus), antes da paginação.
  const filtrosDaLista = meus ? FILTROS_MEUS_ATENDIMENTOS : filtros;

  // Pacote L (item 6): o dia do SERVIDOR (America/Sao_Paulo), não o do aparelho, e relido na virada — a aba aberta de
  // um dia para o outro não fica pedindo a fila de ontem.
  const hojeISO = useHojeBRT();

  const q = useRadarLista(filtrosDaLista, hojeISO, { soMeus: meus, aguardar: aguardandoTerritorio });
  // Quantos do recorte são "para visitar" (a mesma radar_lista, até 200) — o número do chip, ligado ou não.
  const contagemVisitar = useRadarParaVisitarContagem(filtros, hojeISO, { desligado: meus || aguardandoTerritorio });
  const rotuloContagemVisitar = contagemVisitar.isPending ? '…'
    : contagemVisitar.isError ? '?'
    : contagemVisitar.data >= TETO_CONTAGEM_VISITAR ? `${TETO_CONTAGEM_VISITAR}+` : String(contagemVisitar.data);
  // Fila ainda sem recorte (território a caminho) conta como carregando — senão a tela mostraria "nenhuma empresa".
  const carregandoFila = q.isLoading || aguardandoTerritorio;
  const kpis = useRadarKpis();
  const loteOmie = useRadarLoteOmie();
  // Lote VIGENTE (foto da RFB) — UMA leitura, compartilhada com a fila (que a lê pelo cache),
  // o card de inéditos, a linha e a ficha. `null` = nenhum lote completo (sem selos, fila sem filtro).
  const lote = useRadarLoteVigente().data ?? null;
  const [loteAberto, setLoteAberto] = useState(false);
  // Lote de cadastro no Omie (iniciar, retomar, acompanhar) é só do gestor/master — ver RadarAcoesLote.
  const { isMaster, isGestorComercial } = useAuth();
  const gestor = isMaster || isGestorComercial;

  // Seleção por CNPJ, com SNAPSHOT de cada empresa: a linha pode sair da lista (virou
  // cliente, refetch) e a ação em lote ainda precisa dos dados dela.
  const [selecao, setSelecao] = useState<Map<string, RadarEmpresa>>(new Map());
  const chaveFiltros = JSON.stringify([filtrosDaLista, meus]);
  const chaveAnterior = useRef(chaveFiltros);
  useEffect(() => {
    if (chaveAnterior.current !== chaveFiltros) {
      chaveAnterior.current = chaveFiltros;
      setSelecao(new Map()); // trocar filtro = outra fila; seleção velha confundiria
    }
  }, [chaveFiltros]);

  // Ficha aberta por CNPJ, NA URL (pacote B5): `/radar?cnpj=…` abre a ficha (link do card, do e-mail, do colega).
  // Instância própria do useUrlState: o CNPJ aberto é navegação, não filtro — fora da chave da fila e dos favoritos
  // (a mesma lição do A6). O objeto é relido da lista a cada render (não fica velho).
  // `origem=card` (pacote I): a ficha veio do card "prospectar hoje" — também navegação, fora da chave e dos favoritos.
  // Qualquer troca de ficha a apaga: só a ficha aberta PELO link conta como entregue pelo card.
  const [urlFicha, setUrlFicha] = useUrlState<{ cnpj: string; origem: string }>({ cnpj: '', origem: '' });
  const abertaCnpj = urlFicha.cnpj || null;
  const setAbertaCnpj = useCallback((c: string | null) => setUrlFicha({ cnpj: c ?? '', origem: '' }), [setUrlFicha]);
  const abertaSnapshot = useRef<RadarEmpresa | null>(null);
  // Posição do lead aberto na última vez em que estava na lista: se ele sair (contato registrado → refetch), o
  // "Próximo" segue de onde o vendedor estava, não do topo. Presa ao CNPJ (pacote F, achado 6): a posição de OUTRO
  // lead não vale para a ficha aberta por link — essa nunca esteve na fila, e o "Próximo" dela é o 1º da fila.
  const ultimoIndice = useRef<{ cnpj: string; indice: number } | null>(null);

  // Paginação CONGELADA enquanto um lote roda: a lista é por offset e as cadastradas
  // somem da fila — carregar a página seguinte no meio pularia empresas.
  // Falha na página seguinte também segura o scroll infinito: senão ele re-dispara em laço sobre o mesmo erro. O
  // rodapé oferece "Tentar carregar mais".
  const podePaginar = !!q.hasNextPage && !q.isFetchingNextPage && !q.isFetchNextPageError && !loteOmie.rodando;
  const sentinelRef = useInfiniteScroll(() => q.fetchNextPage(), podePaginar);

  // Amostra de controle: 1 a cada 10 posições, por cima do ranking (região e "só sugeridos" não a escondem; o que
  // foi digitado — busca, UF, cidade, CNAE principal/secundário, status — sim). Regra e motivos em src/lib/radar/amostra.ts.
  const amostraQ = useRadarAmostra();
  const amostra = amostraQ.data ?? null;
  const resumoAmostra = useMemo(() => (amostra ? resumirAmostra(amostra.itens) : null), [amostra]);
  const { busca, uf, municipio, municipioCodigo, cnae, cnaeSecundario, status } = filtros;
  const amostraNaFila = useMemo(() => {
    // A amostra de controle é da FILA; em "Meus atendimentos" só entra o que é seu.
    if (!amostra || meus) return [];
    const f = { busca, uf, municipio, municipioCodigo, cnae, cnaeSecundario, status };
    return amostra.itens.flatMap((i) => (i.empresa && pendenteNaAmostra(i.empresa) && casaFiltrosExplicitos(i.empresa, f) ? [i.empresa] : []));
  }, [amostra, meus, busca, uf, municipio, municipioCodigo, cnae, cnaeSecundario, status]);
  const cnpjsAmostra = useMemo(() => new Set(amostra?.itens.map((i) => i.cnpj) ?? []), [amostra]);
  const filaAcabou = q.isSuccess && !q.hasNextPage;
  const empresas = useMemo(
    () => intercalarAmostra(q.data?.pages.flat() ?? [], amostraNaFila, filaAcabou),
    [q.data, amostraNaFila, filaAcabou],
  );
  // Lead aberto FORA da fila carregada (link do card/e-mail, já-cliente, descartado, ou o lead que acabou de virar
  // cliente e saiu da fila): lido pelo CNPJ numa query sob ['radar'] — a invalidação de toda mutação a relê (pacote I,
  // item 1: antes era um snapshot num ref, e a ficha seguia sem "já é cliente" depois do cadastro no Omie). No deep
  // link ela sai EM PARALELO com a fila (pacote F, achado 5); se a fila chegar com o lead, a linha dela vence.
  const naFila = abertaCnpj ? empresas.some((e) => e.cnpj === abertaCnpj) : false;
  // Filiais da mesma raiz de CNPJ, uma consulta por página (só sinaliza; não mexe na ordem). A amostra é uma "página" a
  // mais — e o lead aberto FORA da fila (link do card/e-mail/agenda) também: sem ela, a ficha dele ficava eternamente em
  // "verificando…" na "mesma empresa" (pacote L, item 5). Página própria: abrir/fechar a ficha não refaz as outras.
  const paginasIrmaos = useMemo(
    () => [...(q.data?.pages ?? []), amostraNaFila, ...(abertaCnpj && !naFila ? [[{ cnpj: abertaCnpj }]] : [])],
    [q.data, amostraNaFila, abertaCnpj, naFila],
  );
  const irmaos = useRadarIrmaos(paginasIrmaos);
  // Possível sucessor / vínculo com cliente, nas mesmas páginas (mesmo núcleo de regras da ficha; o detalhe fica nela).
  const vinculos = useRadarVinculosLista(paginasIrmaos);
  const empresaQ = useRadarEmpresa(abertaCnpj, { ativo: !naFila });
  const aberta = useMemo(() => {
    if (!abertaCnpj) return null;
    const i = empresas.findIndex((e) => e.cnpj === abertaCnpj);
    if (i >= 0) ultimoIndice.current = { cnpj: abertaCnpj, indice: i };
    const atual = escolherFichaAberta({
      cnpj: abertaCnpj,
      daLista: empresas[i] ?? null,
      doServidor: empresaQ.data,
      servidorRelendo: empresaQ.isFetching,
      // O snapshot só vale para o MESMO CNPJ (a regra confere): trocar o `cnpj` da URL não mostra o lead anterior.
      snapshot: abertaSnapshot.current,
    });
    abertaSnapshot.current = atual;
    return atual;
  }, [abertaCnpj, empresas, empresaQ.data, empresaQ.isFetching]);
  // Nada para mostrar e a leitura avulsa respondeu: o lead não existe, ou a leitura falhou → fecha e DIZ. Com a ficha
  // já na tela, uma RELEITURA que falha não fecha nada, mas avisa que o que está ali pode estar velho.
  const fichaVisivel = aberta != null;
  const erroReleitura = useRef<number>(0);
  useEffect(() => {
    if (!abertaCnpj || naFila) return;
    if (empresaQ.isError) {
      if (!fichaVisivel) {
        toast.error('Não consegui abrir a ficha do link', { description: mensagemDeErro(empresaQ.error) ?? 'erro de leitura' });
        setAbertaCnpj(null);
      } else if (erroReleitura.current !== empresaQ.errorUpdatedAt) {
        erroReleitura.current = empresaQ.errorUpdatedAt;
        toast.error('Não consegui atualizar a ficha', { description: 'O que está na tela pode estar desatualizado. Feche e abra de novo.' });
      }
      return;
    }
    if (empresaQ.isSuccess && empresaQ.data === null && !fichaVisivel) {
      toast.error('Lead não encontrado no Radar', { description: `CNPJ ${abertaCnpj}` });
      setAbertaCnpj(null);
    }
  }, [abertaCnpj, naFila, fichaVisivel, empresaQ.isError, empresaQ.isSuccess, empresaQ.data, empresaQ.error, empresaQ.errorUpdatedAt, setAbertaCnpj]);

  // Pacote I (sobra do F): a ficha aberta pelo card "prospectar hoje" CHEGOU — o 2º momento do funil (`ficha_card`).
  // Uma vez por abertura: o `origem` sai da URL logo depois (recarregar não grava de novo). Sob a lente "Ver como"
  // não grava (a lente não é o vendedor; o hook também recusa com motivo 'lente').
  const { isImpersonating } = useImpersonation();
  const fichaCardGravada = useRef<string | null>(null);
  useEffect(() => {
    if (urlFicha.origem !== 'card' || !abertaCnpj || aberta?.cnpj !== abertaCnpj) return;
    if (fichaCardGravada.current === abertaCnpj) return;
    fichaCardGravada.current = abertaCnpj;
    if (!isImpersonating) void registrarFichaEntregue({ origem: 'card', cnpj: abertaCnpj });
    setUrlFicha({ origem: '' });
  }, [urlFicha.origem, abertaCnpj, aberta, isImpersonating, setUrlFicha]);

  const abrir = useCallback((e: RadarEmpresa) => { abertaSnapshot.current = e; setAbertaCnpj(e.cnpj); }, [setAbertaCnpj]);
  // Ficha de um CNPJ que pode não estar na fila (já-cliente, descartado): lê o lead inteiro antes de abrir, pela MESMA
  // query da ficha (a leitura fica no cache e é relida pelas invalidações).
  const abrirPorCnpj = useCallback(async (cnpj: string) => {
    const e = empresas.find((x) => x.cnpj === cnpj) ?? await buscarEmpresaRadar(qc, cnpj);
    if (!e) throw new Error('lead não encontrado no Radar');
    abrir(e);
  }, [empresas, abrir, qc]);
  // "Próximo" (pacote A1): no fim do carregado BUSCA a página seguinte; no fim de verdade fecha a ficha e DIZ que a
  // fila acabou. Nunca volta ao 1º lead (o vendedor re-ligaria para quem já falou). Decisão em src/lib/radar/fila.ts.
  const abertaCnpjRef = useRef(abertaCnpj);
  abertaCnpjRef.current = abertaCnpj;
  const buscandoProximo = useRef(false);
  const aplicarPasso = useCallback((passo: PassoFila<RadarEmpresa>) => {
    if (passo.tipo === 'abrir') {
      track('radar.proximo_lead', {});
      ultimoIndice.current = { cnpj: passo.empresa.cnpj, indice: passo.indice };
      abrir(passo.empresa);
    } else if (passo.tipo === 'fim') {
      track('radar.fila_acabou', {});
      setAbertaCnpj(null);
      toast.info('Fim da fila', { description: 'Não há mais leads com estes filtros.' });
    } else {
      toast.info('Role a lista para carregar mais leads');
    }
  }, [abrir, setAbertaCnpj]);
  const proximo = useCallback(async () => {
    const atual = abertaCnpjRef.current;
    if (!atual || buscandoProximo.current) return;
    const posicao = ultimoIndice.current?.cnpj === atual ? ultimoIndice.current.indice : null;
    const passo = proximoDaFila(empresas, atual, posicao, !!q.hasNextPage);
    if (passo.tipo !== 'buscar_mais') { aplicarPasso(passo); return; }
    if (loteOmie.rodando) {
      toast.info('Paginação pausada enquanto o lote roda', { description: 'O próximo lead aparece quando o lote de cadastro terminar.' });
      return;
    }
    buscandoProximo.current = true;
    try {
      const r = await q.fetchNextPage();
      if (abertaCnpjRef.current !== atual) return; // a ficha mudou ou fechou enquanto a página vinha
      if (r.isError) {
        toast.error('Não consegui carregar o próximo lead', { description: mensagemDeErro(r.error) ?? 'Tente de novo.' });
        return;
      }
      const fila = intercalarAmostra(r.data?.pages.flat() ?? [], amostraNaFila, !r.hasNextPage);
      aplicarPasso(proximoDaFila(fila, atual, posicao, !!r.hasNextPage));
    } finally {
      buscandoProximo.current = false;
    }
  }, [empresas, q, loteOmie.rodando, amostraNaFila, aplicarPasso]);

  const selecionar = useCallback((e: RadarEmpresa, v: boolean) => {
    setSelecao((s) => {
      const n = new Map(s);
      if (v) n.set(e.cnpj, e); else n.delete(e.cnpj);
      return n;
    });
  }, []);
  const removerDaSelecao = useCallback((cnpjs: string[]) => {
    setSelecao((s) => { const n = new Map(s); for (const c of cnpjs) n.delete(c); return n; });
  }, []);
  const todosCarregadosMarcados = empresas.length > 0 && empresas.every((e) => selecao.has(e.cnpj));
  const alternarCarregados = (v: boolean) => {
    track('radar.selecionar_carregados', { total: empresas.length, marcar: v });
    setSelecao((s) => {
      const n = new Map(s);
      for (const e of empresas) { if (v) n.set(e.cnpj, e); else n.delete(e.cnpj); }
      return n;
    });
  };

  // Vencimento e frescor de "Meus atendimentos": a posse viva vem de radar_atendimentos_ativos (a mesma leitura do
  // selo de cada linha). Assumir/liberar/vencer muda o CONJUNTO dos meus → as páginas da visão são relidas.
  const atendimentos = useRadarAtendimentosAtivos();
  const meusAtivos = useMemo(
    () => [...(atendimentos.data?.values() ?? [])].filter((a) => a.ehMeu),
    [atendimentos.data],
  );
  const proximoVencimento = meusAtivos.reduce<string | null>((m, a) => (m === null || a.expiraEm < m ? a.expiraEm : m), null);
  const conjuntoMeus = atendimentos.data ? meusAtivos.map((a) => a.cnpj).sort().join(',') : null;
  const conjuntoAnterior = useRef<string | null>(null);
  useEffect(() => {
    if (conjuntoMeus === null) return;
    if (conjuntoAnterior.current !== null && conjuntoAnterior.current !== conjuntoMeus) {
      void qc.invalidateQueries({ queryKey: ['radar', 'lista'], predicate: (x) => x.queryKey[6] === CHAVE_VISAO_MEUS });
    }
    conjuntoAnterior.current = conjuntoMeus;
  }, [conjuntoMeus, qc]);
  const trocarVisao = (v: 'fila' | 'meus') => {
    if (v === visao) return;
    track('radar.visao_trocada', { visao: v });
    // A visão é da LISTA: o mapa é território da fila, então entrar em "Meus atendimentos" volta para a lista.
    set(v === 'meus' ? { visao: v, vista: 'lista' } : { visao: v });
  };

  const pendentesDoLote = loteOmie.progresso?.pendentes ?? 0;
  // "Mais filtros e território" (B1): fechado para o vendedor, aberto para o gestor (o analítico continua a 1 clique
  // de cada um). Filtro ativo fica CONTADO no rótulo — fechar a seção não pode esconder que a fila está recortada.
  // `null` = o usuário ainda não mexeu: segue o papel (que pode chegar depois do 1º render).
  const [maisEscolhido, setMaisAberto] = useState<boolean | null>(null);
  const maisAberto = maisEscolhido ?? gestor;
  // Só o que RECORTA a fila conta como filtro (a ordem não recorta; a região aparece no resumo da fila).
  // O recorte AUTOMÁTICO do território é o default do vendedor, não filtro: conta só o que veio da URL.
  const filtrosAtivos = (Object.keys(PADRAO_FILTROS) as (keyof typeof PADRAO_FILTROS)[])
    .filter((k) => k !== 'preset' && k !== 'regiao' && filtrosAtuais[k] !== PADRAO_FILTROS[k]).length;
  const rotuloRegiao = cidadeAtiva
    ? `perto dos seus clientes · ${tituloMunicipio(cidadeAtiva.municipioNome)}${cidadeAtiva.uf ? `/${cidadeAtiva.uf}` : ''}`
    : filtros.municipioCodigo ? `${tituloMunicipio(filtros.municipio)}${filtros.uf ? `/${filtros.uf}` : ''}`
    : filtros.uf ? filtros.uf : filtros.regiao === 'brasil' ? 'Brasil' : 'MG e vizinhos';
  // Limpar volta ao default DO VENDEDOR (o território, se houver), não a "MG e vizinhos".
  const limparFiltros = () => { track('radar.filtros_limpos', {}); set({ ...PADRAO_FILTROS, perto: '' }); };
  const escolherCidadeDoTerritorio = (c: { municipioCodigo: string } | null) => {
    track('radar.territorio_escolhido', { cidade: c ? 'sim' : 'toda_regiao', automatica: !!cidadeAuto });
    if (!c) { set({ perto: PERTO_DESLIGADO, municipio: '', municipioCodigo: '', uf: '' }); return; }
    const cidade = cidadesTerritorio?.find((t) => t.municipioCodigo === c.municipioCodigo);
    if (cidade) set({ ...recorteDaCidade(cidade), perto: '' });
  };
  const semPaginas = !q.data?.pages.length;

  // Cidade do ranking/mapa (pacote C, C2): vai o CÓDIGO (exato — o nome tem homônimos em outras UFs) e, se a cidade
  // cai fora do recorte atual, o recorte é ajustado e a tela DIZ o quê, em vez de abrir uma fila vazia.
  const escolherCidade = (c: CidadeEscolhida, origem: 'ranking' | 'mapa') => {
    const { patch, ajuste } = filtrosDaCidade(c, filtros);
    track('radar.cidade_selecionada', { origem, ajustou: ajuste != null });
    setFiltros(origem === 'mapa' ? { ...patch, vista: 'lista' } : patch);
    if (ajuste) toast.info(ajuste);
  };

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto pb-24">
      <div className="flex items-center gap-2">
        <Radar className="w-5 h-5" />
        <h1 className="text-2xl font-display">Radar de Clientes</h1>
        {kpis.data?.lote && (
          <span className="ml-2 text-xs text-muted-foreground border rounded px-2 py-0.5">
            lote {kpis.data.lote}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant={vista !== 'mapa' ? 'default' : 'outline'} size="sm" onClick={() => set({ vista: 'lista' })}>
            Lista
          </Button>
          <Button
            variant={vista === 'mapa' ? 'default' : 'outline'}
            size="sm"
            onClick={() => { track('radar.mapa_aberto', {}); set({ vista: 'mapa', visao: 'fila' }); }}
          >
            Mapa
          </Button>
        </div>
      </div>
      {/* Pacote L (item 3): o que o vendedor combinou para hoje, acima da fila — retornos e posses vencendo. */}
      {vista !== 'mapa' && <RadarAgendaHoje hojeISO={hojeISO} onAbrir={abrirPorCnpj} />}
      {/* Pacote B1: a ENTRADA do vendedor é a fila, não o painel. Antes havia ~16 controles acima da lista, o 1º lead
          ficava abaixo da dobra no celular e o número de destaque era "A contatar 508.719". */}
      <section className="rounded-md border p-3 space-y-2" data-testid="radar-fila-de-hoje">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-display leading-tight" data-testid="radar-fila-titulo">
              {meus ? 'Seus atendimentos' : 'Sua fila de hoje'}
            </h2>
            <p className="text-xs text-muted-foreground" data-testid="radar-fila-resumo">
              {carregandoFila ? (meus ? 'Carregando seus atendimentos…' : 'Carregando a fila…')
                : meus
                  ? `${empresas.length}${q.hasNextPage ? '+' : ''} lead${empresas.length === 1 ? '' : 's'} com você`
                    // Leitura da posse falhou: DIZ que o vencimento está indisponível (ausente ≠ "nada vence").
                    + (atendimentos.isError ? ' · vencimento indisponível'
                      : proximoVencimento ? ` · o próximo vence em ${diaMes(proximoVencimento)}` : '')
                  : `${empresas.length}${q.hasNextPage ? '+' : ''} lead${empresas.length === 1 ? '' : 's'} · ${rotuloRegiao} · ordem: ${ROTULO_PRESET[filtros.preset]}`
                    // Território que não deu para ler: o default é o de antes, e a tela DIZ (ausente ≠ "sem território").
                    + (territorio.isError ? ' · não consegui ler seu território' : '')}
            </p>
          </div>
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Qual lista ver">
            <Button size="sm" variant={meus ? 'ghost' : 'secondary'} aria-pressed={!meus} onClick={() => trocarVisao('fila')}>
              Fila
            </Button>
            <Button size="sm" variant={meus ? 'secondary' : 'ghost'} aria-pressed={meus} onClick={() => trocarVisao('meus')}>
              Meus atendimentos
            </Button>
          </div>
          <Button size="touch" className="ml-auto" disabled={empresas.length === 0}
            onClick={() => { const primeiro = empresas[0]; if (primeiro) { track('radar.fila_comecar', { visao }); abrir(primeiro); } }}>
            {meus ? 'Abrir o 1º atendimento' : 'Começar pelo 1º lead'}
          </Button>
        </div>
        {!meus && cidadesTerritorio && cidadesTerritorio.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Perto dos seus clientes" data-testid="radar-territorio">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <MapPin className="w-3 h-3 shrink-0" /> Perto dos seus clientes:
            </span>
            {cidadesTerritorio.map((c) => {
              const ativa = cidadeAtiva?.municipioCodigo === c.municipioCodigo;
              return (
                <Button key={c.municipioCodigo} size="sm" variant={ativa ? 'secondary' : 'outline'} aria-pressed={ativa}
                  className="h-7 px-2 text-xs" onClick={() => escolherCidadeDoTerritorio(c)}
                  title={`${c.clientes} cliente${c.clientes === 1 ? '' : 's'} seu${c.clientes === 1 ? '' : 's'} nesta cidade`}>
                  {tituloMunicipio(c.municipioNome)}{c.uf ? `/${c.uf}` : ''}
                  <span className="ml-1 text-muted-foreground font-tabular">{c.clientes}</span>
                </Button>
              );
            })}
            <Button size="sm" variant={cidadeAtiva ? 'ghost' : 'secondary'} aria-pressed={!cidadeAtiva}
              className="h-7 px-2 text-xs" onClick={() => escolherCidadeDoTerritorio(null)}>
              Toda a região
            </Button>
          </div>
        )}
        {!meus && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={filtros.paraVisitar ? 'secondary' : 'outline'} aria-pressed={!!filtros.paraVisitar}
              className="h-7 px-2 text-xs" data-testid="radar-chip-visitar"
              title={contagemVisitar.isError
                ? 'Não consegui contar os leads para visitar neste recorte'
                : 'Leads cujo telefone e e-mail da Receita parecem ser da contabilidade: vá ao endereço em vez de ligar'}
              onClick={() => {
                const v = !filtros.paraVisitar;
                track('radar.filtro_para_visitar', { ligado: v, contagem: contagemVisitar.data ?? null });
                setFiltros({ paraVisitar: v });
              }}>
              <MapPin className="w-3 h-3 mr-1" /> Para visitar
              <span className="ml-1 font-tabular text-muted-foreground" data-testid="radar-chip-visitar-contagem">{rotuloContagemVisitar}</span>
            </Button>
          </div>
        )}
        {meus ? (
          <p className="text-xs text-muted-foreground" data-testid="radar-meus-explica">
            Os leads que você assumiu e ainda estão com você (a posse vence 7 dias depois do último contato). Filtros e
            território valem para a fila, não aqui.
          </p>
        ) : (
        <Collapsible open={maisAberto} onOpenChange={(v) => { setMaisAberto(v); track('radar.mais_filtros', { aberto: v }); }}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="px-2 -ml-2" aria-expanded={maisAberto}>
              <SlidersHorizontal className="w-4 h-4 mr-1" />
              Mais filtros e território
              {filtrosAtivos > 0 && <span className="ml-1 text-xs text-status-info">({filtrosAtivos} ativo{filtrosAtivos === 1 ? '' : 's'})</span>}
              <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${maisAberto ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
            <Filtros
              filtros={filtros}
              set={setFiltros}
              lote={lote}
              acoes={<RadarFavoritos atuais={filtrosAtuais} padrao={PADRAO_FAVORITO} onAplicar={(f) => set({ ...PADRAO_FAVORITO, ...f })} />}
            />
            <RadarChipsLote
              soIneditos={filtros.soIneditos}
              onSoIneditos={(v) => set({ soIneditos: v })}
              soSugeridos={filtros.soSugeridos}
              onSoSugeridos={(v) => set({ soSugeridos: v })}
            />
            <RadarKpis />
            {/* O território espera a 1ª página da fila (C5): é secundário e não pode disputar a abertura com ela. */}
            <RadarRankingCidades filtros={filtros} hojeISO={hojeISO} adiar={q.isPending || aguardandoTerritorio} onPick={(c) => escolherCidade(c, 'ranking')} />
          </CollapsibleContent>
        </Collapsible>
        )}
      </section>

      {/* Conflitos Radar×Omie guardados no servidor: alcançáveis mesmo fora da fila e depois de esquecer o lote. */}
      <RadarConflitosIndicador onAbrir={abrirPorCnpj} />
      {/* Lote interrompido (aba fechada, parada, falhas): oferece retomar em vez de fingir que nada aconteceu. */}
      {gestor && loteOmie.lote && !loteOmie.rodando && pendentesDoLote > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm">
          <RotateCcw className="w-4 h-4 text-status-warning shrink-0" />
          <span className="flex-1">
            Lote de cadastro no Omie com <strong>{pendentesDoLote}</strong> lead{pendentesDoLote === 1 ? '' : 's'} pendente{pendentesDoLote === 1 ? '' : 's'}
            {' '}(iniciado {new Date(loteOmie.lote.iniciadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}).
          </span>
          <Button size="sm" variant="outline" onClick={() => setLoteAberto(true)}>Ver / retomar</Button>
        </div>
      )}
      {gestor && loteOmie.rodando && !loteAberto && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="flex-1">Cadastrando no Omie… {loteOmie.progresso?.feitos ?? 0}/{loteOmie.progresso?.total ?? 0}</span>
          <Button size="sm" variant="outline" onClick={() => setLoteAberto(true)}>Acompanhar</Button>
        </div>
      )}

      {vista !== 'mapa' && !meus && (
        <RadarAmostraRegra
          sorteio={amostra?.sorteio ?? null}
          resumo={resumoAmostra}
          naFila={amostraNaFila.length}
          erro={amostraQ.isError ? mensagemDeErro(amostraQ.error) ?? 'erro de leitura' : null}
        />
      )}
      {vista === 'mapa' ? (
        <Suspense fallback={<Skeleton className="h-[420px]" />}>
          <RadarMapa
            filtros={filtros}
            hojeISO={hojeISO}
            onPick={(c) => escolherCidade(c, 'mapa')}
          />
        </Suspense>
      ) : (
        <div className="rounded-md border">
          {empresas.length > 0 && (
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={todosCarregadosMarcados}
                onCheckedChange={(v) => alternarCarregados(v === true)}
                aria-label="Selecionar todos os carregados"
              />
              <span>
                {todosCarregadosMarcados ? 'Desmarcar' : 'Selecionar'} os {empresas.length} carregados
                {q.hasNextPage ? ' (há mais páginas — role para carregar)' : ''}
                {empresas.length > TETO_LOTE ? ` · ações em lote tratam até ${TETO_LOTE} por vez` : ''}
              </span>
              {selecao.size > 0 && <span className="ml-auto tabular-nums">{selecao.size} selecionado{selecao.size === 1 ? '' : 's'}</span>}
            </div>
          )}
          {carregandoFila ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : q.isError && semPaginas ? (
            // Só sem NENHUMA página: falha na página seguinte preserva a lista (rodapé abaixo) — pacote A5.
            <EmptyState
              tone="operational" icon={Radar} title="Não foi possível carregar a fila"
              description={mensagemDeErro(q.error) ?? 'Tente novamente em instantes.'}
              actionLabel="Tentar de novo" onAction={() => void q.refetch()}
            />
          ) : empresas.length === 0 && meus ? (
            <EmptyState
              tone="operational" icon={Radar} title="Nenhum lead com você agora"
              description="Assuma um lead na ficha para ele aparecer aqui. A posse vence 7 dias depois do último contato."
              actionLabel="Ver a fila" onAction={() => trocarVisao('fila')}
            />
          ) : empresas.length === 0 ? (
            <EmptyState
              tone="operational" icon={Radar} title="Nenhuma empresa nesta fila"
              description={`Ajuste os filtros ou troque a ordem (${Object.values(ROTULO_PRESET).join(', ')}).`}
              actionLabel="Limpar filtros" onAction={limparFiltros}
            />
          ) : (
            <>
              {/* Pacote I (Codex, achado 13): releitura que FALHOU com páginas já na tela (invalidação depois de um
                  contato/cadastro, refetch comum) — as linhas são da leitura anterior e a tela DIZ. A falha da página
                  SEGUINTE tem o próprio rodapé, abaixo. */}
              {q.isError && !q.isFetchNextPageError && (
                <div className="flex items-center gap-2 border-b border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs" data-testid="radar-fila-desatualizada">
                  <span className="flex-1 text-status-warning">
                    Não consegui atualizar a fila: as linhas abaixo são da leitura anterior e podem estar desatualizadas.
                  </span>
                  <Button size="sm" variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>Tentar de novo</Button>
                </div>
              )}
              {empresas.map((e) => (
                <RadarLinha
                  key={e.cnpj}
                  empresa={e}
                  hojeISO={hojeISO}
                  selecionada={selecao.has(e.cnpj)}
                  onSelecionar={(v) => selecionar(e, v)}
                  onAbrir={() => abrir(e)}
                  lote={lote}
                  mostrarMotivos={!meus && filtros.soSugeridos}
                  irmaos={irmaos.dados.get(e.cnpj) ?? null}
                  irmaosEstado={irmaos.estadoDe(e.cnpj)}
                  vinculo={vinculos.dados.get(e.cnpj) ?? null}
                  vinculoEstado={vinculos.estadoDe(e.cnpj)}
                  amostra={cnpjsAmostra.has(e.cnpj) ? amostra?.sorteio ?? null : null}
                />
              ))}
              <div ref={sentinelRef} className="min-h-10 py-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                {q.isFetchingNextPage ? 'Carregando…'
                  : q.isFetchNextPageError ? (
                    <>
                      <span className="text-status-error" data-testid="radar-erro-pagina">Não consegui carregar mais leads.</span>
                      <Button size="sm" variant="outline" onClick={() => void q.fetchNextPage()}>Tentar carregar mais</Button>
                    </>
                  )
                  : loteOmie.rodando && q.hasNextPage ? 'Paginação pausada enquanto o lote roda' : q.hasNextPage ? '' : 'Fim da lista'}
              </div>
            </>
          )}
        </div>
      )}

      <RadarAcoesLote
        selecao={Array.from(selecao.values())}
        onLimpar={() => setSelecao(new Map())}
        onRemover={removerDaSelecao}
        loteOmie={loteOmie}
        onAbrirLote={() => setLoteAberto(true)}
      />
      <RadarLoteDialog lote={loteOmie} open={gestor && loteAberto} onClose={() => setLoteAberto(false)} />
      <RadarDetailSheet
        empresa={aberta}
        hojeISO={hojeISO}
        onClose={() => setAbertaCnpj(null)}
        onProximo={() => void proximo()}
        lote={lote}
        irmaos={aberta ? irmaos.dados.get(aberta.cnpj) ?? null : null}
        irmaosEstado={aberta ? irmaos.estadoDe(aberta.cnpj) : 'carregando'}
      />
    </div>
  );
}
