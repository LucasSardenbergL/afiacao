import { Badge } from '@/components/ui/badge';
import { STANDARD_PROCESS_STATUS_LABEL, type StandardProcessStatus } from '@/lib/standard-process/types';

const COLOR: Record<StandardProcessStatus, string> = {
  draft: 'border-muted-foreground/30 text-muted-foreground',
  in_review: 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300',
  published: 'border-status-success text-status-success',
  archived: 'border-status-error text-status-error',
};

export function StandardProcessStatusBadge({ status }: { status: StandardProcessStatus }) {
  return <Badge variant="outline" className={`text-2xs ${COLOR[status]}`}>{STANDARD_PROCESS_STATUS_LABEL[status]}</Badge>;
}
