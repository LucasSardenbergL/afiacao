// Fidelidade (loyalty) — pontos, tiers, ajustes e visão econômica.
// Composição: useAdminLoyalty (dados/estado) + stats + insights + lista/detalhe + dialog.
// God-component split de src/pages/AdminLoyalty.tsx (comportamento 1:1).
import { Loader2 } from 'lucide-react';
import { useAdminLoyalty } from '@/components/loyalty/useAdminLoyalty';
import { AdjustDialog } from '@/components/loyalty/AdjustDialog';
import { CustomerDetail } from '@/components/loyalty/CustomerDetail';
import { LoyaltyStats } from '@/components/loyalty/LoyaltyStats';
import { EconomicInsights } from '@/components/loyalty/EconomicInsights';
import { CustomerList } from '@/components/loyalty/CustomerList';

export default function AdminLoyalty() {
  const {
    authLoading,
    loading,
    search,
    setSearch,
    selectedCustomer,
    setSelectedCustomer,
    customerHistory,
    viewCustomerHistory,
    openAdjust,
    totalPointsCirculating,
    totalEarned,
    totalRedeemed,
    estimatedLiability,
    redemptionRate,
    topRewards,
    topBalanceUsers,
    filtered,
    adjustOpen,
    setAdjustOpen,
    adjustType,
    adjustPoints,
    setAdjustPoints,
    adjustDescription,
    setAdjustDescription,
    adjusting,
    handleAdjustPoints,
  } = useAdminLoyalty();

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  // Detail view
  if (selectedCustomer) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <CustomerDetail
          customer={selectedCustomer}
          history={customerHistory}
          onAddPoints={() => openAdjust(selectedCustomer.user_id, 'earn')}
          onRedeem={() => openAdjust(selectedCustomer.user_id, 'redeem')}
          onBack={() => setSelectedCustomer(null)}
        />

        {/* Adjust Dialog */}
        <AdjustDialog
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
          type={adjustType}
          points={adjustPoints}
          setPoints={setAdjustPoints}
          description={adjustDescription}
          setDescription={setAdjustDescription}
          onSubmit={handleAdjustPoints}
          loading={adjusting}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Stats */}
        <LoyaltyStats
          totalPointsCirculating={totalPointsCirculating}
          totalEarned={totalEarned}
          totalRedeemed={totalRedeemed}
        />

        {/* Economic insights */}
        <EconomicInsights
          estimatedLiability={estimatedLiability}
          redemptionRate={redemptionRate}
          topRewards={topRewards}
          topBalanceUsers={topBalanceUsers}
        />

        <CustomerList
          search={search}
          onSearchChange={setSearch}
          filtered={filtered}
          onView={viewCustomerHistory}
          onQuickEarn={(userId) => openAdjust(userId, 'earn')}
          onQuickRedeem={(userId) => openAdjust(userId, 'redeem')}
        />
      </main>


      {/* Adjust Dialog */}
      <AdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        type={adjustType}
        points={adjustPoints}
        setPoints={setAdjustPoints}
        description={adjustDescription}
        setDescription={setAdjustDescription}
        onSubmit={handleAdjustPoints}
        loading={adjusting}
      />
    </div>
  );
}
