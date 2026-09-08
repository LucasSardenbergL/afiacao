// Card de bundles de um cliente (perfil, comparação bundle×individual, lista de bundles).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Layers, TrendingUp, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TIPOS_INDIVIDUAIS, type BundleRecommendation, type CustomerBundles } from '@/hooks/useBundleEngine';
import type { CelulaIndividual, SituacaoIndividual } from '@/lib/farmer/melhor-individual';
import { classifyCustomerProfile, profileLabels, type CustomerProfile, type BundleArgument } from '@/hooks/useBundleArguments';
import type { useDiagnosticQuestions } from '@/hooks/useDiagnosticQuestions';
import type { CustomerCtx } from './types';
import { BundleCardFull } from './BundleCardFull';

/**
 * O que cada rota individual se chama na tela — e por que são DUAS.
 *
 * A célula única comparava `affinity_score` de dois motores cujas escalas não são
 * comensuráveis, e o resultado era uma precedência de tipo que ninguém decidiu (up_sell venceu
 * 186 de 186 pares em prod). Rotular as duas devolve a escolha a quem conhece o cliente.
 */
const ROTULOS: Record<(typeof TIPOS_INDIVIDUAIS)[number], { titulo: string; Icone: LucideIcon }> = {
  cross_sell: { titulo: 'Melhor complementar', Icone: Zap },
  up_sell: { titulo: 'Melhor upgrade', Icone: TrendingUp },
};

/**
 * O QUALIFICADOR é quem afirma prioridade — não a lista de nomes.
 *
 * Foi o argumento que decidiu mostrar nomes em todo estado: listar dois produtos não diz que um
 * vence o outro; quem diria isso é o rótulo, e o rótulo aqui declara exatamente o que se sabe.
 * `eleito` não tem qualificador porque só ali houve eleição de verdade.
 *
 * `alerta` marca os dois estados em que a ordem NÃO é confiável — o aviso vai no qualificador e
 * não nos nomes, que continuam acionáveis: o vendedor pode ofertar qualquer um dos dois.
 */
const QUALIFICADOR: Record<SituacaoIndividual, { texto: string; alerta: boolean } | null> = {
  eleito: null,
  empatado: { texto: 'Igualmente indicados', alerta: false },
  unico_registrado: { texto: 'Única registrada', alerta: false },
  ordem_indisponivel: { texto: 'Ordenação indisponível', alerta: true },
  referencia_ambigua: { texto: 'Sem ordem confiável', alerta: true },
};

const CelulaDeRota = ({ titulo, Icone, celula }: { titulo: string; Icone: LucideIcon; celula: CelulaIndividual }) => {
  const indisponivel = celula.status === 'indisponivel';
  return (
    <div className="rounded p-1.5 text-center bg-muted">
      <Icone className={`w-3 h-3 mx-auto mb-0.5 ${indisponivel ? 'text-status-warning' : 'text-status-info'}`} />
      <p className="text-[9px] text-muted-foreground">{titulo}</p>
      {/* TRÊS ausências distintas, e o traço só serve a UMA. O `?? '—'` de antes dava o mesmo
          sinal para "li e não há" e para "não consegui ler" — e, junto com o filtro que omitia
          o cliente sem bundle, transformava a falha de leitura na afirmação "não há rota
          individual para este cliente" (money-path §2 na forma de rótulo). */}
      {celula.status === 'indisponivel' ? (
        <p
          className="text-[10px] font-bold text-status-warning leading-tight"
          title={
            celula.motivo === 'leitura_falhou'
              ? "A leitura das recomendações individuais falhou nesta execução. Não é 'não existe' — é 'não sei'. Recalcule para tentar de novo."
              : 'A recomendação existe, mas não foi possível identificar nenhum produto dela pelo nome — pode ser SKU fora do catálogo ativo ou cadastro sem descrição.'
          }
        >
          Indisponível
        </p>
      ) : celula.status === 'nenhum' ? (
        <p className="text-xs font-bold" title="Este cliente não tem oferta pendente desta rota.">
          —
        </p>
      ) : (
        <CelulaEncontrada celula={celula} />
      )}
    </div>
  );
};

