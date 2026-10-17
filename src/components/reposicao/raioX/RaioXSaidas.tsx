// Saídas do Raio-X: lista de troca por fornecedor (copiar/CSV — o app não envia nada) e venda dirigida por
// cliente (1 missão por cliente, com todos os SKUs dele, pelo DesovaMissaoDialog). Ausente ≠ zero.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PackageSearch } from 'lucide-react';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { DesovaMissaoDialog } from '@/components/reposicao/baixoGiro/DesovaMissaoDialog';
import type { AlvoDesova } from '@/lib/reposicao/desova-helpers';
import { csvTroca, listaTroca, SEM_COMPRADOR, textoTroca, vendaDirigidaPorCliente, type GrupoCliente, type LinhaTroca } from '@/lib/reposicao/raio-x/saidas';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { hojeSP } from '@/lib/time/sp-day';
import { fmtValor } from './formato';

function diasSemVender(ult: string | null): number | null {
  if (!ult) return null; // Colacor / sem NF: desconhecido, nunca 0
  const d = Math.floor((Date.parse(hojeSP()) - Date.parse(ult.slice(0, 10))) / 86_400_000);
  return Number.isNaN(d) ? null : Math.max(0, d);
}

/** Item do Raio-X → alvo da missão. `valor` null segue null (sem custo — não avaliado). */
function paraAlvo(i: ItemRaioX): AlvoDesova {
  return {
    sku_codigo_omie: i.sku_codigo_omie,
    sku_descricao: i.descricao,
    excedente_un: i.saldo,
    capital_excedente: i.valor,
    tempo_digerir_dias: i.cobertura === null ? null : Math.round(i.cobertura),
    dias_sem_vender: diasSemVender(i.ult_venda),
  };
}

function baixarCsv(csv: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `raio-x-lista-de-troca-${hojeSP()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function RaioXSaidas({ itens, decisoes, empresa }: {
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  empresa: string; // 'oben' | 'colacor'
}) {
  const troca = useMemo(() => listaTroca(itens, decisoes), [itens, decisoes]);
  const grupos = useMemo(() => vendaDirigidaPorCliente(itens, decisoes), [itens, decisoes]);
  const [missao, setMissao] = useState<GrupoCliente | null>(null);

  const porFornecedor = useMemo(() => {
    const m = new Map<string, LinhaTroca[]>();
    for (const l of troca) m.set(l.fornecedor, [...(m.get(l.fornecedor) ?? []), l]);
    return [...m.entries()];
  }, [troca]);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(textoTroca(troca));
      toast.success('Lista de troca copiada');
    } catch {
      toast.error('Não foi possível copiar a lista');
    }
  };

  return (
    <div className="space-y-6">
      <section aria-label="Lista de troca" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-lg">Lista de troca</h3>
          {troca.length > 0 && (
            <div className="flex gap-2">
              <Button size="touch" variant="outline" onClick={copiar}>Copiar lista</Button>
              <Button size="touch" variant="outline" onClick={() => baixarCsv(csvTroca(troca))}>Baixar CSV</Button>
            </div>
          )}
        </div>
        {troca.length === 0 ? (
          <EmptyState tone="operational" icon={PackageSearch} title="Nada para trocar" description="Nenhum SKU decidido como troca." />
        ) : porFornecedor.map(([forn, ls]) => (
          <div key={forn} className="rounded-md border p-3">
            <div className="text-sm font-medium">{forn}</div>
            <ul className="mt-1 space-y-0.5 text-sm">
              {ls.map((l) => (
                <li key={l.sku_codigo_omie}>{l.codigo} {l.descricao ?? ''} — {l.saldo} un · {fmtValor(l.valor)}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-label="Venda dirigida" className="space-y-3">
        <h3 className="font-display text-lg">Venda dirigida por cliente</h3>
        {grupos.length === 0 ? (
          <EmptyState tone="operational" icon={PackageSearch} title="Nada para vender" description="Nenhum SKU decidido como venda dirigida." />
        ) : grupos.map((g) => (
          <div key={g.cliente} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="font-medium">{g.cliente}</span>
                <span className="text-muted-foreground"> — {g.itens.length} SKU(s) · {g.valor !== null && g.itens.some((i) => i.valor === null) ? `≥ ${fmtValor(g.valor)} (parcial)` : fmtValor(g.valor)}</span>
              </div>
              {g.cliente !== SEM_COMPRADOR && (
                <Button size="touch" onClick={() => setMissao(g)}>Criar missão</Button>
              )}
            </div>
            <ul className="mt-1 space-y-0.5 text-sm">
              {g.itens.map((i) => (
                <li key={i.sku_codigo_omie}>{i.codigo} {i.descricao ?? ''} — {i.saldo} un · {fmtValor(i.valor)}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <DesovaMissaoDialog
        open={!!missao}
        onOpenChange={(v) => { if (!v) setMissao(null); }}
        alvos={(missao?.itens ?? []).map(paraAlvo)}
        empresa={empresa}
        tituloPrefixo={missao ? `Cliente ${missao.cliente}` : undefined}
        onCriada={() => track('raio_x.missao_criada', { empresa, skus: missao?.itens.length ?? 0 })}
      />
    </div>
  );
}
