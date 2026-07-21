// Card de bundles de um cliente (perfil, comparação bundle×individual, lista de bundles).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Layers, Zap } from 'lucide-react';
import type { BundleRecommendation, CustomerBundles } from '@/hooks/useBundleEngine';
import { classifyCustomerProfile, profileLabels, type CustomerProfile, type BundleArgument } from '@/hooks/useBundleArguments';
import type { useDiagnosticQuestions } from '@/hooks/useDiagnosticQuestions';
import { fmt } from './format';
import type { CustomerCtx } from './types';
import { BundleCardFull } from './BundleCardFull';

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
  const totalBundleLIE = data.bundles.reduce((s, b) => s + b.lieBundle, 0);
  const bestBundleLIE = data.bundles[0]?.lieBundle || 0;
  const individualLIE = data.bestIndividual?.lie || 0;
  const bundleWins = bestBundleLIE > individualLIE;

  // `grossMarginPct` sem `|| 0`: margem desconhecida tem de chegar como null no classify,
  // senão o cliente sem custo cadastrado vira 'sensivel_preco' por coerção.
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
              <span className="text-[10px] font-semibold text-status-success">LIE {fmt(totalBundleLIE)}</span>
              <Badge variant="outline" className={`text-[7px] ${profileInfo.color}`}>{profileInfo.label}</Badge>
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
        </div>

        {expanded && (
          <div className="mt-3 space-y-3">
            {/* Comparison */}
            <div className="bg-muted/50 rounded-lg p-2">
              <p className="text-[9px] font-semibold mb-1">📊 Comparação Inteligente</p>
              <div className="grid grid-cols-2 gap-2">
                <div className={`rounded p-1.5 text-center ${bundleWins ? 'bg-status-success-bg ring-1 ring-emerald-300' : 'bg-muted'}`}>
                  <Layers className="w-3 h-3 mx-auto mb-0.5 text-status-success" />
                  <p className="text-[9px] text-muted-foreground">Melhor Bundle</p>
                  <p className="text-xs font-bold">{fmt(bestBundleLIE)}</p>
                  {bundleWins && <Badge className="text-[7px] bg-status-success mt-0.5">🏆 Vencedor</Badge>}
                </div>
                <div className={`rounded p-1.5 text-center ${!bundleWins ? 'bg-status-info-bg ring-1 ring-blue-300' : 'bg-muted'}`}>
                  <Zap className="w-3 h-3 mx-auto mb-0.5 text-status-info" />
                  <p className="text-[9px] text-muted-foreground">Melhor Individual</p>
                  <p className="text-xs font-bold">{fmt(individualLIE)}</p>
                  {!bundleWins && data.bestIndividual && <Badge className="text-[7px] bg-status-info mt-0.5">🏆 Vencedor</Badge>}
                </div>
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
