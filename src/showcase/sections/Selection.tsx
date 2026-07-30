import { useState } from 'react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Calculator,
  Calendar as CalendarIcon,
  CreditCard,
  Settings,
  Smile,
  User,
} from 'lucide-react';

const TIMEZONES = [
  { value: 'utc', label: 'UTC' },
  { value: 'est', label: 'Eastern (EST)' },
  { value: 'pst', label: 'Pacific (PST)' },
  { value: 'cet', label: 'Central Europe (CET)' },
];

const FRUITS = [
  'Apple',
  'Banana',
  'Blueberry',
  'Grapes',
  'Mango',
  'Orange',
  'Pineapple',
  'Strawberry',
];

export default function SelectionSection() {
  const [fruit, setFruit] = useState<string | null>('Mango');
  const [zone, setZone] = useState('utc');

  return (
    <SectionShell title="Selection" description="Selects, comboboxes and command palette">
      <Example label="Select">
        <Select value={zone} onValueChange={setZone}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Pick a timezone" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Timezones</SelectLabel>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectItem value="auto">Auto-detect</SelectItem>
          </SelectContent>
        </Select>
      </Example>

      <Example label="Select (small)">
        <Select defaultValue="medium">
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="small">Small</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="large">Large</SelectItem>
          </SelectContent>
        </Select>
      </Example>

      <Example label="Native Select">
        <NativeSelect defaultValue="react" className="w-44">
          <NativeSelectOptGroup label="Frameworks">
            <NativeSelectOption value="react">React</NativeSelectOption>
            <NativeSelectOption value="vue">Vue</NativeSelectOption>
            <NativeSelectOption value="svelte">Svelte</NativeSelectOption>
          </NativeSelectOptGroup>
          <NativeSelectOptGroup label="Meta">
            <NativeSelectOption value="next">Next.js</NativeSelectOption>
            <NativeSelectOption value="nuxt">Nuxt</NativeSelectOption>
          </NativeSelectOptGroup>
        </NativeSelect>
      </Example>

      <Example label="Combobox">
        <Combobox
          items={FRUITS}
          value={fruit}
          onValueChange={(value) => setFruit(value)}
        >
          <ComboboxInput placeholder="Search fruit..." className="w-56" />
          <ComboboxContent>
            <ComboboxEmpty>No fruit found.</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Example>

      <Example label="Command" full>
        <div className="w-full max-w-md overflow-hidden rounded-lg border border-border">
          <Command>
            <CommandInput placeholder="Type a command or search..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Suggestions">
                <CommandItem>
                  <CalendarIcon />
                  <span>Calendar</span>
                </CommandItem>
                <CommandItem>
                  <Smile />
                  <span>Search Emoji</span>
                </CommandItem>
                <CommandItem>
                  <Calculator />
                  <span>Calculator</span>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Settings">
                <CommandItem>
                  <User />
                  <span>Profile</span>
                  <CommandShortcut>⌘P</CommandShortcut>
                </CommandItem>
                <CommandItem>
                  <CreditCard />
                  <span>Billing</span>
                  <CommandShortcut>⌘B</CommandShortcut>
                </CommandItem>
                <CommandItem>
                  <Settings />
                  <span>Settings</span>
                  <CommandShortcut>⌘S</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Example>
    </SectionShell>
  );
}
