// The page frame (Bikram, 2026-10-08): a fixed-height header (sidebar toggle, breadcrumb, actions)
// and the body, with the shell's gutter, section gap and max width. Pages never set their own outer
// padding or header. On phone the actions stay in the bar as icons and a back chevron replaces the trail.
import { Link, useRouter } from '@tanstack/react-router';
import { ChevronLeftIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './lib/utils';
import { setPref, usePrefs } from './prefs';
import { useShell } from './shell';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './ui/breadcrumb';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { SidebarTrigger, useSidebar } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export interface Crumb {
  label: ReactNode;
  /** Where the crumb links; the last crumb is the page itself and never links. */
  to?: string;
  /** Text for the phone back button and keys when `label` is not plain text. */
  name?: string;
}

const crumbName = (c: Crumb) => c.name ?? (typeof c.label === 'string' ? c.label : '');

export interface PageHeaderProps {
  crumbs: Crumb[];
  /** Header buttons, `sm` or `icon-sm`, each with an icon; phone shows the icons only. */
  actions?: ReactNode;
  /** A short status line beside the breadcrumb (under the title on phone). */
  meta?: ReactNode;
  /** This page's status bar items (`StatusItem`), shown after the desk's own. */
  status?: ReactNode;
}

/** The fixed-height header; `Page` renders it, or a page with several states renders it itself. */
export function PageHeader({ crumbs, actions, meta, status }: PageHeaderProps) {
  const router = useRouter();
  const { statusSlot, refresh, refreshing, hideAmounts } = useShell();
  const hidden = usePrefs().hideAmounts;
  const { isMobile } = useSidebar();
  const parent = [...crumbs.slice(0, -1)].reverse().find((c) => c.to);
  const current = crumbs[crumbs.length - 1];
  return (
    <>
      <header
        data-slot="shell-header"
        className="sticky top-0 z-20 flex h-(--shell-header-height) shrink-0 items-center gap-2 overflow-hidden border-b bg-background px-(--shell-gutter)"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="-ml-1" />
          </TooltipTrigger>
          <TooltipContent>Toggle sidebar</TooltipContent>
        </Tooltip>
        <Separator
          orientation="vertical"
          className="hidden data-vertical:h-4 data-vertical:self-center md:block"
        />
        {parent && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={`Back to ${crumbName(parent)}`}
            onClick={() => router.navigate({ to: parent.to })}
          >
            <ChevronLeftIcon />
          </Button>
        )}
        {!isMobile && (
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {crumbs.map((c, i) => (
                <Fragment key={`${i}-${crumbName(c)}`}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {c.to && i < crumbs.length - 1 ? (
                      <BreadcrumbLink asChild>
                        <Link to={c.to}>{c.label}</Link>
                      </BreadcrumbLink>
                    ) : i === crumbs.length - 1 ? (
                      <BreadcrumbPage className="truncate">
                        <h1 className="flex min-w-0 items-center gap-2 truncate font-semibold">
                          {c.label}
                        </h1>
                      </BreadcrumbPage>
                    ) : (
                      <span className="truncate">{c.label}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        {isMobile && (
          <div className="min-w-0">
            <h1 className="flex min-w-0 items-center gap-2 truncate text-sm leading-tight font-semibold">
              {current?.label}
            </h1>
            {meta && (
              <div className="flex items-center gap-1.5 truncate text-[11px] leading-tight text-muted-foreground">
                {meta}
              </div>
            )}
          </div>
        )}
        {meta && !isMobile && (
          <div className="ml-1 hidden min-w-0 shrink items-center gap-2 truncate border-l pl-3 text-xs text-muted-foreground md:flex">
            {meta}
          </div>
        )}
        {actions && (
          <div
            data-slot="shell-actions"
            className={cn(
              'ml-auto flex shrink-0 items-center gap-2',
              // Phone: the same buttons in the bar, icons only; their text stays as the accessible name.
              isMobile &&
                'gap-1 [&_[data-slot=button]]:size-8 [&_[data-slot=button]]:gap-0 [&_[data-slot=button]]:px-0 [&_[data-slot=button]]:text-[0px]',
            )}
          >
            {actions}
          </div>
        )}
        {hideAmounts && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('shrink-0', !actions && 'ml-auto')}
                aria-label={hidden ? 'Show amounts' : 'Hide amounts'}
                aria-pressed={hidden}
                onClick={() => setPref('hideAmounts', !hidden)}
              >
                {hidden ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hidden ? 'Show amounts' : 'Hide amounts'}</TooltipContent>
          </Tooltip>
        )}
        {refresh && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('shrink-0', !actions && !hideAmounts && 'ml-auto')}
                aria-label="Refresh (skip cache)"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh (skip cache)</TooltipContent>
          </Tooltip>
        )}
      </header>
      {status && statusSlot && createPortal(status, statusSlot)}
    </>
  );
}

/** The page body: the shell's gutter, section gap and max width. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <main
      className={cn(
        'mx-auto flex w-full max-w-(--shell-max-width) min-w-0 flex-1 flex-col gap-(--shell-section-gap) p-(--shell-gutter)',
        className,
      )}
    >
      {children}
    </main>
  );
}

export function Page({
  className,
  children,
  ...header
}: PageHeaderProps & { className?: string; children: ReactNode }) {
  return (
    <>
      <PageHeader {...header} />
      <PageBody className={className}>{children}</PageBody>
    </>
  );
}
