import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays, Trash2 } from 'lucide-react';

import { SectionShell, Example } from '@/showcase/SectionShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export default function OverlaysSection() {
  const [name, setName] = useState('Ada Lovelace');
  const [sheetEmail, setSheetEmail] = useState('ada@example.com');
  const [width, setWidth] = useState('320');

  return (
    <SectionShell title="Overlays" description="Dialogs, sheets, drawers and popovers">
      <Example label="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="default">Edit profile</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit profile</DialogTitle>
              <DialogDescription>
                Make changes to your profile here. Click save when you're done.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dialog-name">Name</Label>
              <Input
                id="dialog-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button onClick={() => toast.success(`Saved ${name}`)}>
                  Save changes
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Example>

      <Example label="Alert Dialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 />
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete your
                account and remove your data from our servers.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => toast.error('Account deleted')}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Example>

      <Example label="Sheet">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary">Open settings</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Account settings</SheetTitle>
              <SheetDescription>
                Update your contact details. Changes apply immediately.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-2 px-4">
              <Label htmlFor="sheet-email">Email</Label>
              <Input
                id="sheet-email"
                type="email"
                value={sheetEmail}
                onChange={(e) => setSheetEmail(e.target.value)}
              />
            </div>
            <SheetFooter>
              <SheetClose asChild>
                <Button onClick={() => toast.success('Settings saved')}>
                  Save
                </Button>
              </SheetClose>
              <SheetClose asChild>
                <Button variant="ghost">Cancel</Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Example>

      <Example label="Drawer">
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="outline">Open drawer</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Adjust width</DrawerTitle>
              <DrawerDescription>
                Set the container width in pixels.
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-col gap-2 px-4">
              <Label htmlFor="drawer-width">Width (px)</Label>
              <Input
                id="drawer-width"
                type="number"
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button onClick={() => toast.success(`Width set to ${width}px`)}>
                  Apply
                </Button>
              </DrawerClose>
              <DrawerClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Example>

      <Example label="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Dimensions</Button>
          </PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Dimensions</PopoverTitle>
              <PopoverDescription>
                Set the dimensions for the layer.
              </PopoverDescription>
            </PopoverHeader>
            <div className="grid grid-cols-2 items-center gap-2">
              <Label htmlFor="pop-w">Width</Label>
              <Input id="pop-w" defaultValue="100%" className="h-7" />
              <Label htmlFor="pop-h">Height</Label>
              <Input id="pop-h" defaultValue="auto" className="h-7" />
            </div>
          </PopoverContent>
        </Popover>
      </Example>

      <Example label="Hover Card">
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button variant="link">@openhatch</Button>
          </HoverCardTrigger>
          <HoverCardContent>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">OpenHatch</span>
              <p className="text-sm text-muted-foreground">
                Open-source project management for small teams.
              </p>
              <div className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
                <CalendarDays className="size-3.5" />
                Joined March 2024
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      </Example>

      <Example label="Tooltip">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon">
              <Trash2 />
              <span className="sr-only">Delete</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete item</TooltipContent>
        </Tooltip>
      </Example>
    </SectionShell>
  );
}
