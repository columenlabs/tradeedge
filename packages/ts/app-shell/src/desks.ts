import { ChartSplineIcon, DatabaseIcon, FlaskConicalIcon, type LucideIcon } from 'lucide-react';

export type DeskId = 'data' | 'research' | 'trade';

export interface Desk {
  id: DeskId;
  /** The desk's name everywhere: switcher, Settings, browser tab (Bikram, 2026-10-08). */
  label: string;
  /** The label before "Edge", drawn in the app's accent beside a gold "Edge" (Bikram, 2026-10-10). */
  prefix: string;
  icon: LucideIcon;
  /** Where the desk's home opens. */
  href: string;
}

/** The suite, in its flow: data ingests and curates, research works on history, trade on live data. */
export const DESKS: Desk[] = [
  {
    id: 'data',
    label: 'DataEdge',
    prefix: 'Data',
    icon: DatabaseIcon,
    href: 'https://data.edgedesk.app/',
  },
  {
    id: 'research',
    label: 'ResearchEdge',
    prefix: 'Research',
    icon: FlaskConicalIcon,
    href: 'https://research.edgedesk.app/',
  },
  {
    id: 'trade',
    label: 'TradeEdge',
    prefix: 'Trade',
    icon: ChartSplineIcon,
    href: 'https://trade.edgedesk.app/app/',
  },
];

export const deskOf = (id: DeskId): Desk => DESKS.find((d) => d.id === id) ?? (DESKS[0] as Desk);

/**
 * The apps the switcher lists: the whole suite on its own hosts (and local dev), only this app
 * on a self-hosted copy, where the other apps don't exist.
 */
export function appsHere(current: Desk): Desk[] {
  const host = typeof location === 'undefined' ? 'edgedesk.app' : location.hostname;
  return /(^|\.)edgedesk\.app$/.test(host) || host === 'localhost' || host === '127.0.0.1'
    ? DESKS
    : [{ ...current, href: '/' }];
}
