import { useState } from 'react';
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Copy,
  Check,
  Plus,
} from 'lucide-react';

import { SectionShell, Example } from '@/showcase/SectionShell';
import { Button } from '@/components/ui/button';
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from '@/components/ui/button-group';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';

export default function ActionsSection() {
  const [bold, setBold] = useState(false);
  const [align, setAlign] = useState('left');
  const [formats, setFormats] = useState<string[]>(['bold']);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleCopy() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function handleLoad() {
    setLoading(true);
    window.setTimeout(() => setLoading(false), 2000);
  }

  return (
    <SectionShell title="Actions" description="Buttons, toggles, badges and status">
      <Example label="Button">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
      </Example>

      <Example label="Button Sizes">
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Add">
          <Plus />
        </Button>
        <Button disabled>Disabled</Button>
      </Example>

      <Example label="Button Group">
        <ButtonGroup>
          <Button variant="outline">Years</Button>
          <Button variant="outline">Months</Button>
          <Button variant="outline">Days</Button>
        </ButtonGroup>
        <ButtonGroup>
          <ButtonGroupText>https://</ButtonGroupText>
          <Button variant="outline" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <ButtonGroupSeparator />
          <Button variant="outline">Open</Button>
        </ButtonGroup>
      </Example>

      <Example label="Toggle">
        <Toggle
          pressed={bold}
          onPressedChange={setBold}
          aria-label="Toggle bold"
        >
          <Bold />
        </Toggle>
        <Toggle variant="outline" aria-label="Toggle italic">
          <Italic />
          Italic
        </Toggle>
        <Toggle size="sm" aria-label="Toggle underline">
          <Underline />
        </Toggle>
      </Example>

      <Example label="Toggle Group (single)">
        <ToggleGroup
          type="single"
          value={align}
          onValueChange={(value) => value && setAlign(value)}
          variant="outline"
        >
          <ToggleGroupItem value="left" aria-label="Align left">
            <AlignLeft />
          </ToggleGroupItem>
          <ToggleGroupItem value="center" aria-label="Align center">
            <AlignCenter />
          </ToggleGroupItem>
          <ToggleGroupItem value="right" aria-label="Align right">
            <AlignRight />
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">Aligned: {align}</span>
      </Example>

      <Example label="Toggle Group (multiple)">
        <ToggleGroup
          type="multiple"
          value={formats}
          onValueChange={setFormats}
          variant="outline"
          spacing={0}
        >
          <ToggleGroupItem value="bold" aria-label="Bold">
            <Bold />
          </ToggleGroupItem>
          <ToggleGroupItem value="italic" aria-label="Italic">
            <Italic />
          </ToggleGroupItem>
          <ToggleGroupItem value="underline" aria-label="Underline">
            <Underline />
          </ToggleGroupItem>
        </ToggleGroup>
      </Example>

      <Example label="Badge">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="ghost">Ghost</Badge>
        <Badge variant="default">
          <Check />
          Verified
        </Badge>
      </Example>

      <Example label="Kbd">
        <Kbd>Esc</Kbd>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>P</Kbd>
        </KbdGroup>
      </Example>

      <Example label="Spinner">
        <Spinner />
        <Spinner className="size-6 text-primary" />
        <Button disabled={loading} onClick={handleLoad}>
          {loading && <Spinner />}
          {loading ? 'Saving…' : 'Save changes'}
        </Button>
      </Example>
    </SectionShell>
  );
}
