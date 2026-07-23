// Hook de estado/dados da página de Bundles do Farmer.
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split):
// composição dos 3 engines (bundles/argumentos/perguntas) + totais + expansão.
import { useState } from 'react';
import { useBundleEngine } from '@/hooks/useBundleEngine';
import { useBundleArguments } from '@/hooks/useBundleArguments';
import { useDiagnosticQuestions } from '@/hooks/useDiagnosticQuestions';

export function useFarmerBundles() {
  const { customerBundles, rules, loading, calculating, calculateBundles } = useBundleEngine();
  const { arguments: bundleArgs, generating: argGenerating, generateArgument } = useBundleArguments();
  const diagHook = useDiagnosticQuestions();
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // `totalLIE` saiu: era a soma dos LIE em R$ dos bundles, e sem custo no browser não existe
  // lucro esperado para somar. A contagem (`totalBundles`) segue sendo o total honesto.
  const totalBundles = customerBundles.reduce((s, c) => s + c.bundles.length, 0);

  const toggleCustomer = (customerId: string) =>
    setExpandedCustomer(expandedCustomer === customerId ? null : customerId);

  return {
    customerBundles,
    rules,
    loading,
    calculating,
    calculateBundles,
    bundleArgs,
    argGenerating,
    generateArgument,
    diagHook,
    expandedCustomer,
    toggleCustomer,
    totalBundles,
  };
}
