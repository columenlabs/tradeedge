// Settings (Bikram, 2026-10-08): one large dialog, opened from the profile menu or Ctrl/Cmd+, with
// its sections listed on the left: Preferences (theme, glass, time zone; the same on every desk),
// then the desk's own sections (ResearchEdge: Timelines, Repos). On phone the list becomes a picker.
// A search box tops the list and filters the rows on every section (Bikram, 2026-10-09).
// `?settings=<section>` in the URL opens it at that section (GitHub's install page returns there).
import {
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type DeskId, deskOf } from './desks';
import { type Theme, setPref, usePrefs } from './prefs';
import { TimeZoneSelect } from './status';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const THEMES: { value: Theme; label: string; short: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light theme', short: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark theme', short: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'Follow the device', short: 'System', icon: MonitorIcon },
];

/** A section a desk adds to Settings, listed under the desk's name. */
export interface SettingsSectionDef {
  id: string;
  title: string;
  icon: typeof SunIcon;
  description?: ReactNode;
  content: ReactNode;
}

/** The Settings search text; rows that do not match it hide (Bikram, 2026-10-09). */
const SearchContext = createContext('');
const matches = (query: string, ...texts: ReactNode[]) =>
  texts.some((t) => typeof t === 'string' && t.toLowerCase().includes(query.toLowerCase()));

