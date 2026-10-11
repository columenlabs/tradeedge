// The frame every desk renders in (Bikram, 2026-10-08), from the shadcn sidebar-07 block: desk
// switcher top-left, the desk's own nav, the profile bottom-left; collapses to icons on desktop and
// becomes a drawer on phone. A desk passes its id, nav and status items; pages render in `Page`.
import { useRouterState } from '@tanstack/react-router';
import { CheckIcon, ChevronsUpDownIcon, LogOutIcon, SettingsIcon, SunMoonIcon } from 'lucide-react';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type Desk, type DeskId, appsHere, deskOf } from './desks';
import { SIGN_OUT_URL, firstName, initials, useIdentity } from './identity';
import { cn } from './lib/utils';
import { usePrefs } from './prefs';
import { withRefreshToken } from './refresh';
import { SettingsDialog, type SettingsSectionDef, ThemeToggle } from './settings';
import { StatusTimeZone } from './status';
import { Avatar, AvatarFallback } from './ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from './ui/sidebar';
import { TooltipProvider } from './ui/tooltip';

interface ShellContext {
  desk: DeskId;
  /** Where a page's status items render (the status bar's page slot). */
  statusSlot: HTMLElement | null;
  /** Opens Settings at a section (`preferences` or one of the desk's own). */
  openSettings: (section?: string) => void;
  /** The header's Refresh: reloads the page's data, skipping the server cache. Null without `onRefresh`. */
  refresh: (() => Promise<void>) | null;
  refreshing: boolean;
  /** The desk shows Hide amounts in its header (`hideAmounts` on `AppShell`). */
  hideAmounts: boolean;
}
const Ctx = createContext<ShellContext | null>(null);

export function useShell(): ShellContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShell must be used inside <AppShell>.');
  return c;
}

/** True while Hide amounts is on in a desk that offers it: holding amounts render as `•••••`. */
export function useAmountsHidden(): boolean {
  const offered = useContext(Ctx)?.hideAmounts ?? false;
  return usePrefs().hideAmounts && offered;
}

/** `+$152,372` → `+$•••••`: every number in the text masked, signs and units kept. */
export const maskAmount = (text: string) => text.replace(/\d[\d.,]*/g, '•••••');

/** The sidebar provider writes this cookie on toggle; reading it back keeps the choice per desk. */
const sidebarOpen = () =>
  typeof document === 'undefined' || !document.cookie.split('; ').includes('sidebar_state=false');

/** "Data" in the app's accent, then "Edge" in the suite's gold. */
function DeskName({ desk }: { desk: Desk }) {
  return (
    <span>
      <span data-desk-name={desk.id}>{desk.prefix}</span>
      <span className="text-edge">Edge</span>
    </span>
  );
}