const CelulaEncontrada = ({ celula }: { celula: Extract<CelulaIndividual, { status: 'encontrado' }> }) => {
  const qualificador = QUALIFICADOR[celula.situacao];
  const semNome = celula.produtos - celula.nomes.length;
  return (
    <>
      {qualificador && (
        <p className={`text-[8px] leading-tight ${qualificador.alerta ? 'text-status-warning' : 'text-muted-foreground'}`}>
          {qualificador.texto}
        </p>
      )}
      <p className="text-xs font-bold leading-tight break-words">{celula.nomes.join(' · ')}</p>
      {/* Declarar o que sumiu é o que impede a falha de catálogo de virar eleição: num
          `empatado` que perdeu um nome, esconder o ausente promoveria o sobrevivente a
          vencedor — a fabricação exata que esta tela existe para não cometer. */}
      {semNome > 0 && (
        <p
          className="text-[8px] text-status-warning leading-tight"
          title="Estes SKUs foram recomendados e não foi possível identificá-los pelo nome — SKU fora do catálogo ativo, ou cadastro sem descrição."
        >
          {semNome} de {celula.produtos} sem nome
        </p>
      )}
      {/* Só em `empatado`: nos estados que nomeiam o grupo inteiro `produtos = candidatos` por
          invariante, e em `eleito` os demais candidatos PERDERAM — não estão escondidos. */}
      {celula.situacao === 'empatado' && celula.candidatos > celula.produtos && (
        <p className="text-[8px] text-muted-foreground leading-tight">
          empate entre {celula.produtos} de {celula.candidatos}
        </p>
      )}
    </>
  );
};

interface CustomerBundleCardProps {
  data: CustomerBundles;
  expanded: boolean;
  onToggle: () => void;
  bundleArgs: Record<string, BundleArgument>;
  argGenerating: Record<string, boolean>;
  onGenerateArgument: (key: string, bundle: BundleRecommendation, customer: CustomerCtx, profile: CustomerProfile) => void;
  diagHook: ReturnType<typeof useDiagnosticQuestions>;
}

