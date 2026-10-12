import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, Palette, ChevronDown, ChevronUp, Loader2, Plus } from 'lucide-react';
import { format } from 'date-fns';
import type { CorDoCliente, OcorrenciaCor } from '@/lib/tint/cores-do-cliente';
import { fmt } from '@/hooks/useUnifiedOrder';
import { chaveOcorrenciaCor } from '@/lib/unified-order/chave-ocorrencia-cor';

/** O que o card precisa saber do 1 toque — o cálculo (fórmula + preço do motor) mora no
 *  tintométrico (`useTintCoresDoClienteUmToque`); aqui é só exibição. */
export interface UmToqueNoCard {
  corId: string;
  nomeCor: string;
  preco: number;
}


interface CoresDoClienteCardProps {
  cores: CorDoCliente[];
  coresFiltradas: CorDoCliente[];
  busca: string;
  onBuscaChange: (v: string) => void;
  isLoading: boolean;
  /** Re-pedido: clique numa ocorrência (cor + base daquela vez). */
  onRepetirCor: (cor: CorDoCliente, ocorrencia: OcorrenciaCor) => void;
  /** Fase 2A: estado do 1 toque por ocorrência (`chaveOcorrenciaCor`). Ausente = só o diálogo. */
  umToque?: Record<string, UmToqueNoCard | 'carregando'>;
  /** 1 toque: a cor entra no pedido com o preço do motor já calculado. */
  onAdicionarUmToque?: (chave: string, ocorrencia: OcorrenciaCor) => void;
}

const empresaLabel = (account: string) =>
  account === 'colacor' ? 'Colacor' : account === 'colacor_sc' ? 'Colacor SC' : 'Oben';

const fmtData = (iso: string) => {
  try {
    return format(new Date(iso), 'dd/MM/yyyy');
  } catch {
    return '';
  }
};

/**
 * "🎨 Cores do cliente" — histórico de cores já pedidas pelo cliente selecionado
 * no wizard. Sem busca mostra as últimas cores (descoberta passiva); a busca é
 * acento-insensitive. Clique na ocorrência reabre o fluxo de tingir com a base
 * daquela compra (podendo trocar embalagem/acabamento no dialog).
 * Não renderiza nada quando o cliente não tem cor no histórico.
 */
export function CoresDoClienteCard({
  cores, coresFiltradas, busca, onBuscaChange, isLoading, onRepetirCor, umToque, onAdicionarUmToque,
}: CoresDoClienteCardProps) {
  const [aberto, setAberto] = useState(true);

  if (!isLoading && cores.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={() => setAberto((a) => !a)}
        >
          <CardTitle className="text-sm flex items-center gap-2">
            <Palette className="w-4 h-4" /> Cores do cliente
            {cores.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{cores.length}</Badge>
            )}
          </CardTitle>
          {aberto ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
      </CardHeader>
      {aberto && (
        <CardContent>
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          ) : (
            <>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar cor já pedida... (ex: verde afiacao)"
                  value={busca}
                  onChange={(e) => onBuscaChange(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
              <div className="max-h-[320px] overflow-y-auto space-y-2">
                {coresFiltradas.map((cor) => (
                  <div key={cor.nome} className="rounded-lg border p-2">
                    <p className="text-xs font-medium flex items-center gap-1.5">
                      🎨 {cor.nome}
                      <span className="text-[10px] text-muted-foreground font-normal">
                        {cor.ocorrencias.length}× pedida
                      </span>
                    </p>
                    <div className="mt-1 space-y-1">
                      {cor.ocorrencias.slice(0, 4).map((oc, i) => {
                        const chave = chaveOcorrenciaCor(cor.nome, i);
                        const estado = umToque?.[chave];
                        const pronto = typeof estado === 'object' && onAdicionarUmToque ? estado : null;
                        return (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                            <span className="font-tabular text-foreground">{fmtData(oc.data)}</span>
                            {' · '}
                            <span className="truncate">{oc.baseDescricao}</span>
                            {' · '}{oc.quantidade}un
                            {oc.pv && <> · PV <span className="font-tabular">{oc.pv}</span></>}
                            <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">{empresaLabel(oc.account)}</Badge>
                            {/* A cor do CATÁLOGO que o 1 toque vai adicionar — a vendedora vê antes de tocar. */}
                            {pronto && (
                              <span className="block text-[10px] text-foreground">
                                → <span className="font-mono">{pronto.corId}</span> {pronto.nomeCor}
                              </span>
                            )}
                          </div>
                          {pronto ? (
                            <div className="flex items-center gap-1 shrink-0">
                              {/* 1 toque: preço do MOTOR já calculado (regra do maior, sem desconto).
                                  "Ajustar" abre o diálogo completo (fonte, desconto, outra embalagem). */}
                              <Button
                                size="sm"
                                className="h-6 text-[11px] px-2"
                                title={`${pronto.corId} – ${pronto.nomeCor}`}
                                aria-label={`Adicionar ${pronto.corId} por ${fmt(pronto.preco)}`}
                                onClick={() => onAdicionarUmToque!(chave, oc)}
                              >
                                <Plus className="w-3 h-3 mr-0.5" /> {fmt(pronto.preco)}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[11px] px-1.5"
                                onClick={() => onRepetirCor(cor, oc)}
                              >
                                Ajustar
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-col items-end gap-0.5 shrink-0">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[11px] px-2"
                                onClick={() => onRepetirCor(cor, oc)}
                              >
                                <Plus className="w-3 h-3 mr-0.5" /> Pedir de novo
                              </Button>
                              {estado === 'carregando' && (
                                <span className="text-[10px] text-muted-foreground">calculando preço…</span>
                              )}
                            </div>
                          )}
                        </div>
                        );
                      })}
                      {cor.ocorrencias.length > 4 && (
                        <p className="text-[10px] text-muted-foreground">
                          + {cor.ocorrencias.length - 4} pedidos anteriores
                        </p>
                      )}
                    </div>
                  </div>
                ))}
                {coresFiltradas.length === 0 && (
                  <p className="text-xs text-muted-foreground py-2">
                    Nenhuma cor do histórico casa com “{busca}”.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
