// The shared AppShell (Bikram, 2026-10-08): the frame, page, status bar, sidebar building blocks,
// preferences, filter and Overview page every desk and any new app uses. Shadcn components the shell is built
// from are under `@edgedesk/app-shell/ui/*`; a desk's sidebar content must use these (not its own
// copies) so it shares the shell's sidebar state. Every desk and the shell use the same major
// of TanStack Table (v9): vite's dev pre-bundling serves one copy to all of them.
export {
  type CustomViewConfig,
  CustomViewPage,
  type CustomViewPageProps,
  type ViewCellValue,
  type ViewDomain,
  type ViewField,
  ViewValueCell,
  rollUp,
} from './custom-view';
export { ConfirmDelete, type ConfirmDeleteProps } from './confirm';
export { DESKS, type Desk, type DeskId } from './desks';
export { SIGN_OUT_URL, type Identity, useIdentity } from './identity';
export {
  NavGroup,
  type NavItem,
  type SectionItem,
  type SectionSubItem,
  SidebarSection,
} from './nav';
export {
  type OverviewPageProps,
  type OverviewStage,
  type OverviewTone,
  type OverviewWidget,
  OverviewList,
  OverviewPage,
  ToneDot,
} from './overview';
export { type Crumb, Page, PageBody, PageHeader, type PageHeaderProps } from './page';
export {
  DEFAULT_PREFS,
  type Prefs,
  TIME_ZONES,
  type Theme,
  type TimeZoneId,
  getPrefs,
  resolvedTheme,
  setPref,
  timeZoneLabel,
  usePrefs,
} from './prefs';
export { refreshHeaders } from './refresh';
export { SettingRow, type SettingsSectionDef } from './settings';
export {
  AppShell,
  type AppShellProps,
  StatusItem,
  maskAmount,
  useAmountsHidden,
  useShell,
} from './shell';
export { TimeZoneSelect } from './status';
export { TILE_WIDTH, Tile, type TileOption, TileRow, TileToggleGroup } from './tile';
export {
  type FilterField,
  type FilterToken,
  TokenFilter,
  type TokenFilterState,
  useTokenFilter,
} from './token-filter';
export { useIsMobile } from './hooks/use-mobile';
export { VIEW_ICONS, viewIcon } from './view-icons';
