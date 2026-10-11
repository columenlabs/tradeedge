// The icons a person can pick for a view (Bikram, 2026-10-09); names are `viewIconNames` in
// `@edgedesk/types/views`. A view without one shows its shape's icon.
import type { ViewIconName, ViewShape } from '@edgedesk/types/views';
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

/** A view's sidebar icon: its own pick, else its shape's. */
export const viewIcon = (config: { icon?: ViewIconName | null; shape: ViewShape }) =>
  (config.icon && VIEW_ICONS[config.icon]) || SHAPE_ICONS[config.shape];

/** A shape's own icon (the Edit dialog's Shape picker). */
export const shapeIcon = (shape: ViewShape) => SHAPE_ICONS[shape];
