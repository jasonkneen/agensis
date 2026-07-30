import { useState } from 'react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from '@/components/ui/input-otp';
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Search, Mail, Send, Copy } from 'lucide-react';

export default function InputsSection() {
  const [bio, setBio] = useState('Building things with React.');
  const [terms, setTerms] = useState(true);
  const [newsletter, setNewsletter] = useState(false);
  const [plan, setPlan] = useState('pro');
  const [wifi, setWifi] = useState(true);
  const [notifications, setNotifications] = useState(false);
  const [volume, setVolume] = useState([60]);
  const [priceRange, setPriceRange] = useState([20, 80]);
  const [otp, setOtp] = useState('');
  const [comment, setComment] = useState('');

  return (
    <SectionShell title="Inputs" description="Text fields and form controls">
      <Example label="Input">
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Input type="text" placeholder="Default text input" />
          <Input type="email" placeholder="you@example.com" />
          <Input type="password" placeholder="Password" defaultValue="secret" />
          <Input type="text" placeholder="Disabled" disabled />
          <Input type="text" placeholder="Invalid" aria-invalid />
        </div>
      </Example>

      <Example label="Textarea">
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Textarea
            placeholder="Type your message..."
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">{bio.length} characters</span>
        </div>
      </Example>

      <Example label="Label">
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Label htmlFor="showcase-name">Full name</Label>
          <Input id="showcase-name" placeholder="Ada Lovelace" />
        </div>
      </Example>

      <Example label="Checkbox">
        <div className="flex flex-col gap-3">
          <Label className="cursor-pointer">
            <Checkbox checked={terms} onCheckedChange={(v) => setTerms(v === true)} />
            Accept terms and conditions
          </Label>
          <Label className="cursor-pointer">
            <Checkbox
              checked={newsletter}
              onCheckedChange={(v) => setNewsletter(v === true)}
            />
            Subscribe to newsletter
          </Label>
          <Label className="cursor-not-allowed">
            <Checkbox disabled />
            Disabled option
          </Label>
        </div>
      </Example>

      <Example label="Radio Group">
        <RadioGroup value={plan} onValueChange={setPlan} className="max-w-xs">
          <Label className="cursor-pointer">
            <RadioGroupItem value="free" />
            Free
          </Label>
          <Label className="cursor-pointer">
            <RadioGroupItem value="pro" />
            Pro
          </Label>
          <Label className="cursor-pointer">
            <RadioGroupItem value="enterprise" />
            Enterprise
          </Label>
        </RadioGroup>
      </Example>

      <Example label="Switch">
        <div className="flex flex-col gap-3">
          <Label className="cursor-pointer">
            <Switch checked={wifi} onCheckedChange={setWifi} />
            Wi-Fi
          </Label>
          <Label className="cursor-pointer">
            <Switch
              checked={notifications}
              onCheckedChange={setNotifications}
              size="sm"
            />
            Push notifications (small)
          </Label>
        </div>
      </Example>

      <Example label="Slider">
        <div className="flex w-full max-w-xs flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Volume: {volume[0]}</span>
            <Slider value={volume} onValueChange={setVolume} max={100} step={1} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              Price: ${priceRange[0]} – ${priceRange[1]}
            </span>
            <Slider value={priceRange} onValueChange={setPriceRange} max={100} step={5} />
          </div>
        </div>
      </Example>

      <Example label="Input OTP">
        <div className="flex flex-col gap-2">
          <InputOTP maxLength={6} value={otp} onChange={setOtp}>
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
          <span className="text-xs text-muted-foreground">
            {otp ? `Entered: ${otp}` : 'Enter your code'}
          </span>
        </div>
      </Example>

      <Example label="Field" full>
        <FieldGroup className="max-w-md">
          <Field>
            <FieldLabel htmlFor="field-email">Email</FieldLabel>
            <Input id="field-email" type="email" placeholder="you@example.com" />
            <FieldDescription>We'll never share your email.</FieldDescription>
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="field-username">Username</FieldLabel>
            <Input id="field-username" aria-invalid placeholder="ada" />
            <FieldError>This username is already taken.</FieldError>
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Notifications</FieldLegend>
            <Field orientation="horizontal">
              <Switch id="field-marketing" />
              <FieldLabel htmlFor="field-marketing">Marketing emails</FieldLabel>
            </Field>
          </FieldSet>
        </FieldGroup>
      </Example>

      <Example label="Input Group" full>
        <div className="flex w-full max-w-md flex-col gap-3">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search..." />
          </InputGroup>

          <InputGroup>
            <InputGroupAddon>
              <Mail />
            </InputGroupAddon>
            <InputGroupInput type="email" placeholder="you@example.com" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Copy">
                <Copy />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>

          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>https://</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput placeholder="example.com" />
          </InputGroup>

          <InputGroup>
            <InputGroupTextarea
              placeholder="Leave a comment..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <InputGroupAddon align="block-end">
              <InputGroupText>{comment.length} chars</InputGroupText>
              <InputGroupButton size="sm" variant="default" className="ml-auto">
                <Send />
                Send
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </Example>
    </SectionShell>
  );
}
