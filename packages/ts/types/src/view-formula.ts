// Formula columns (Bikram, 2026-10-09): a custom view computes its own columns from the domain's
// fields. Expressions are Jexl (an interpreter, no eval, so it also runs in the Worker), e.g.
// `market_value / group_sum("market_value") * 100`. Identifiers are the domain's field keys (and the
// view's earlier formula keys); group_sum("key") and total_sum("key") add a field over the row's
// group (every shown row when not grouped) and over every shown row.
import jexl from 'jexl';

/** What a formula can read for one row. */
export interface ViewFormulaScope {
  /** A field's value on the row; null when it has none. */
  value: (key: string) => number | string | null;
  groupSum: (key: string) => number;
  totalSum: (key: string) => number;
}

export const viewFormulaFunctions = ['group_sum', 'total_sum'] as const;

// Functions get only their arguments, so the row being evaluated is set around each evalSync
// (evaluation is synchronous, so one at a time).
let current: ViewFormulaScope | null = null;
const engine = new jexl.Jexl();
engine.addFunction('group_sum', (key: unknown) =>
  typeof key === 'string' && current ? current.groupSum(key) : Number.NaN,
);
engine.addFunction('total_sum', (key: unknown) =>
  typeof key === 'string' && current ? current.totalSum(key) : Number.NaN,
);

const scopeContext = (scope: ViewFormulaScope) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_, name) => (typeof name === 'string' ? (scope.value(name) ?? undefined) : undefined),
  });

/** Compiles a formula (throws on a syntax error) into a row evaluator; a failed row is null. */
export function compileViewFormula(expr: string) {
  const compiled = engine.compile(expr);
  return (scope: ViewFormulaScope): number | string | null => {
    current = scope;
    try {
      const v: unknown = compiled.evalSync(scopeContext(scope));
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    } finally {
      current = null;
    }
  };
}

/** Why a formula can't run on fields `keys` (null: any field), or null when it can. */
export function checkViewFormula(expr: string, keys: string[] | null): string | null {
  let run: ReturnType<typeof compileViewFormula>;
  try {
    run = compileViewFormula(expr);
  } catch (e) {
    return `syntax: ${e instanceof Error ? e.message : String(e)}`;
  }
  const unknown = new Set<string>();
  const known = (k: string) => {
    if (keys && !keys.includes(k)) unknown.add(k);
    return 1;
  };
  run({ value: known, groupSum: known, totalSum: known });
  return unknown.size ? `unknown field ${[...unknown].join(', ')}` : null;
}
