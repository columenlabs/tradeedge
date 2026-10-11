// Sidebar building blocks a desk composes its nav from (shadcn NavMain pattern): a group of links
// that may nest one level (chevron on the right, hidden in icon mode), and a section whose items a
// person adds with `+` and removes with the trash icon. Every item carries an icon; section headers are bold caps without one.
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronRightIcon, type LucideIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConfirmDelete } from './confirm';
import { cn } from './lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from './ui/sidebar';

export interface NavItem {
  title: string;
  to: string;
  icon: LucideIcon;
  badge?: ReactNode;
  /** Active only on this exact path, not its children. */
  exact?: boolean;
  /** One nested level, shown under a collapsible parent. */
  items?: Omit<NavItem, 'items'>[];
}

function useActive() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return ({ to, exact }: { to: string; exact?: boolean }) =>
    path === to || (!exact && path.startsWith(`${to.replace(/\/$/, '')}/`));
}

/** A section header: bold caps, no icon (Bikram, 2026-10-09). */
function GroupLabel({ label }: { label: string }) {
  return <SidebarGroupLabel>{label}</SidebarGroupLabel>;
}

export function NavGroup({ label, items }: { label?: string; items: NavItem[] }) {
  const active = useActive();
  return (
    <SidebarGroup>
      {label && <GroupLabel label={label} />}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) =>
            item.items?.length ? (
              <Collapsible
                key={item.to}
                asChild
                defaultOpen={active(item) || item.items.some(active)}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip={item.title} isActive={active(item)}>
                      <item.icon />
                      <span>{item.title}</span>
                      <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[collapsible=icon]:hidden group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items.map((sub) => (
                        <SidebarMenuSubItem key={sub.to}>
                          <SidebarMenuSubButton asChild isActive={active(sub)}>
                            <Link to={sub.to}>
                              <sub.icon />
                              <span>{sub.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            ) : (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild tooltip={item.title} isActive={active(item)}>
                  <Link to={item.to}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
                {item.badge !== undefined && item.badge !== null && (
                  <SidebarMenuBadge className={typeof item.badge === 'number' ? 'num' : undefined}>
                    {item.badge}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export interface SectionItem {
  id: string;
  title: string;
  to: string;
  icon: LucideIcon;
  /** A count or a value on the right (a % change); hidden while the remove icon shows. */
  badge?: ReactNode;
  /** One nested level, toggled by a chevron; the item itself still links. */
  items?: SectionSubItem[];
  /** Open the nested items on first render (they also open while one is active). */
  defaultOpen?: boolean;
  /** Not removable: no trash icon even when the section has `onRemove`. */
  fixed?: boolean;
}

export interface SectionSubItem {
  id: string;
  title: string;
  to: string;
  /** A colour dot before the title, matching the item's line on a chart. */
  color?: string;
}

const SECTION_BADGE = 'num group-data-[collapsible=icon]:hidden';

/** One section item: a link, its badge, and the chevron and nested items when it has any. */
function SectionRow({
  item,
  active,
  onRemove,
  removeLabel,
}: {
  item: SectionItem;
  active: (i: { to: string; exact?: boolean }) => boolean;
  onRemove?: (item: SectionItem) => void;
  removeLabel: (item: SectionItem) => string;
}) {
  const subs = item.items ?? [];
  const subActive = subs.some((s) => active({ to: s.to, exact: true }));
  const isActive = active({ to: item.to, exact: true }) && !subActive;
  // The open item shows no trash icon (Bikram, 2026-10-09).
  const remove = item.fixed || isActive ? undefined : onRemove;
  const row = (
    <>
      <SidebarMenuButton asChild tooltip={item.title} isActive={isActive}>
        <Link to={item.to}>
          <item.icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
      {item.badge !== undefined && item.badge !== null && (
        <SidebarMenuBadge
          className={cn(
            SECTION_BADGE,
            subs.length > 0 && 'right-7',
            // The remove icon shows on hover from md up, and always below it: make room there.
            remove &&
              'max-md:right-7 md:group-focus-within/menu-item:opacity-0 md:group-hover/menu-item:opacity-0',
          )}
        >
          {item.badge}
        </SidebarMenuBadge>
      )}
      {remove && (
        <ConfirmDelete
          title={`${removeLabel(item)}?`}
          action="Remove"
          onConfirm={() => remove(item)}
        >
          <SidebarMenuAction
            showOnHover
            aria-label={removeLabel(item)}
            title={removeLabel(item)}
            // Muted while the row is hovered, red while the icon itself is (Bikram, 2026-10-09).
            className="text-muted-foreground peer-hover/menu-button:text-muted-foreground hover:bg-transparent hover:text-destructive"
          >
            <Trash2Icon />
          </SidebarMenuAction>
        </ConfirmDelete>
      )}
    </>
  );
  if (!subs.length) return <SidebarMenuItem>{row}</SidebarMenuItem>;
  return (
    <Collapsible
      asChild
      defaultOpen={item.defaultOpen || subActive || active(item)}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        {row}
        <CollapsibleTrigger asChild>
          <SidebarMenuAction
            aria-label={`Show or hide ${item.title}`}
            className="data-[state=open]:rotate-90"
          >
            <ChevronRightIcon />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {subs.map((sub) => (
              <SidebarMenuSubItem key={sub.id}>
                <SidebarMenuSubButton asChild isActive={active({ to: sub.to, exact: true })}>
                  <Link to={sub.to}>
                    {sub.color && (
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: sub.color }}
                      />
                    )}
                    <span>{sub.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/**
 * A section of things a person keeps (views, trades, a watchlist): `+` adds one, the
 * trash icon on hover removes one. An item may carry a badge and one nested level of links with
 * colour dots. The desk supplies the items and both handlers.
 */
export function SidebarSection({
  label,
  items,
  onAdd,
  addLabel = `Add to ${label}`,
  onRemove,
  removeLabel = (item: SectionItem) => `Remove ${item.title}`,
  loading,
  empty,
  children,
}: {
  label: string;
  items: SectionItem[];
  onAdd?: () => void;
  addLabel?: string;
  onRemove?: (item: SectionItem) => void;
  removeLabel?: (item: SectionItem) => string;
  loading?: boolean;
  /** Shown when there are no items. */
  empty?: ReactNode;
  /** Extra content under the items (a search box, a retry line). */
  children?: ReactNode;
}) {
  const active = useActive();
  return (
    <SidebarGroup>
      <GroupLabel label={label} />
      {onAdd && (
        <SidebarGroupAction title={addLabel} aria-label={addLabel} onClick={onAdd}>
          <PlusIcon />
        </SidebarGroupAction>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {loading
            ? [0, 1].map((i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))
            : items.map((item) => (
                <SectionRow
                  key={item.id}
                  item={item}
                  active={active}
                  onRemove={onRemove}
                  removeLabel={removeLabel}
                />
              ))}
          {!loading && !items.length && empty && (
            <li className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              {empty}
            </li>
          )}
        </SidebarMenu>
        {children}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
