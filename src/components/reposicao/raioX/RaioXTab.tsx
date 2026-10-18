import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { useReposicaoEmpresa } from '@/contexts/ReposicaoEmpresaContext';
import { useUrlState } from '@/hooks/useUrlState';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DESTINOS, ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import { destinoEfetivo, empresaDoRaioX, fornecedorEfetivo } from '@/lib/reposicao/raio-x/decisao';
import type { Empresa, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { useRaioX, useRaioXMedicao } from './useRaioX';
import { RaioXPlacar } from './RaioXPlacar';
import { RaioXCaixaLiberado } from './RaioXCaixaLiberado';
import { RaioXMercadoria } from './RaioXMercadoria';
import { RaioXContagem } from './RaioXContagem';
import { RaioXSaidas } from './RaioXSaidas';
import { DecisaoSheet } from './DecisaoSheet';

type Segmento = 'mercadoria' | 'uso' | 'nao' | 'saidas';
const SEGMENTOS: { id: Segmento; rotulo: string }[] = [
  { id: 'mercadoria', rotulo: 'Mercadoria' },
  { id: 'uso', rotulo: 'Uso e consumo / insumo' },
  { id: 'nao', rotulo: 'Não-mercadoria' },
  { id: 'saidas', rotulo: 'Saídas' },
];

/** Filtro de destino (Ruling S4): os 6 destinos + as 3 sugestões que não são destino. */
const OPCOES_DESTINO = [...DESTINOS, 'novo_aguarde', 'revisar', 'sem_historico'] as const;

const porValorDesc = (a: ItemRaioX, b: ItemRaioX) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity);

