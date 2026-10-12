// The icons a person can pick for a view (Bikram, 2026-10-09); names are `viewIconNames` in
// `@edgedesk/types/views`. A view without one shows its shape's icon.
import type { ViewIcon, ViewIconName, ViewShape } from '@edgedesk/types/views';
import {
  BanknoteIcon,
  BriefcaseIcon,
  CalendarIcon,
  ChartBarIcon,
  ChartLineIcon,
  ChartPieIcon,
  ClockIcon,
  CoinsIcon,
  FlameIcon,
  Grid3x3Icon,
  LandmarkIcon,
  LayersIcon,
  ListTreeIcon,
  type LucideIcon,
  PiggyBankIcon,
  ReceiptIcon,
  ShieldIcon,
  StarIcon,
  TableIcon,
  TagIcon,
  TargetIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  WalletIcon,
  ZapIcon,
} from 'lucide-react';
import { DynamicIcon, type IconName, iconNames } from 'lucide-react/dynamic';
import { createElement } from 'react';
import { cn } from './lib/utils';
import type { NavIcon } from './nav';

export const VIEW_ICONS: Record<ViewIconName, LucideIcon> = {
  table: TableIcon,
  'list-tree': ListTreeIcon,
  grid: Grid3x3Icon,
  wallet: WalletIcon,
  receipt: ReceiptIcon,
  briefcase: BriefcaseIcon,
  landmark: LandmarkIcon,
  'piggy-bank': PiggyBankIcon,
  banknote: BanknoteIcon,
  coins: CoinsIcon,
  'chart-line': ChartLineIcon,
  'chart-bar': ChartBarIcon,
  'chart-pie': ChartPieIcon,
  'trending-up': TrendingUpIcon,
  'trending-down': TrendingDownIcon,
  target: TargetIcon,
  shield: ShieldIcon,
  star: StarIcon,
  zap: ZapIcon,
  flame: FlameIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  layers: LayersIcon,
  tag: TagIcon,
};

const SHAPE_ICONS: Record<ViewShape, LucideIcon> = {
  table: TableIcon,
  group: ListTreeIcon,
  pivot: Grid3x3Icon,
};

/** A view's sidebar icon: its own pick (a lucide name or an emoji), else its shape's. */
export const viewIcon = (config: { icon?: ViewIcon | null; shape: ViewShape }): NavIcon => {
  const icon = config.icon;
  if (!icon) return SHAPE_ICONS[config.shape];
  if (icon in VIEW_ICONS) return VIEW_ICONS[icon as ViewIconName];
  if (/^[a-z]/.test(icon))
    return lucideNames.has(icon) ? lucideIcon(icon) : SHAPE_ICONS[config.shape];
  return emojiIcon(icon);
};

const lucideNames = new Set<string>(iconNames);
const made = new Map<string, NavIcon>();
/** One component per pick, so React keeps it between renders. */
const once = (key: string, make: () => NavIcon) => {
  let Icon = made.get(key);
  if (!Icon) {
    Icon = make();
    made.set(key, Icon);
  }
  return Icon;
};

/** Any lucide icon by name, loaded on first use (lucide's own DynamicIcon). */
export const lucideIcon = (name: string): NavIcon =>
  once(
    `lucide:${name}`,
    () => (props) => createElement(DynamicIcon, { name: name as IconName, ...props }),
  );

/** An emoji drawn where an icon goes. */
export const emojiIcon = (emoji: string): NavIcon =>
  once(
    `emoji:${emoji}`,
    () =>
      ({ className }) =>
        createElement(
          'span',
          {
            'aria-hidden': true,
            'data-slot': 'view-emoji',
            className: cn(
              'inline-grid size-4 shrink-0 place-items-center text-sm leading-none',
              className,
            ),
          },
          emoji,
        ),
  );

/** Every lucide icon name, for the icon picker's search. */
export { iconNames as lucideIconNames };

/** A shape's own icon (the Edit dialog's Shape picker). */
export const shapeIcon = (shape: ViewShape) => SHAPE_ICONS[shape];
