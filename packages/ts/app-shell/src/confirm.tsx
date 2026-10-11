// Every delete asks first (Bikram, 2026-10-09): one shadcn AlertDialog every desk uses for any
// delete or remove of saved data. Wrap the trigger button, or control `open` when the delete
// starts from a menu item.
import type { ReactNode } from 'react';
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
} from './ui/alert-dialog';

export interface ConfirmDeleteProps {
  /** The question, e.g. `Delete view Options?`. */
  title: ReactNode;
  description?: ReactNode;
  /** The confirm button's label. */
  action?: string;
  onConfirm: () => void;
  /** The button that opens the dialog; leave it out and control `open` instead. */
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDelete({
  title,
  description = 'This cannot be undone.',
  action = 'Delete',
  onConfirm,
  children,
  open,
  onOpenChange,
}: ConfirmDeleteProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {children && <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
