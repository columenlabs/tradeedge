import { ChevronRightIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

export interface DrawerSectionProps {
  icon: LucideIcon;
  title: string;
  /** A count chip after the title (rows in the section). */
  count?: number | null;
  /** A short note on the right of the header ("None"). */
  hint?: string | null;
  /** Sections start collapsed unless set open (Bikram, 2026-10-12). */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * One section of a pullout drawer, on every desk (Bikram, 2026-10-12, p2e style): a header of
 * chevron, icon, title, optional count and note, with no background until hovered; a hairline
 * between sections. Drawers stack these under their title instead of their own headings.
 */
export function DrawerSection({
  icon: Icon,
  title,
  count,
  hint,
  defaultOpen = false,
  children,
}: DrawerSectionProps) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/section border-t py-1 first:border-t-0">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          // No background, grey only on hover (Bikram, 2026-10-12), open or not.
          className="w-full justify-start px-1 aria-expanded:bg-transparent aria-expanded:hover:bg-muted"
        >
          <ChevronRightIcon className="text-muted-foreground transition-transform group-data-[state=open]/section:rotate-90" />
          <Icon className="text-muted-foreground" />
          <span className="truncate">{title}</span>
          {count != null && (
            <Badge variant="secondary" className="num">
              {count}
            </Badge>
          )}
          {hint && (
            <span className="ml-auto font-normal text-muted-foreground text-xs">{hint}</span>
          )}
        </Button>
      </CollapsibleTrigger>
      {/* Content starts under the title text: px-1 + chevron + gap + icon + gap (Bikram, 2026-10-12). */}
      <CollapsibleContent className="pt-1 pr-1 pb-2 pl-10">{children}</CollapsibleContent>
    </Collapsible>
  );
}
