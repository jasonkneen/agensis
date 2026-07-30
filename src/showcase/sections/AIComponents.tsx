import { useState } from 'react';
import { toast } from 'sonner';
import {
  BotIcon,
  CheckIcon,
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  SparklesIcon,
  ThumbsUpIcon,
  AlertTriangleIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';

import { SectionShell, Example } from '@/showcase/SectionShell';
import { Button } from '@/components/ui/button';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
} from '@/components/ui/bubble';
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';

const bubbleVariantOptions = [
  'default',
  'secondary',
  'muted',
  'tinted',
  'outline',
  'ghost',
  'destructive',
] as const;

type BubbleVariant = (typeof bubbleVariantOptions)[number];

const scrollerMessages = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  role: i % 2 === 0 ? 'assistant' : 'user',
  text:
    i % 2 === 0
      ? `Here is response number ${i + 1}. I can help with that — let me walk through it.`
      : `User question ${i + 1}: can you explain this part again?`,
}));

export default function AIComponentsSection() {
  const [bubbleVariant, setBubbleVariant] = useState<BubbleVariant>('default');
  const [liked, setLiked] = useState(false);
  const [attachments, setAttachments] = useState([
    { id: 1, title: 'quarterly-report.pdf', desc: '1.2 MB' },
    { id: 2, title: 'design-mockup.png', desc: '840 KB' },
  ]);

  return (
    <SectionShell
      title="AI Components"
      description="Attachment, bubble, message and marker for AI chat UIs"
    >
      <Example label="Attachment" full>
        <div className="w-full max-w-md space-y-3">
          <Attachment state="done">
            <AttachmentMedia variant="icon">
              <FileTextIcon />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>annual-summary.pdf</AttachmentTitle>
              <AttachmentDescription>2.4 MB · PDF document</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction
                aria-label="Remove attachment"
                onClick={() => toast.success('Attachment removed')}
              >
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>

          <Attachment state="uploading" size="sm">
            <AttachmentMedia variant="icon">
              <Loader2Icon className="animate-spin" />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>uploading-video.mp4</AttachmentTitle>
              <AttachmentDescription>Uploading… 64%</AttachmentDescription>
            </AttachmentContent>
          </Attachment>

          <Attachment state="error" size="sm">
            <AttachmentMedia variant="icon">
              <AlertTriangleIcon />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>broken-file.zip</AttachmentTitle>
              <AttachmentDescription>Upload failed — retry</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction
                variant="ghost"
                aria-label="Retry upload"
                onClick={() => toast('Retrying upload…')}
              >
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        </div>
      </Example>

      <Example label="Attachment Group" full>
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attachments.</p>
        ) : (
          <AttachmentGroup className="w-full max-w-md">
            {attachments.map((file) => (
              <Attachment key={file.id} state="done" size="sm">
                <AttachmentMedia variant="icon">
                  {file.title.endsWith('.png') ? <ImageIcon /> : <FileTextIcon />}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.title}</AttachmentTitle>
                  <AttachmentDescription>{file.desc}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`Remove ${file.title}`}
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((f) => f.id !== file.id),
                      )
                    }
                  >
                    <XIcon />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </AttachmentGroup>
        )}
      </Example>

      <Example label="Bubble Variants" full>
        <div className="w-full space-y-3">
          <div className="flex flex-wrap gap-2">
            {bubbleVariantOptions.map((variant) => (
              <Button
                key={variant}
                size="sm"
                variant={bubbleVariant === variant ? 'default' : 'outline'}
                onClick={() => setBubbleVariant(variant)}
              >
                {variant}
              </Button>
            ))}
          </div>
          <BubbleGroup>
            <Bubble variant="muted" align="start">
              <BubbleContent>What can you do with bubbles?</BubbleContent>
            </Bubble>
            <Bubble variant={bubbleVariant} align="end">
              <BubbleContent>
                This bubble uses the “{bubbleVariant}” variant. Pick another
                button to swap styles live.
              </BubbleContent>
            </Bubble>
          </BubbleGroup>
        </div>
      </Example>

      <Example label="Bubble with Reactions">
        <BubbleGroup className="w-full max-w-sm">
          <Bubble variant="tinted" align="start" className="mb-3">
            <BubbleContent>
              I summarized the document and flagged two action items.
            </BubbleContent>
            <BubbleReactions side="bottom" align="start">
              <button
                type="button"
                aria-pressed={liked}
                onClick={() => setLiked((v) => !v)}
                className="flex items-center gap-1 px-1"
              >
                <ThumbsUpIcon
                  className={liked ? 'size-3.5 fill-current' : 'size-3.5'}
                />
                <span className="text-xs">{liked ? 2 : 1}</span>
              </button>
            </BubbleReactions>
          </Bubble>
        </BubbleGroup>
      </Example>

      <Example label="Message" full>
        <MessageGroup className="w-full max-w-lg">
          <Message align="start">
            <MessageAvatar className="size-8">
              <BotIcon className="size-4" />
            </MessageAvatar>
            <MessageContent>
              <MessageHeader>Assistant</MessageHeader>
              <Bubble variant="muted" align="start">
                <BubbleContent>
                  Hi! Ask me anything about your project and I’ll do my best to
                  help.
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>

          <Message align="end">
            <MessageAvatar className="size-8">
              <UserIcon className="size-4" />
            </MessageAvatar>
            <MessageContent>
              <Bubble variant="default" align="end">
                <BubbleContent>How do I deploy to production?</BubbleContent>
              </Bubble>
              <MessageFooter>Delivered · 9:41 AM</MessageFooter>
            </MessageContent>
          </Message>
        </MessageGroup>
      </Example>

      <Example label="Message Scroller" full>
        <MessageScrollerProvider>
          <MessageScroller className="h-72 w-full rounded-lg border border-border">
            <MessageScrollerViewport>
              <MessageScrollerContent className="p-4">
                {scrollerMessages.map((msg) => (
                  <MessageScrollerItem key={msg.id}>
                    <Message align={msg.role === 'user' ? 'end' : 'start'}>
                      <MessageAvatar className="size-8">
                        {msg.role === 'user' ? (
                          <UserIcon className="size-4" />
                        ) : (
                          <BotIcon className="size-4" />
                        )}
                      </MessageAvatar>
                      <MessageContent>
                        <Bubble
                          variant={msg.role === 'user' ? 'default' : 'muted'}
                          align={msg.role === 'user' ? 'end' : 'start'}
                        >
                          <BubbleContent>{msg.text}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="end" />
          </MessageScroller>
        </MessageScrollerProvider>
      </Example>

      <Example label="Marker" full>
        <div className="w-full max-w-md space-y-3">
          <Marker variant="separator">
            <MarkerContent>Today</MarkerContent>
          </Marker>

          <Marker variant="default">
            <MarkerIcon>
              <SparklesIcon />
            </MarkerIcon>
            <MarkerContent>Assistant generated 3 suggestions</MarkerContent>
          </Marker>

          <Marker variant="border">
            <MarkerIcon>
              <CheckIcon />
            </MarkerIcon>
            <MarkerContent>All changes saved</MarkerContent>
          </Marker>
        </div>
      </Example>
    </SectionShell>
  );
}