export const CustomerBundleCard = ({ data, expanded, onToggle, bundleArgs, argGenerating, onGenerateArgument, diagHook }: CustomerBundleCardProps) => {
  // A probabilidade do MELHOR bundle (`pBundle`, em %) substitui o antigo "LIE em R$": sem custo
  // no browser não existe lucro esperado, e somar scores premiava quem tem mais bundles.
  //
  // ⚠️ `?? null`, não `?? 0`. O `?? 0` fazia "não há bundle" virar "0,0% de conversão" — em
  // verde de sucesso —, que é `Number(null) === 0` na forma de rótulo. Era raro porque o
  // cliente sem bundle costumava ser OMITIDO da lista; deixou de ser: com a comparação
  // individual `indisponivel` esses clientes passam a entrar de propósito, e na maior carteira
  // isso são milhares de cartões anunciando uma taxa de conversão que ninguém calculou.
  // (Achado 4 do challenge Codex — consequência direta de consertar a omissão.)
  const melhorProbabilidade = data.bundles[0]?.pBundle ?? null;
  // Quantas das DUAS rotas ninguém consegue afirmar. Vale como aviso no cartão RECOLHIDO: sem
  // ele, o cliente que só entrou na lista por causa da falha se apresenta como um cartão comum,
  // e o operador teria de expandir um a um para descobrir que não sabemos nada dele.
  const rotasIndisponiveis = TIPOS_INDIVIDUAIS.filter(
    (tipo) => data.individuais[tipo].status === 'indisponivel',
  ).length;

  // grossMarginPct passa SEM `|| 0`: o guard dentro de classifyCustomerProfile só funciona se o
  // null chegar até lá. Coagir aqui tornaria a correção inerte (a armadilha do #1508).
  const profile = classifyCustomerProfile(data.healthScore, data.avgMonthlySpend || 0, data.grossMarginPct, data.categoryCount || 0);
  const profileInfo = profileLabels[profile];

  const customerCtx = {
    name: data.customerName,
    healthScore: data.healthScore,
    avgMonthlySpend: data.avgMonthlySpend,
    categoryCount: data.categoryCount,
    daysSinceLastPurchase: data.daysSinceLastPurchase,
    cnae: data.cnae,
    customerType: data.customerType,
    recentProducts: data.recentProducts,
  };

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between cursor-pointer" onClick={onToggle}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold truncate">{data.customerName}</span>
              <Badge variant="outline" className="text-[8px] shrink-0">HS {data.healthScore}</Badge>
              <span className="text-[9px] shrink-0" title={profileInfo.label}>{profileInfo.emoji}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">{data.bundles.length} bundles</span>
              {melhorProbabilidade == null ? (
                <span className="text-[10px] text-muted-foreground">sem bundle</span>
              ) : (
                <span className="text-[10px] font-semibold text-status-success">{melhorProbabilidade.toFixed(1)}% de conversão</span>
              )}
              {/* O estado indisponível precisa aparecer COLAPSADO: sem isto, o cliente que só
                  entrou na lista por causa da falha se apresenta como um cartão comum, e o
                  operador teria de expandir um a um para descobrir que não sabemos nada dele. */}
              {rotasIndisponiveis > 0 && (
                <span className="text-[10px] font-semibold text-status-warning">
                  {rotasIndisponiveis === TIPOS_INDIVIDUAIS.length
                    ? 'comparação indisponível'
                    : `${rotasIndisponiveis} rota indisponível`}
                </span>
              )}
              <Badge variant="outline" className={`text-[7px] ${profileInfo.color}`}>{profileInfo.label}</Badge>
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
        </div>

        {expanded && (
          <div className="mt-3 space-y-3">
            {/* TRÊS rotas de oferta — SEM declarar vencedor entre nenhuma delas.
                O card antes coroava 🏆 quem tivesse o maior LIE em R$. Isso não sobrevive a duas
                coisas: (1) sem custo no browser não há lucro esperado para comparar; (2) mesmo os
                scores de afinidade não são comensuráveis entre si — `pBundle` multiplica por
                `lift/2` e não é limitado a 1, enquanto o score individual é uma probabilidade.
                Eleger vencedor entre as duas escalas era um número inventado.

                A terceira célula nasceu do MESMO defeito um nível abaixo: complementar e upgrade
                dividiam uma célula e disputavam por `affinity_score`, escalas igualmente
                incomensuráveis. Separá-las não é enfeite de layout — é parar de responder por
                artefato de escala uma pergunta que ninguém fez. */}
            <div className="bg-muted/50 rounded-lg p-2">
              <p className="text-[9px] font-semibold mb-1">📊 Rotas de oferta</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="rounded p-1.5 text-center bg-muted">
                  <Layers className="w-3 h-3 mx-auto mb-0.5 text-status-success" />
                  <p className="text-[9px] text-muted-foreground">Melhor bundle</p>
                  <p className="text-xs font-bold">
                    {melhorProbabilidade == null ? 'Sem bundle' : `${melhorProbabilidade.toFixed(1)}%`}
                  </p>
                </div>
                {TIPOS_INDIVIDUAIS.map((tipo) => (
                  <CelulaDeRota
                    key={tipo}
                    titulo={ROTULOS[tipo].titulo}
                    Icone={ROTULOS[tipo].Icone}
                    celula={data.individuais[tipo]}
                  />
                ))}
              </div>
            </div>

            {/* Bundles */}
            {data.bundles.map((bundle, i) => {
              const bundleKey = `${data.customerId}_${i}`;
              return (
                <BundleCardFull
                  key={i}
                  bundle={bundle}
                  rank={i + 1}
                  bundleKey={bundleKey}
                  customerId={data.customerId}
                  customerCtx={customerCtx}
                  profile={profile}
                  argument={bundleArgs[bundleKey]}
                  isArgGenerating={argGenerating[bundleKey] || false}
                  onGenerateArg={() => onGenerateArgument(bundleKey, bundle, customerCtx, profile)}
                  questions={diagHook.questions[bundleKey] || []}
                  isQuestionsGenerating={diagHook.generating[bundleKey] || false}
                  onGenerateQuestions={() => diagHook.generateQuestions(bundleKey, bundle, customerCtx, profile)}
                  onSetResponse={(idx, resp, notes) => diagHook.setResponse(bundleKey, idx, resp, notes)}
                  onToggleAlt={(idx) => diagHook.toggleAlt(bundleKey, idx)}
                  onSaveQuestions={(offered, result, margin, time) =>
                    diagHook.saveQuestionsToDb(bundleKey, bundle.id, data.customerId, profile, offered, result, margin, time)
                  }
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
