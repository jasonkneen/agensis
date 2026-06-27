import { useState } from 'react';
import { toast } from 'sonner';
import { Bell, Check, FolderPlus, Inbox, Star } from 'lucide-react';

import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
} from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { AspectRatio } from '@/components/ui/aspect-ratio';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
  ItemSeparator,
} from '@/components/ui/item';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

const people = [
  { id: 'ada', name: 'Ada Lovelace', role: 'Engineering', src: 'https://i.pravatar.cc/80?img=5' },
  { id: 'alan', name: 'Alan Turing', role: 'Research', src: 'https://i.pravatar.cc/80?img=12' },
  { id: 'grace', name: 'Grace Hopper', role: 'Design', src: 'https://i.pravatar.cc/80?img=32' },
];

export default function DataDisplaySection() {
  const [liked, setLiked] = useState(false);
  const [selected, setSelected] = useState<string>('ada');
  const [loaded, setLoaded] = useState(false);

  return (
    <SectionShell title="Data Display" description="Cards, avatars, items and empty/skeleton states">
      <Example label="Card" full>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Project Hatch</CardTitle>
            <CardDescription>A small team building in the open.</CardDescription>
            <CardAction>
              <Button
                variant={liked ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-pressed={liked}
                aria-label={liked ? 'Unstar project' : 'Star project'}
                onClick={() => setLiked((v) => !v)}
              >
                <Star className={liked ? 'fill-current' : undefined} />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            {liked ? 'Starred — you will get release updates.' : 'Star this project to follow along.'}
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => toast('Shared project link')}>
              Share
            </Button>
            <Button variant="default" size="sm" onClick={() => toast.success('Joined Project Hatch')}>
              Join
            </Button>
          </CardFooter>
        </Card>
      </Example>

      <Example label="Avatar">
        <Avatar size="sm">
          <AvatarImage src={people[0].src} alt={people[0].name} />
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage src={people[1].src} alt={people[1].name} />
          <AvatarFallback>AT</AvatarFallback>
        </Avatar>
        <Avatar size="lg">
          <AvatarImage src={people[2].src} alt={people[2].name} />
          <AvatarFallback>GH</AvatarFallback>
          <AvatarBadge />
        </Avatar>
        <Avatar>
          <AvatarFallback>JK</AvatarFallback>
        </Avatar>
      </Example>

      <Example label="Avatar Group">
        <AvatarGroup>
          {people.map((p) => (
            <Avatar key={p.id}>
              <AvatarImage src={p.src} alt={p.name} />
              <AvatarFallback>{p.name.slice(0, 2)}</AvatarFallback>
            </Avatar>
          ))}
          <AvatarGroupCount>+5</AvatarGroupCount>
        </AvatarGroup>
      </Example>

      <Example label="Separator">
        <div className="w-full max-w-xs">
          <p className="text-sm text-foreground">Inbox</p>
          <Separator className="my-2" />
          <div className="flex h-5 items-center gap-3 text-sm text-muted-foreground">
            <span>Drafts</span>
            <Separator orientation="vertical" />
            <span>Sent</span>
            <Separator orientation="vertical" />
            <span>Archive</span>
          </div>
        </div>
      </Example>

      <Example label="Aspect Ratio">
        <div className="w-full max-w-xs">
          <AspectRatio ratio={16 / 9} className="overflow-hidden rounded-lg border border-border">
            <img
              src="https://images.unsplash.com/photo-1465146344425-f00d5f5c8f07?w=600&q=80"
              alt="Greenhouse"
              className="size-full object-cover"
            />
          </AspectRatio>
        </div>
      </Example>

      <Example label="Item" full>
        <ItemGroup className="max-w-md">
          {people.map((p, i) => (
            <div key={p.id}>
              {i > 0 && <ItemSeparator />}
              <Item
                variant={selected === p.id ? 'muted' : 'outline'}
                onClick={() => setSelected(p.id)}
                className="cursor-pointer"
              >
                <ItemMedia variant="image">
                  <img src={p.src} alt={p.name} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{p.name}</ItemTitle>
                  <ItemDescription>{p.role}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {selected === p.id ? (
                    <Check className="size-4 text-primary" />
                  ) : (
                    <Button variant="ghost" size="sm">
                      Select
                    </Button>
                  )}
                </ItemActions>
              </Item>
            </div>
          ))}
        </ItemGroup>
      </Example>

      <Example label="Empty" full>
        <Empty className="max-w-md border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>No notifications</EmptyTitle>
            <EmptyDescription>You are all caught up. New activity will show up here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => toast('Subscribed to updates')}>
              <Bell />
              Enable alerts
            </Button>
          </EmptyContent>
        </Empty>
      </Example>

      <Example label="Skeleton" full>
        <div className="w-full max-w-sm space-y-3">
          <Button variant="secondary" size="sm" onClick={() => setLoaded((v) => !v)}>
            {loaded ? 'Show loading' : 'Show loaded'}
          </Button>
          {loaded ? (
            <Item variant="outline">
              <ItemMedia variant="image">
                <img src={people[2].src} alt={people[2].name} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{people[2].name}</ItemTitle>
                <ItemDescription>{people[2].role}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <FolderPlus className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Skeleton className="size-10 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          )}
        </div>
      </Example>
    </SectionShell>
  );
}
