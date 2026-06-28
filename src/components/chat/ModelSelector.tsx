import { Sparkles, Zap } from 'lucide-react';
import { AI_MODELS } from '../../types';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const selected = AI_MODELS.find(model => model.id === value) || AI_MODELS[0];

  return (
    <Select value={selected.id} onValueChange={onChange}>
      <SelectTrigger size="sm" className="model-selector-trigger w-32 max-w-[36vw]">
        {selected.id === 'auto' ? <Sparkles data-icon="inline-start" /> : <Zap data-icon="inline-start" />}
        <span className="min-w-0 flex-1 truncate text-left">{compactModelLabel(selected.label)}</span>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        <SelectGroup>
          <SelectLabel>Model</SelectLabel>
          {AI_MODELS.map(model => (
            <SelectItem key={model.id} value={model.id} textValue={model.label}>
              {model.id === 'auto' ? <Sparkles data-icon="inline-start" /> : <Zap data-icon="inline-start" />}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{model.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {model.description}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function compactModelLabel(label: string) {
  return label.replace(/^Claude\s+/, '').replace(/^GPT\s+/, '');
}