function DeskSwitcher({ desk }: { desk: DeskId }) {
  const { isMobile } = useSidebar();
  const current = deskOf(desk);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={current.label}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <current.icon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  <DeskName desk={current} />
                </span>
                <span className="truncate text-xs text-muted-foreground">EdgeDesk</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Apps</DropdownMenuLabel>
            {appsHere(current).map((d) => (
              <DropdownMenuItem key={d.id} asChild className="gap-2 p-2">
                <a href={d.href} aria-current={d.id === desk ? 'page' : undefined}>
                  <div
                    data-desk-swatch={d.id}
                    className="flex size-6 items-center justify-center rounded-md border"
                  >
                    <d.icon className="size-3.5 shrink-0" />
                  </div>
                  <DeskName desk={d} />
                  {d.id === desk && <CheckIcon className="ml-auto" />}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The phone drawer closes once a link in it opens a page. */
function CloseDrawerOnNavigate() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new path.
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  return null;
}

const SETTINGS_KEYS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘,' : 'Ctrl+,';

/** The profile menu's theme line (Bikram, 2026-10-09): not a menu item, so a pick keeps it open. */
function ThemeItem() {
  return (
    <div data-slot="theme-item" className="flex items-center gap-2 px-2 py-1 text-sm">
      <SunMoonIcon className="size-4 text-muted-foreground" />
      <span className="flex-1">Theme</span>
      <ThemeToggle compact />
    </div>
  );
}

function NavUser({ onSettings }: { onSettings: () => void }) {
  const { isMobile } = useSidebar();
  const who = useIdentity();
  const person = (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg text-xs">{initials(who)}</AvatarFallback>
      </Avatar>
      <span className="flex-1 truncate text-left text-sm font-medium">{firstName(who)}</span>
    </>
  );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip="Profile"
              aria-label="Profile"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {person}
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {who?.email ?? 'Signed in'}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={onSettings}>
                <SettingsIcon />
                Settings
                <DropdownMenuShortcut>{SETTINGS_KEYS}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <ThemeItem />
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={SIGN_OUT_URL} data-sign-out>
                <LogOutIcon />
                Sign out
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export interface AppShellProps {
  desk: DeskId;
  /** The desk's sidebar content: `NavGroup`s and `SidebarSection`s. */
  nav: ReactNode;
  /** Desk-wide status bar items (health, freshness); pages add their own through `Page`. */
  status?: ReactNode;
  /** The desk's own Settings sections, listed after Preferences. */
  settings?: SettingsSectionDef[];
  /** Reloads the page's data (e.g. TanStack Query `refetchQueries`); shows Refresh in the header. */
  onRefresh?: () => Promise<unknown>;
  /** Shows Hide amounts (eye) in the header: masks the fields and values the desk marks `amount`. */
  hideAmounts?: boolean;
  /** The routed page (usually `<Outlet />`). */
  children: ReactNode;
}

// `?settings=<section>` opens Settings there (GitHub's install page returns to it). It is read when
// the page loads, before a desk's router can redirect it away, and dropped from the URL so a reload
// does not reopen it.
const settingsFromUrl: string | null = (() => {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const at = url.searchParams.get('settings');
  if (at === null) return null;
  url.searchParams.delete('settings');
  window.history.replaceState(window.history.state, '', url);
  return at || 'preferences';
})();

export function AppShell({
  desk,
  nav,
  status,
  settings,
  onRefresh,
  hideAmounts = false,
  children,
}: AppShellProps) {
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await withRefreshToken(onRefresh);
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);
  const [settingsAt, setSettingsAt] = useState<string | null>(settingsFromUrl);
  const [lastSection, setLastSection] = useState(settingsAt ?? 'preferences');
  const openSettings = useCallback(
    (section?: string) => {
      const at = section ?? lastSection;
      setLastSection(at);
      setSettingsAt(at);
    },
    [lastSection],
  );
  useEffect(() => {
    document.documentElement.dataset.desk = desk;
  }, [desk]);

  return (
    <Ctx.Provider
      value={{
        desk,
        statusSlot,
        openSettings,
        refresh: onRefresh ? refresh : null,
        refreshing,
        hideAmounts,
      }}
    >
      <TooltipProvider delayDuration={200}>
        <SidebarProvider defaultOpen={sidebarOpen()}>
          <CloseDrawerOnNavigate />
          <Sidebar collapsible="icon">
            <SidebarHeader>
              <DeskSwitcher desk={desk} />
            </SidebarHeader>
            <SidebarContent>{nav}</SidebarContent>
            <SidebarFooter>
              <NavUser onSettings={() => openSettings()} />
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>
          <SidebarInset className="flex min-h-svh min-w-0 flex-col">
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
            <footer
              data-slot="shell-status"
              aria-label="Status"
              className="sticky bottom-0 z-10 flex h-(--shell-status-height) shrink-0 items-center gap-4 overflow-x-auto overflow-y-hidden border-t bg-background px-(--shell-gutter) text-xs whitespace-nowrap text-muted-foreground"
            >
              {status}
              <div ref={setStatusSlot} className="flex shrink-0 items-center gap-4" />
              <StatusTimeZone className="ml-auto shrink-0" />
            </footer>
          </SidebarInset>
          <SettingsDialog
            open={settingsAt !== null}
            section={settingsAt ?? lastSection}
            onOpen={openSettings}
            onClose={() => setSettingsAt(null)}
            desk={desk}
            sections={settings}
          />
        </SidebarProvider>
      </TooltipProvider>
    </Ctx.Provider>
  );
}

/** A status bar entry: an optional health dot, a label and a mono value. */
export function StatusItem({
  label,
  value,
  ok,
  className,
}: {
  label: ReactNode;
  value?: ReactNode;
  /** Green when true, red when false, grey while unknown; no dot when left out. */
  ok?: boolean | null;
  className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      {ok !== undefined && (
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            ok === null ? 'bg-muted-foreground/40' : ok ? 'bg-gain' : 'bg-destructive',
          )}
        />
      )}
      {label}
      {value !== undefined && (
        <>
          {' '}
          <span className="num text-foreground/80">{value}</span>
        </>
      )}
    </span>
  );
}
