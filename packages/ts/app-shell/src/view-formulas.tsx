// Formula columns and tiles on a custom view (Bikram, 2026-10-09): a view computes its own columns
// from the domain's fields (`config.formulas`, Jexl, `@edgedesk/types/views`) and rolls fields up
// into its own tiles (`config.tiles`). Each formula is a row of the Edit dialog's Fields list; its
// pencil opens this form under the row.
import {
  type ViewFormula,
  type ViewFormulaScope,
  type ViewTile,
  checkViewFormula,
  compileViewFormula,
  viewAggs,
  viewFormulaFormats,
} from '@edgedesk/types/views';
import { CheckIcon, CircleAlertIcon, SigmaIcon, Trash2Icon } from 'lucide-react';
import { ConfirmDelete } from './confirm';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { FORMULAS_GROUP, type ViewField } from './view-model';

export const MAX_FORMULAS = 20;
export const FORMAT_LABELS: Record<ViewFormula['format'], string> = {
  number: 'Number',
  price: 'Price',
  percent: 'Percent (signed)',
  weight: 'Weight (share)',
  signed: 'Signed',
  integer: 'Integer',
};
const NO_ROLLUP = '_none';

/** A view's formulas as fields: shown, sorted and rolled up like the domain's own. */
export function formulaFields<T>(formulas: ViewFormula[]): ViewField<T>[] {
  return formulas.map((f) => {
    let run: ((s: ViewFormulaScope) => number | string | null) | null;
    try {
      run = compileViewFormula(f.expr);
    } catch {
      run = null;
    }
    return {
      key: f.key,
      label: f.label,
      group: FORMULAS_GROUP,
      icon: SigmaIcon,
      value: () => null,
      format: f.format,
      formula: f.expr,
      // A formula can work out dollars from amounts; only a share (%) stays under Hide amounts.
      amount: f.format !== 'percent' && f.format !== 'weight',
      aggregate: f.agg ?? undefined,
      rollFormula: f.agg === null,
      compute: (_, scope) => (run ? run(scope) : null),
    };
  });
}

/** What is wrong with each formula against the domain's field keys; null where nothing. */
export function formulaIssues(formulas: ViewFormula[], keys: string[]): (string | null)[] {
  return formulas.map((f, i) => {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(f.key)) return 'Key: lowercase letters, digits and _';
    if (keys.includes(f.key) || formulas.slice(0, i).some((x) => x.key === f.key))
      return `Key ${f.key} is taken`;
    if (!f.label.trim()) return 'Give it a label';
    if (!f.expr.trim()) return 'Write an expression';
    return checkViewFormula(f.expr, [...keys, ...formulas.slice(0, i).map((x) => x.key)]);
  });
}

export const AGG_LABELS: Record<ViewTile['agg'], string> = {
  sum: 'Sum',
  mean: 'Average',
  min: 'Min',
  max: 'Max',
  count: 'Count',
  first: 'First',
  last: 'Last',
};
export const MAX_TILES = 8;

/** What is wrong with each tile against the view's fields and the domain's widget keys. */
export function tileIssues(tiles: ViewTile[], fields: string[], widgets: string[]) {
  return tiles.map((t, i) => {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(t.key)) return 'Key: lowercase letters, digits and _';
    if (widgets.includes(t.key) || tiles.slice(0, i).some((x) => x.key === t.key))
      return `Key ${t.key} is taken`;
    if (!t.label.trim()) return 'Give it a label';
    if (!fields.includes(t.field)) return `Pick a field (${t.field || 'none'} is not one)`;
    return null;
  });
}

/**
 * One formula's form, under its row in the Fields list: label and key, the expression with the
 * keys it can read one click away, its format and how group and Total rows roll it up.
 */
export function FormulaForm({
  formula: f,
  issue,
  keys,
  onChange,
  onRemove,
  onDone,
}: {
  formula: ViewFormula;
  issue: string | null;
  /** The field keys and earlier formula keys it can read. */
  keys: string[];
  onChange: (p: Partial<ViewFormula>) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const id = `formula-${f.key}`;
  const insert = (text: string) => onChange({ expr: f.expr ? `${f.expr} ${text}` : text });
  return (
    <div className="col-span-full grid gap-3 border-t bg-muted/30 px-3 py-3 md:pl-10">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-label`}>Label</Label>
          <Input
            id={`${id}-label`}
            value={f.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-key`}>Key</Label>
          <Input
            id={`${id}-key`}
            className="font-mono text-xs"
            value={f.key}
            onChange={(e) => onChange({ key: e.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-expr`}>Expression</Label>
        <Textarea
          id={`${id}-expr`}
          rows={2}
          aria-invalid={issue ? true : undefined}
          className="min-h-16 font-mono text-xs"
          placeholder={'market_value / group_sum("market_value") * 100'}
          value={f.expr}
          onChange={(e) => onChange({ expr: e.target.value })}
        />
        {issue ? (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <CircleAlertIcon className="size-3.5" />
            {issue}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-gain">
            <CheckIcon className="size-3.5" />
            Reads fine
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Insert a field key">
        {[...keys, 'group_sum("")', 'total_sum("")'].map((k) => (
          <Button
            key={k}
            variant="outline"
            size="xs"
            className="font-mono font-normal text-muted-foreground"
            onClick={() => insert(k)}
          >
            {k}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label>Format</Label>
          <Select
            value={f.format}
            onValueChange={(v) => onChange({ format: v as ViewFormula['format'] })}
          >
            <SelectTrigger aria-label="Format" size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {viewFormulaFormats.map((x) => (
                <SelectItem key={x} value={x}>
                  {FORMAT_LABELS[x]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Group and Total rows</Label>
          <Select
            value={f.agg ?? NO_ROLLUP}
            onValueChange={(v) =>
              onChange({ agg: v === NO_ROLLUP ? null : (v as ViewFormula['agg']) })
            }
          >
            <SelectTrigger aria-label="Group and Total rows" size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ROLLUP}>Same formula</SelectItem>
              {viewAggs.map((a) => (
                <SelectItem key={a} value={a}>
                  {AGG_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex gap-2">
          <ConfirmDelete
            title={`Remove formula ${f.label || f.key}?`}
            description="It leaves this view when you save."
            action="Remove"
            onConfirm={onRemove}
          >
            <Button variant="destructive" size="sm">
              <Trash2Icon />
              Remove
            </Button>
          </ConfirmDelete>
          <Button variant="outline" size="sm" onClick={onDone}>
            <CheckIcon />
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