export function RaioXTab() {
  const { empresa } = useReposicaoEmpresa();
  const chave = empresaDoRaioX(empresa);
  const rx = useRaioX(chave);
  const medicao = useRaioXMedicao(chave);
  // Sheet: guarda sku + empresa de quem abriu; item e decisão são relidos do cache (vivos após invalidar).
  const [aberto, setAberto] = useState<{ sku: number; empresa: Empresa } | null>(null);
  const fechar = useCallback(() => setAberto(null), []);
  // Trocou a empresa no seletor → descarta o Sheet (senão reabriria ao voltar para a empresa original).
  useEffect(() => {
    if (aberto && aberto.empresa !== chave) setAberto(null);
  }, [aberto, chave]);
  const qc = useQueryClient();
  // Abrir relê o servidor (FI1): sem refetch-on-focus, o formulário nasceria do cache velho e a assinatura do S9
  // nunca mudaria — salvar apagaria o que outro operador gravou. Quando o refetch chegar com outra assinatura,
  // o Sheet bloqueia e oferece "Recarregar".
  const abrir = useCallback((i: ItemRaioX) => {
    if (!chave) return;
    setAberto({ sku: i.sku_codigo_omie, empresa: chave });
    void qc.invalidateQueries({ queryKey: ['raio-x', chave] });
  }, [chave, qc]);
  const [f, setF] = useUrlState({ rx: 'mercadoria', rxDestino: '', rxForn: '', rxStatus: '', rxTop: false as boolean, rxBusca: '', rxSku: '' });

  const codigos = useMemo(() => new Map(rx.itens.map((i) => [i.sku_codigo_omie, i.codigo])), [rx.itens]);
  // Contradição clicável: lista de mercadoria filtrada pelo SKU exato (`rxSku` na URL — nunca a busca por código, que é substring).
  const filtrarSku = useCallback(
    (sku: number) => setF({ rx: 'mercadoria', rxDestino: '', rxForn: '', rxStatus: '', rxTop: false, rxBusca: '', rxSku: String(sku) }),
    [setF],
  );

  const segmento: Segmento = f.rx === 'uso' || f.rx === 'nao' || f.rx === 'saidas' ? f.rx : 'mercadoria';

  const mercadoria = useMemo(() => rx.itens.filter((i) => i.categoria === 'mercadoria' && i.parado), [rx.itens]);
  const fornecedores = useMemo(
    () =>
      [...new Set(mercadoria.map((i) => fornecedorEfetivo(i, rx.decisoes.get(i.sku_codigo_omie))).filter((x): x is string => !!x))].sort(),
    [mercadoria, rx.decisoes],
  );

  const filtrados = useMemo(() => {
    const busca = f.rxBusca.trim().toLowerCase();
    return mercadoria
      .filter((i) => {
        const d = rx.decisoes.get(i.sku_codigo_omie);
        if (f.rxDestino && destinoEfetivo(i, d) !== f.rxDestino) return false;
        if (f.rxForn && fornecedorEfetivo(i, d) !== f.rxForn) return false;
        const decidido = !!d?.destino;
        if (f.rxStatus === 'pendente' && decidido) return false;
        if (f.rxStatus === 'decidido' && !decidido) return false;
        if (f.rxTop && !i.top) return false;
        if (f.rxSku && String(i.sku_codigo_omie) !== f.rxSku) return false;
        if (busca && !`${i.codigo} ${i.descricao ?? ''}`.toLowerCase().includes(busca)) return false;
        return true;
      })
      .sort(porValorDesc);
  }, [mercadoria, f, rx.decisoes]);

  const categoriaSeg = segmento === 'uso' ? 'uso_consumo' : segmento === 'nao' ? 'nao_mercadoria' : null;
  const contagem = useMemo(
    () => (categoriaSeg ? rx.itens.filter((i) => i.categoria === categoriaSeg).sort(porValorDesc) : []),
    [rx.itens, categoriaSeg],
  );

  // Item sumiu do cache (reclassificado/fora do recorte) → nada a mostrar; o Sheet não abre com item velho.
  const itemAberto = aberto && aberto.empresa === chave ? rx.itens.find((i) => i.sku_codigo_omie === aberto.sku) ?? null : null;

  if (chave === null) {
    return <EmptyState tone="operational" icon={PackageSearch} title="Sem cadastro de produto" description="sem cadastro de produto — fora do Raio-X por ora" />;
  }
  if (rx.isLoading) return <PageSkeleton variant="list" />;
  if (rx.erro) {
    const semPermissao = (rx.erro as { code?: string }).code === '42501';
    return (
      <div role="alert" className="rounded-md border border-status-error/30 bg-status-error/5 p-4 text-sm">
        {semPermissao
          ? 'Raio-X indisponível: sem permissão para ver custo.'
          : 'Não foi possível carregar o Raio-X. Recarregue a página; se persistir, avise o time.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rx.syncedHoras !== null && rx.syncedHoras >= 24 && (
        <p role="status" className="text-xs text-status-warning">
          estoque sincronizado há {Math.floor(rx.syncedHoras)} h — números podem estar defasados
        </p>
      )}
      <RaioXPlacar placar={rx.placar} />
      <RaioXCaixaLiberado
        linhas={medicao.linhas}
        isLoading={medicao.isLoading}
        erro={medicao.erro}
        empresa={chave}
        codigos={codigos}
        onFiltrarSku={filtrarSku}
      />

      <div role="group" aria-label="Segmento" className="flex flex-wrap gap-2">
        {SEGMENTOS.map((s) => (
          <Button key={s.id} size="touch" variant={segmento === s.id ? 'default' : 'outline'} aria-pressed={segmento === s.id} onClick={() => setF({ rx: s.id })}>
            {s.rotulo}
          </Button>
        ))}
      </div>

      {segmento === 'mercadoria' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Destino" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.rxDestino} onChange={(e) => setF({ rxDestino: e.target.value })}>
              <option value="">Todos os destinos</option>
              {OPCOES_DESTINO.map((d) => <option key={d} value={d}>{ROTULOS[d]}</option>)}
            </select>
            <select aria-label="Fornecedor" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.rxForn} onChange={(e) => setF({ rxForn: e.target.value })}>
              <option value="">Todos os fornecedores</option>
              {fornecedores.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select aria-label="Situação" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.rxStatus} onChange={(e) => setF({ rxStatus: e.target.value })}>
              <option value="">Pendentes e decididos</option>
              <option value="pendente">Pendente</option>
              <option value="decidido">Decidido</option>
            </select>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={f.rxTop} onChange={(e) => setF({ rxTop: e.target.checked })} /> Top 61
            </label>
            <Input className="h-9 w-56" placeholder="Buscar código ou descrição" value={f.rxBusca} onChange={(e) => setF({ rxBusca: e.target.value })} />
          </div>
          {f.rxSku && (
            <div className="flex items-center gap-2 text-sm">
              <span>Filtrando pelo SKU {codigos.get(Number(f.rxSku)) ?? f.rxSku}</span>
              <Button size="sm" variant="outline" onClick={() => setF({ rxSku: '' })}>Limpar filtro do SKU</Button>
            </div>
          )}
          {filtrados.length === 0 ? (
            <EmptyState tone="operational" icon={PackageSearch} title="Nada parado" description={mercadoria.length === 0 ? 'Nenhuma mercadoria parada nesta empresa.' : 'Nenhum item com esses filtros.'} />
          ) : (
            <RaioXMercadoria itens={filtrados} decisoes={rx.decisoes} onDecidir={abrir} />
          )}
        </>
      ) : segmento === 'saidas' ? (
        <RaioXSaidas itens={rx.itens} decisoes={rx.decisoes} empresa={chave} />
      ) : contagem.length === 0 ? (
        <EmptyState tone="operational" icon={PackageSearch} title="Nada neste segmento" description="Nenhum item nesta categoria." />
      ) : (
        <RaioXContagem empresa={chave} categoria={segmento === 'uso' ? 'uso_consumo' : 'nao_mercadoria'} itens={contagem} decisoes={rx.decisoes} onDecidir={abrir} />
      )}
      {itemAberto && aberto && (
        <DecisaoSheet empresa={aberto.empresa} item={itemAberto} decisao={rx.decisoes.get(itemAberto.sku_codigo_omie)} onClose={fechar} />
      )}
    </div>
  );
}
