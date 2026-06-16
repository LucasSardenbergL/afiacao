import { PriorityCard } from './PriorityCard';
import { DeltasStrip } from './DeltasStrip';
import type { PriorityCandidate } from '@/lib/dashboard/priority-rules';

export function BriefZone({ winner }: { winner: PriorityCandidate | null }) {
  return (
    <section className="bg-cockpit-hero noise relative overflow-hidden border-b border-border">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-8 lg:py-10 space-y-5 relative">
        <PriorityCard winner={winner} />

        <DeltasStrip />
      </div>
    </section>
  );
}
