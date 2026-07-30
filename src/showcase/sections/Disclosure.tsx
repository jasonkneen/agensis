import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';

const faqs = [
  {
    value: 'item-1',
    question: 'What is included in the free plan?',
    answer:
      'The free plan includes up to three projects, community support, and access to all core components.',
  },
  {
    value: 'item-2',
    question: 'Can I upgrade or downgrade at any time?',
    answer:
      'Yes. Plan changes take effect immediately and we prorate the difference on your next invoice.',
  },
  {
    value: 'item-3',
    question: 'Do you offer refunds?',
    answer:
      'We offer a 30-day money-back guarantee, no questions asked, on all annual subscriptions.',
  },
];

const tags = Array.from({ length: 24 }, (_, i) => `v1.${i}.0`);

export default function DisclosureSection() {
  const [open, setOpen] = useState(false);

  return (
    <SectionShell
      title="Disclosure"
      description="Accordions, tabs, collapsibles and scroll/resizable areas"
    >
      <Example label="Accordion" full>
        <Accordion type="single" collapsible defaultValue="item-1" className="w-full max-w-md">
          {faqs.map((faq) => (
            <AccordionItem key={faq.value} value={faq.value}>
              <AccordionTrigger>{faq.question}</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">{faq.answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Example>

      <Example label="Collapsible">
        <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-xs space-y-2">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
            <span className="text-sm font-medium text-foreground">Deployment regions</span>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <ChevronsUpDown />
                <span className="sr-only">Toggle regions</span>
              </Button>
            </CollapsibleTrigger>
          </div>
          <div className="rounded-lg border border-border px-3 py-2 text-sm text-foreground">
            us-east-1 (primary)
          </div>
          <CollapsibleContent className="space-y-2">
            <div className="rounded-lg border border-border px-3 py-2 text-sm text-foreground">
              eu-west-1
            </div>
            <div className="rounded-lg border border-border px-3 py-2 text-sm text-foreground">
              ap-southeast-2
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Example>

      <Example label="Tabs">
        <Tabs defaultValue="account" className="w-full max-w-sm">
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
          </TabsList>
          <TabsContent value="account">
            <p className="text-muted-foreground">
              Manage your profile, email address and display name.
            </p>
          </TabsContent>
          <TabsContent value="password">
            <p className="text-muted-foreground">
              Update your password and enable two-factor authentication.
            </p>
          </TabsContent>
          <TabsContent value="team">
            <p className="text-muted-foreground">
              Invite teammates and configure their permissions.
            </p>
          </TabsContent>
        </Tabs>
      </Example>

      <Example label="Tabs (line variant)">
        <Tabs defaultValue="overview" className="w-full max-w-sm">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <p className="text-muted-foreground">A high level summary of recent metrics.</p>
          </TabsContent>
          <TabsContent value="activity">
            <p className="text-muted-foreground">The latest events from your workspace.</p>
          </TabsContent>
        </Tabs>
      </Example>

      <Example label="Scroll Area">
        <ScrollArea className="h-48 w-48 rounded-md border border-border">
          <div className="p-4">
            <h4 className="mb-3 text-sm font-medium text-foreground">Releases</h4>
            {tags.map((tag) => (
              <div key={tag} className="border-b border-border py-1.5 text-sm text-foreground">
                {tag}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Example>

      <Example label="Resizable">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-40 max-w-md rounded-lg border border-border"
        >
          <ResizablePanel defaultSize={40} minSize={20}>
            <div className="flex h-full items-center justify-center p-4 text-sm font-medium text-foreground">
              Sidebar
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={60} minSize={30}>
            <div className="flex h-full items-center justify-center p-4 text-sm font-medium text-foreground">
              Content
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Example>
    </SectionShell>
  );
}
