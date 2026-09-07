import { useCompletude } from '@/hooks/useCompletude';
import { rotularCampo } from '@/lib/knowledge-base/campo-labels';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';

/**
 * Aba "Dados faltantes" (Fase B1): produtos aprovados com campos importantes vazios,
 * do mais incompleto pro menos. Read-only — clica e vai pro detalhe do boletim.
 *
 * O ✓ VERDE SÓ PODE APARECER EM `pronta`. `useCompletude` faz `if (error) throw error`,
 * então na falha `data` é `undefined` — a mesma condição do vazio. O `!data ||
 * data.length === 0` que estava aqui colapsava as duas à mão, com `||`, e a tela
 * respondia à queda de leitura com ícone de sucesso e uma frase universal ("Todas as
 * fichas… estão completas"). Medido em prod (2026-09-06): 119 fichas aprovadas, 116 com
 * campo faltando — o estado NORMAL desta tela são 116 pendências de trabalho, e a falha
 * as substituía por um check verde para as 3 pessoas que enxergam esta aba
 * (docs/historico/o-check-verde-que-a-falha-acende.md, achado 1).
 *
 * A desestruturação liga `status` de PROPÓSITO: é chave de `CHAVES_DE_ERRO`, então o
 * detector de `src/lib/gates/erro-colapsado-em-vazio.ts` enxerga o tratamento e SEGUE
 * vigiando o arquivo. Trocar por `const q = useCompletude()` sumiria com o sítio do gate
 * por CEGUEIRA — e o gate não distingue isso de conserto.
 */
export function CompletudeSection() {
  const { data, status, fetchStatus } = useCompletude();
  const estado = estadoDeLeitura({ status, fetchStatus });

  // ANTES do loading, e não depois: sem rede a query fica `pending` + `paused`, com
  // `isLoading` FALSE, `data` `undefined` e `error` `null`. O 4º estado passa reto por
  // um guard de `isLoading`/`error` e cai no ramo do "está tudo completo".
  if (naoConsegui(estado)) {
    return (
      <AvisoLeituraFalhou
        oque="a lista de fichas com dados importantes faltando"
        estado={estado}
        variante="bloco"
      />
    );
  }

  if (estado !== 'pronta') {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Só alcançável com a leitura FEITA — aqui o vazio é mesmo "não há pendência", e o ✓
  // verde é verdade. (`!data` sobrevive porque o tipo de `UseQueryResult` admite
  // `undefined`; em `success` a `queryFn` sempre devolveu um array.)
  if (!data || data.length === 0) {
    return (
      <Card className="p-8 text-center text-xs text-muted-foreground">
        <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-status-success opacity-70" />
        Todas as fichas aprovadas estão completas nos dados importantes.
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-2xs text-muted-foreground">
        {data.length} produto{data.length > 1 ? 's' : ''} com dados importantes faltando — sua lista pra pedir à fábrica.
      </p>

      {data.map((p) => {
        const inner = (
          <Card className="p-3 hover:bg-muted/40 transition-colors">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{p.product_name}</div>
                <div className="text-2xs text-muted-foreground font-mono">{p.product_code}</div>
              </div>
              <Badge variant="outline" className="text-2xs shrink-0">{p.faltantes.length} faltando</Badge>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {p.faltantes.map((c) => (
                <Badge key={c} variant="secondary" className="text-2xs font-normal">
                  {rotularCampo(c)}
                </Badge>
              ))}
            </div>
          </Card>
        );

        return p.document_id ? (
          <Link key={p.product_code} to={`/admin/knowledge-base/${p.document_id}`} className="block">
            {inner}
          </Link>
        ) : (
          <div key={p.product_code}>{inner}</div>
        );
      })}
    </div>
  );
}