/** One setting: title and description on the left, its control on the right. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  const query = useContext(SearchContext);
  if (query && !matches(query, label, description)) return null;
  return (
    <div data-slot="setting-row" className="flex items-center gap-4 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Light, dark or system: in Settings with labels, in the profile menu as icons with tooltips. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const prefs = usePrefs();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={prefs.theme}
      onValueChange={(v) => v && setPref('theme', v as Theme)}
      aria-label="Theme"
    >
      {THEMES.map((t) =>
        compact ? (
          <Tooltip key={t.value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={t.value} aria-label={t.label}>
                <t.icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{t.short}</TooltipContent>
          </Tooltip>
        ) : (
          <ToggleGroupItem key={t.value} value={t.value} aria-label={t.label}>
            <t.icon />
            {t.short}
          </ToggleGroupItem>
        ),
      )}
    </ToggleGroup>
  );
}

function Preferences() {
  const prefs = usePrefs();
  return (
    <div className="flex flex-col">
      <SettingRow label="Theme" description="Light, dark, or follow the device.">
        <ThemeToggle />
      </SettingRow>
      <SettingRow
        label="Glass surfaces"
        description="Frosted cards and panels."
        htmlFor="settings-glass"
      >
        <Switch
          id="settings-glass"
          checked={prefs.glass}
          onCheckedChange={(v) => setPref('glass', v)}
        />
      </SettingRow>
      <SettingRow label="Time zone" description="Every time on every desk shows in this zone.">
        <TimeZoneSelect />
      </SettingRow>
    </div>
  );
}

const PREFERENCES: Omit<SettingsSectionDef, 'content'> = {
  id: 'preferences',
  title: 'Preferences',
  icon: SlidersHorizontalIcon,
  description: 'Yours on every desk, saved in this browser.',
};

export function SettingsDialog({
  open,
  section,
  onOpen,
  onClose,
  desk,
  sections = [],
}: {
  open: boolean;
  /** The section shown; unknown ids show Preferences. */
  section: string;
  onOpen: (section: string) => void;
  onClose: () => void;
  desk: DeskId;
  sections?: SettingsSectionDef[];
}) {
  const all: SettingsSectionDef[] = [{ ...PREFERENCES, content: <Preferences /> }, ...sections];
  const current = all.find((s) => s.id === section) ?? (all[0] as SettingsSectionDef);
  const deskLabel = deskOf(desk).label;

  // Ctrl/Cmd+, opens Settings, like most apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpen(section);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen, section]);

  // Search (Bikram, 2026-10-09): every section's matching rows show at once; a section matching by
  // title or description shows whole. Sections with nothing to show drop out of the nav.
  const [query, setQuery] = useState('');
  const q = query.trim();
  const pane = useRef<HTMLElement>(null);
  const [found, setFound] = useState<string[]>([]);
  useLayoutEffect(() => {
    if (!q) return;
    const ids = [...(pane.current?.querySelectorAll<HTMLElement>('[data-settings-section]') ?? [])]
      .filter((el) => el.dataset.whole === 'true' || el.querySelector('[data-slot=setting-row]'))
      .map((el) => el.dataset.settingsSection ?? '');
    setFound((f) => (f.join() === ids.join() ? f : ids));
  });
  const shown = (s: SettingsSectionDef) => !q || found.includes(s.id);
  const go = (id: string) => {
    setQuery('');
    onOpen(id);
  };

  const groups = [
    { label: 'All desks', items: all.slice(0, 1).filter(shown) },
    ...(sections.length ? [{ label: deskLabel, items: sections.filter(shown) }] : []),
  ].filter((g) => g.items.length);

  const search = (
    <InputGroup className="bg-background">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        className="[&::-webkit-search-cancel-button]:hidden"
        aria-label="Search settings"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery('')}>
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );

  const header = (s: SettingsSectionDef) => (
    <div className="flex flex-col gap-0.5 pr-8">
      <h3 id={`settings-${s.id}-title`} className="flex items-center gap-2 text-base font-semibold">
        <s.icon className="size-4 text-muted-foreground" />
        {s.title}
      </h3>
      {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) onOpen(section);
        else {
          setQuery('');
          onClose();
        }
      }}
    >
      <DialogContent
        data-slot="settings"
        // Esc clears the search first, then closes.
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery('');
          }
        }}
        className="flex h-[min(720px,calc(100svh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl md:flex-row"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Your preferences and this desk's settings.
        </DialogDescription>
        <nav
          aria-label="Settings sections"
          className="hidden w-56 shrink-0 flex-col border-r bg-sidebar py-2 md:flex"
        >
          <div className="px-2 pt-1 pb-1">{search}</div>
          {groups.map((g) => (
            <SidebarGroup key={g.label} className="py-1">
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((s) => (
                    <SidebarMenuItem key={s.id}>
                      <SidebarMenuButton
                        isActive={!q && s.id === current.id}
                        onClick={() => go(s.id)}
                      >
                        <s.icon />
                        <span>{s.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
        <div className="flex flex-col gap-2 border-b p-3 pr-12 md:hidden">
          {search}
          {!q && (
            <Select value={current.id} onValueChange={go}>
              <SelectTrigger aria-label="Settings section" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {all.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <s.icon />
                    {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {q ? (
          <section
            ref={pane}
            aria-label="Search results"
            // The top band on desktop keeps results clear of the dialog's X.
            className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-4 pb-8 md:mt-12 md:border-t md:px-6 md:pt-6"
          >
            {all.map((s) => {
              const whole = matches(q, s.title, s.description);
              return (
                <div
                  key={s.id}
                  data-settings-section={s.id}
                  data-whole={whole}
                  aria-labelledby={`settings-${s.id}-title`}
                  className={
                    whole
                      ? 'flex flex-col gap-3'
                      : 'hidden flex-col gap-3 has-[[data-slot=setting-row]]:flex'
                  }
                >
                  {header(s)}
                  <Separator />
                  <SearchContext.Provider value={whole ? '' : q}>
                    {s.content}
                  </SearchContext.Provider>
                </div>
              );
            })}
            {!found.length && (
              <p className="text-sm text-muted-foreground">No settings match “{q}”.</p>
            )}
          </section>
        ) : (
          <section
            aria-labelledby={`settings-${current.id}-title`}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {/* Header stays put; only the body scrolls, so content never runs under the X. */}
            <div className="flex shrink-0 flex-col gap-3 px-4 pt-4 md:px-6 md:pt-6">
              {header(current)}
              <Separator />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3 pb-8 md:px-6">
              {current.content}
            </div>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
