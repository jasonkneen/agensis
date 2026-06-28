import { AlertCircle, Check, RefreshCw, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NetworkStatusBarProps {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  syncError: string | null;
  onSync: () => void;
  onClearQueue: () => void;
}

export function NetworkStatusBar({ online, syncing, pendingCount, syncError, onSync, onClearQueue }: NetworkStatusBarProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  if (online && pendingCount === 0 && !syncError) return null;

  const isError = !online || Boolean(syncError);
  const isWarning = online && !syncError && (syncing || pendingCount > 0);

  return (
    <>
      <Alert
        variant={isError ? 'destructive' : 'default'}
        className={cn(
          'flex items-center gap-2 rounded-none border-x-0 border-t-0 px-4 py-1.5 text-xs',
          isWarning && 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
          online && !syncError && pendingCount === 0 && 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400',
        )}
      >
      {!online ? (
        <WifiOff data-icon="inline-start" className="size-3.5" />
      ) : syncError ? (
        <AlertCircle data-icon="inline-start" className="size-3.5" />
      ) : syncing ? (
        <RefreshCw data-icon="inline-start" className="size-3.5 animate-spin" />
      ) : pendingCount > 0 ? (
        <RefreshCw data-icon="inline-start" className="size-3.5" />
      ) : (
        <Check data-icon="inline-start" className="size-3.5" />
      )}

      <AlertDescription className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-current">
        {!online ? (
          <span>Offline - changes will sync when you reconnect</span>
        ) : syncError ? (
          <>
            <span>
              {syncError}
              {pendingCount > 0 ? ` (${pendingCount} queued)` : ''}
            </span>
            <Button type="button" variant="outline" size="xs" onClick={onSync}>
              Retry sync
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={() => setConfirmClear(true)}
            >
              Clear queue
            </Button>
          </>
        ) : syncing ? (
          <span>
            Syncing {pendingCount} pending change{pendingCount !== 1 ? 's' : ''}...
          </span>
        ) : pendingCount > 0 ? (
          <>
            <span>
              {pendingCount} change{pendingCount !== 1 ? 's' : ''} pending
            </span>
            <Button type="button" variant="outline" size="xs" onClick={onSync}>
              Sync now
            </Button>
          </>
        ) : (
          <span>All changes synced</span>
        )}
        </AlertDescription>
      </Alert>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the offline sync queue?</AlertDialogTitle>
            <AlertDialogDescription>Unsynced local changes will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmClear(false);
                onClearQueue();
              }}
            >
              Clear queue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
