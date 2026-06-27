import { useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2Icon,
  TriangleAlertIcon,
  RocketIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import { Alert, AlertTitle, AlertDescription, AlertAction } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';

export default function FeedbackSection() {
  const [progress, setProgress] = useState(40);

  return (
    <SectionShell title="Feedback" description="Alerts, progress, toasts and spinners">
      <Example label="Alert" full>
        <div className="flex w-full flex-col gap-3">
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>Changes saved</AlertTitle>
            <AlertDescription>Your workspace settings were updated successfully.</AlertDescription>
          </Alert>

          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Unable to sync</AlertTitle>
            <AlertDescription>Check your connection and try again.</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="xs">
                Retry
              </Button>
            </AlertAction>
          </Alert>

          <Alert>
            <RocketIcon />
            <AlertTitle>New feature available</AlertTitle>
            <AlertDescription>
              You can now invite teammates directly from the dashboard.
            </AlertDescription>
          </Alert>
        </div>
      </Example>

      <Example label="Progress" full>
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Uploading assets</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setProgress((p) => Math.max(0, p - 10))}
            >
              -10%
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setProgress((p) => Math.min(100, p + 10))}
            >
              +10%
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setProgress(0)}>
              Reset
            </Button>
          </div>
        </div>
      </Example>

      <Example label="Sonner (Toasts)" full>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" onClick={() => toast('Event has been created')}>
            Default
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.success('Profile updated successfully')}
          >
            Success
          </Button>
          <Button
            variant="destructive"
            onClick={() => toast.error('Something went wrong')}
          >
            Error
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast('Item deleted', {
                description: 'The task was removed from your list.',
                action: { label: 'Undo', onClick: () => toast('Restored') },
              })
            }
          >
            With action
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              toast.promise(new Promise((resolve) => setTimeout(resolve, 1500)), {
                loading: 'Saving…',
                success: 'Saved!',
                error: 'Failed to save',
              })
            }
          >
            Promise
          </Button>
        </div>
      </Example>

      <Example label="Spinner">
        <div className="flex items-center gap-4">
          <Spinner className="size-4" />
          <Spinner className="size-6" />
          <Spinner className="size-8 text-primary" />
        </div>
      </Example>

      <Example label="Spinner in button">
        <Button disabled>
          <RefreshCwIcon className="animate-spin" />
          Refreshing
        </Button>
      </Example>
    </SectionShell>
  );
}
