import { useMemo } from 'react';
import { PackageSearch } from 'lucide-react';
import { useReposicaoEmpresa } from '@/contexts/ReposicaoEmpresaContext';
import { useUrlState } from '@/hooks/useUrlState';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DESTINOS, ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import type { Empresa, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { useRaioX } from './useRaioX';
import { RaioXPlacar } from './RaioXPlacar';
import { RaioXMercadoria } from './RaioXMercadoria';
import { RaioXContagem } from './RaioXContagem';
import { RaioXSaidas } from './RaioXSaidas';

type Segmento = 'mercadoria' | 'uso' | 'nao' | 'saidas';
const SEGMENTOS: { id: Segmento; rotulo: string }[] = [
  { id: 'mercadoria', rotulo: 'Mercadoria' },
  { id: 'uso', rotulo: 'Uso e consumo / insumo' },
  { id: 'nao', rotulo: 'Não-mercadoria' },
  { id: 'saidas', rotulo: 'Saídas' },
];

function empresaDoRaioX(e: string): Empresa | null {
  if (e === 'OBEN') return 'oben';
  if (e === 'COLACOR') return 'colacor';
  return null; // Colacor SC e demais: sem cadastro de produto
}

const porValorDesc = (a: ItemRaioX, b: ItemRaioX) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity);

export function RaioXTab() {
  const { empresa } = useReposicaoEmpresa();
  const chave = empresaDoRaioX(empresa);
  const rx = useRaioX(chave);
  const [f, setF] = useUrlState({ rx: 'mercadoria', rxDestino: '', rxForn: '', rxStatus: '', rxTop: false as boolean, rxBusca: '' });

  const segmento: Segmento = f.rx === 'uso' || f.rx === 'nao' || f.rx === 'saidas' ? f.rx : 'mercadoria';

  const mercadoria = useMemo(() => rx.itens.filter((i) => i.categoria === 'mercadoria' && i.parado), [rx.itens]);
  const fornecedores = useMemo(
    () => [...new Set(mercadoria.map((i) => i.fornecedor).filter((x): x is string => !!x))].sort(),
    [mercadoria],
  );

  const filtrados = useMemo(() => {
    const busca = f.rxBusca.trim().toLowerCase();
    return mercadoria
      .filter((i) => {
        if (f.rxDestino && i.destino_sugerido !== f.rxDestino) return false;
        if (f.rxForn && i.fornecedor !== f.rxForn) return false;
        const decidido = !!rx.decisoes.get(i.sku_codigo_omie)?.destino;
        if (f.rxStatus === 'pendente' && decidido) return false;
        if (f.rxStatus === 'decidido' && !decidido) return false;
        if (f.rxTop && !i.top) return false;
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
            <select aria-label="Destino sugerido" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.rxDestino} onChange={(e) => setF({ rxDestino: e.target.value })}>
              <option value="">Todos os destinos</option>
              {DESTINOS.map((d) => <option key={d} value={d}>{ROTULOS[d]}</option>)}
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
          {filtrados.length === 0 ? (
            <EmptyState tone="operational" icon={PackageSearch} title="Nada parado" description={mercadoria.length === 0 ? 'Nenhuma mercadoria parada nesta empresa.' : 'Nenhum item com esses filtros.'} />
          ) : (
            <RaioXMercadoria itens={filtrados} decisoes={rx.decisoes} />
          )}
        </>
      ) : segmento === 'saidas' ? (
        <RaioXSaidas itens={rx.itens} decisoes={rx.decisoes} empresa={chave} />
      ) : contagem.length === 0 ? (
        <EmptyState tone="operational" icon={PackageSearch} title="Nada neste segmento" description="Nenhum item nesta categoria." />
      ) : (
        <RaioXContagem categoria={segmento === 'uso' ? 'uso_consumo' : 'nao_mercadoria'} itens={contagem} decisoes={rx.decisoes} />
      )}
    </div>
  );
}
