// Request bodies for every API route, in one place so the app and tests share the shapes.
import { z } from 'zod';
import {
  type ViewGrouped,
  type ViewPivoted,
  type ViewToken,
  viewFilterSchema,
  viewGroupSchema,
  viewIconNames,
  viewPivotSchema,
  viewShapes,
} from './views';

const num = z.number().nullable().optional();

export const foldSchema = z.object({
  fold: z.number().int(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  sharpe: num,
  cagr: num,
  max_dd: num,
  trades: z.number().int().nullable().optional(),
  win_rate: num,
  profit_factor: num,
  exposure: num,
});

export const trialSchema = z.object({
  id: z.string().min(1).optional(),
  number: z.number().int(),
  state: z.enum(['complete', 'pruned', 'failed']).default('complete'),
  kind: z.enum(['search', 'seed', 'neighbour']).default('search'),
  params: z.record(z.string(), z.unknown()),
  robust_score: num,
  is_sharpe: num,
  dsr: num,
  fragile: z.boolean().or(z.number().int()).optional(),
  gates_passed: z.boolean().or(z.number().int()).optional(),
  metrics: z.record(z.string(), z.unknown()).default({}),
  /** Omitted: the stored folds stay (the engine's final pass re-sends scores without them). */
  folds: z.array(foldSchema).optional(),
});

/** Trials per upload: small enough for the Workers Free 10 ms CPU budget. */
export const MAX_TRIALS_PER_BATCH = 50;
export const uploadSchema = z
  .object({ trials: z.array(trialSchema).min(1).max(MAX_TRIALS_PER_BATCH) })
  .refine(
    (b) => new Set(b.trials.map((t) => t.number)).size === b.trials.length,
    'trial numbers repeat within the batch',
  );
export const candidateSchema = z.object({ note: z.string().optional() }).default({});

/** The engine's playbook slug, its folder name, e.g. `nine_sig` or `orb`. */
export const playbookIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** A connected repo, `owner/name`, and a path inside it. */
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const repoPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'path stays inside the repo');
/** The parked Experiment: an experiment manifest in the playbook's folder and the settings it runs with. */
export const experimentSpecSchema = z.object({
  path: repoPathSchema,
  body: z.record(z.string(), z.unknown()),
});

/**
 * `POST /api/playbooks`: a playbook (`<folder>/playbook.py`). It names its repo, its folder in that
 * repo and its experiment manifests. Registering it again changes only the fields sent.
 */
export const playbookSchema = z.object({
  id: playbookIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  repo: repoSchema.optional(),
  folder: repoPathSchema.optional(),
  experiment_specs: z.array(experimentSpecSchema).max(50).optional(),
});

/** The repo commit an experiment or a tape ran at (a git SHA, full or abbreviated). */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/);

/** A playbook's benchmark list: tickers drawn live from ClickHouse closes, never stored. */
const benchmarkSymbol = z.string().regex(/^[A-Z0-9][A-Z0-9.^-]{0,15}$/);
export const benchmarksSchema = z.array(benchmarkSymbol).max(8);
/** A playbook's tags: free words the Library filters by (Bikram 2026-10-10). */
export const playbookTagsSchema = z.array(z.string().trim().min(1).max(30)).max(20);

/** `PATCH /api/playbooks/:id`: any of its fields, archive or restore, pin, tags and benchmarks. */
export const playbookPatchSchema = playbookSchema
  .omit({ id: true })
  .partial()
  .extend({
    archived: z.boolean().optional(),
    benchmarks: benchmarksSchema.optional(),
    /** Pinned playbooks show in the sidebar. */
    pinned: z.boolean().optional(),
    tags: playbookTagsSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');

export const archiveResponseSchema = z.object({
  playbooks: z.array(z.object({ id: z.string(), name: z.string() })),
  experiments: z.array(
    z.object({
      id: z.string(),
      playbook_id: z.string(),
      playbook_name: z.string(),
      status: z.string(),
    }),
  ),
});
export type ArchiveResponse = z.infer<typeof archiveResponseSchema>;

export const archivePatchSchema = z.object({ archived: z.boolean() });

export const versionSchema = z.object({
  label: z.string().min(1).max(100),
  git_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  engine_version: z.string().min(1).max(100),
  /** The playbook's pydantic params model as JSON Schema. */
  param_schema: z.record(z.string(), z.unknown()),
  changelog: z.string().max(10000).optional(),
});

export type TrialInput = z.infer<typeof trialSchema>;
export type PlaybookInput = z.infer<typeof playbookSchema>;
export type VersionInput = z.infer<typeof versionSchema>;

// Response shapes the app reads; the Worker builds these rows in SQL.
const nullableNumber = z.number().nullable();
export const playbookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  archived: z.number().int(),
  created_at: z.string(),
  latest_version: z.string().nullable(),
  best_robust: nullableNumber,
  experiment_count: z.number().int(),
  last_run: z.string().nullable(),
  /** Every counted trial of every experiment of every version (complete, pruned, neighbourhood). */
  trial_count: z.number().int(),
  benchmarks: benchmarksSchema.nullable().optional(),
  /** Where it runs from: the connected repo and the playbook's folder in it. */
  repo: z.string().nullable().optional(),
  folder: z.string().nullable().optional(),
  experiment_specs: z.array(experimentSpecSchema).nullable().optional(),
  pinned: z.number().int().optional(),
  tags: playbookTagsSchema.nullable().optional(),
  /** The knob menu the newest tape reported. */
  knobs: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  /** The newest commit touching the playbook's folder that variants were queued at. */
  code_sha: z.string().nullable().optional(),
  variant_count: z.number().int().optional(),
});
export const playbooksResponseSchema = z.object({ playbooks: z.array(playbookSummarySchema) });

export const playbookDetailResponseSchema = z.object({
  playbook: playbookSummarySchema.extend({ seconds_per_fold_symbol: nullableNumber }),
  versions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      git_sha: z.string().nullable(),
      engine_version: z.string().nullable(),
      param_schema: z.record(z.string(), z.unknown()).nullable(),
      changelog: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  experiments: z.array(
    z.object({
      id: z.string(),
      version_id: z.string(),
      status: z.string(),
      budget: z.number().int().nullable(),
      progress: z.number().int(),
      pruned_count: z.number().int(),
      created_at: z.string(),
      started_at: z.string().nullable(),
      finished_at: z.string().nullable(),
      best_trial_id: z.string().nullable(),
      best_robust: nullableNumber,
    }),
  ),
});

export type PlaybookSummary = z.infer<typeof playbookSummarySchema>;
export type PlaybookDetailResponse = z.infer<typeof playbookDetailResponseSchema>;

// Experiment search space: each key maps to one Optuna distribution. `when` makes a param conditional
// on another param's value.
const when = z.record(z.string(), z.unknown()).optional();
export const paramSpaceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('float'),
    low: z.number(),
    high: z.number(),
    log: z.boolean().optional(),
    step: z.number().positive().optional(),
    when,
  }),
  z.object({
    type: z.literal('int'),
    low: z.number().int(),
    high: z.number().int(),
    log: z.boolean().optional(),
    step: z.number().int().positive().optional(),
    when,
  }),
  z.object({
    type: z.literal('choice'),
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
    when,
  }),
  z.object({ type: z.literal('bool'), when }),
]);
export const searchSpaceSchema = z
  .record(z.string(), paramSpaceSchema)
  .refine((s) => Object.keys(s).length > 0, 'search space is empty');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** One anchored walk-forward fold, as `splits.walk_forward_folds` emits it. */
export const experimentFoldSchema = z.object({
  fold: z.number().int().min(1),
  fit_start: isoDate,
  fit_end: isoDate,
  validate_start: isoDate,
  validate_end: isoDate,
});

export const experimentSchema = z.object({
  version_id: z.string().min(1),
  symbols: z.array(z.string().min(1)).min(1),
  search_space: searchSpaceSchema,
  objective: z.record(z.string(), z.unknown()).optional(),
  dd_cap: z.number().positive().max(1).optional(),
  costs: z.record(z.string(), z.unknown()).optional(),
  folds: z.array(experimentFoldSchema).min(1),
  /** Fold numbers in run order; pruning judges after the first (2022 by default). */
  fold_order: z.array(z.number().int().min(1)).optional(),
  budget: z.number().int().min(1).max(5000),
  sampler: z.record(z.string(), z.unknown()).optional(),
  commit_sha: commitShaSchema.optional(),
});

export const proposalSchema = experimentSchema.extend({
  parent_experiment_id: z.string().min(1),
  proposal: z.object({
    reasoning: z.string().min(1),
    /** Facts from the parent's experiment report that the proposal relies on. */
    cites: z.array(z.string().min(1)).min(1),
    seeds: z.array(z.record(z.string(), z.unknown())).max(5).default([]),
  }),
  agent_cost_usd: z.number().min(0),
});

export const experimentPatchSchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel', 'start', 'finish', 'fail']),
  note: z.string().max(4000).optional(),
  data_snapshot: z.string().max(200).optional(),
});

const experimentStatusSchema = z.enum([
  'proposed',
  'ready',
  'running',
  'done',
  'failed',
  'cancelled',
]);
/** What `POST /api/experiments`, `POST /api/experiments/proposals` and `PATCH /api/experiments/:id` return. */
export const experimentStatusResponseSchema = z.object({
  id: z.string(),
  status: experimentStatusSchema,
});

const jsonObject = z.record(z.string(), z.unknown());
/** One row of `GET /api/experiments`: the stored experiment with its JSON columns parsed. */
export const experimentRowSchema = z.object({
  id: z.string(),
  version_id: z.string(),
  playbook_id: z.string(),
  playbook_name: z.string(),
  version_label: z.string(),
  status: experimentStatusSchema,
  symbols: z.array(z.string()).nullable(),
  search_space: jsonObject.nullable(),
  objective: jsonObject.nullable(),
  dd_cap: nullableNumber,
  costs: jsonObject.nullable(),
  folds: z.array(jsonObject).nullable(),
  fold_order: z.array(z.number().int()).nullable(),
  budget: z.number().int().nullable(),
  sampler: jsonObject.nullable(),
  progress: z.number().int(),
  pruned_count: z.number().int(),
  neighbour_count: z.number().int(),
  best_trial_id: z.string().nullable(),
  proposed_by: z.enum(['user', 'engine', 'agent']).nullable(),
  parent_experiment_id: z.string().nullable(),
  proposal: jsonObject.nullable(),
  agent_cost_usd: nullableNumber,
  data_snapshot: z.string().nullable(),
  commit_sha: z.string().nullable(),
  status_note: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export const experimentResponseSchema = z.object({ experiments: z.array(experimentRowSchema) });
export type ExperimentRow = z.infer<typeof experimentRowSchema>;

export type ParamSpace = z.infer<typeof paramSpaceSchema>;
export type ExperimentInput = z.infer<typeof experimentSchema>;

// Trial and shortlist response shapes.
/** One stored trial, JSON columns parsed (leaderboard rows). */
export const trialRowSchema = z.object({
  id: z.string(),
  experiment_id: z.string(),
  number: z.number().int(),
  params: jsonObject.nullable(),
  state: z.enum(['complete', 'pruned', 'failed']),
  kind: z.enum(['search', 'seed', 'neighbour']),
  robust_score: nullableNumber,
  is_sharpe: nullableNumber,
  median_sharpe: nullableNumber,
  worst_sharpe: nullableNumber,
  dsr: nullableNumber,
  fragile: z.number().int(),
  gates_passed: z.number().int(),
  metrics: jsonObject.nullable(),
  created_at: z.string(),
});
export const trialUploadResponseSchema = z.object({
  upserted: z.number().int(),
  trials: z.array(z.object({ id: z.string(), number: z.number().int() })),
});
export const trialsPageResponseSchema = z.object({
  sort: z.enum(['robust', 'median', 'worst', 'is_sharpe']),
  trials: z.array(trialRowSchema),
  next_cursor: z.string().nullable(),
});
export const heatmapResponseSchema = z.object({
  x: z.object({ param: z.string(), labels: z.array(z.string()) }),
  y: z.object({ param: z.string(), labels: z.array(z.string()) }),
  cells: z.array(
    z.object({
      xi: z.number().int(),
      yi: z.number().int(),
      count: z.number().int(),
      median: z.number(),
      best: z.number(),
      best_trial_id: z.string(),
    }),
  ),
});
/** A 409 or 422 that names the offending trials in an upload. */
export const trialNumbersErrorSchema = z.object({
  error: z.string(),
  trial_numbers: z.array(z.number().int()),
});

export const runsResponseSchema = z.object({
  runs: z.array(
    z.object({
      trial_id: z.string(),
      experiment_id: z.string(),
      note: z.string().nullable(),
      promoted_at: z.string(),
      number: z.number().int(),
      params: jsonObject.nullable(),
      robust_score: nullableNumber,
      worst_sharpe: nullableNumber,
      playbook_id: z.string(),
      playbook_name: z.string(),
      version_label: z.string(),
    }),
  ),
});

export type TrialRow = z.infer<typeof trialRowSchema>;
export type HeatmapResponse = z.infer<typeof heatmapResponseSchema>;
export type RunsResponse = z.infer<typeof runsResponseSchema>;

// Run series blobs (equity, trades, time of day) and the trial detail that lists them.
const blobKindSchema = z.enum(['equity', 'trades', 'tod']);
export const blobUploadResponseSchema = z.object({
  kind: blobKindSchema,
  bytes: z.number().int(),
  first_date: z.string(),
  last_date: z.string(),
});
export const blobInfoSchema = blobUploadResponseSchema.extend({ uploaded_at: z.string() });

export const trialFoldRowSchema = z.object({
  trial_id: z.string(),
  fold: z.number().int(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  sharpe: nullableNumber,
  cagr: nullableNumber,
  max_dd: nullableNumber,
  trades: z.number().int().nullable(),
  win_rate: nullableNumber,
  profit_factor: nullableNumber,
  exposure: nullableNumber,
});
export const trialDetailResponseSchema = z.object({
  trial: trialRowSchema,
  folds: z.array(trialFoldRowSchema),
  is_candidate: z.boolean(),
  blobs: z.array(blobInfoSchema),
});

export type TrialDetailResponse = z.infer<typeof trialDetailResponseSchema>;

/** `GET /api/experiments/:id`: the experiment and its top 50 trials by robust score. */
export const experimentDetailResponseSchema = z.object({
  experiment: experimentRowSchema,
  trials: z.array(trialRowSchema.extend({ worst_fold: nullableNumber, max_dd: nullableNumber })),
});
/** Every 4xx carries `error`; a 422 on an experiment body also lists every `problems` entry. */
export const apiErrorSchema = z.object({
  error: z.string(),
  problems: z.array(z.string()).optional(),
});

export type ExperimentDetailResponse = z.infer<typeof experimentDetailResponseSchema>;

// Run-series blob bodies (gzip JSON in R2). The Worker never parses them (10 ms CPU on Workers
// Free); the engine writes these shapes (results-api PR 6) and the run visualizer reads them.
const blobDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** `equity`: one point per session close (US/Eastern trading date), ascending by date; equity starts at 1.0. */
export const equityBlobSchema = z.object({
  points: z.array(
    z.object({
      date: blobDate,
      equity: z.number(),
      /** Each symbol's leg as its own equity multiple, for the per-symbol toggle. */
      symbols: z.record(z.string(), z.number()).optional(),
    }),
  ),
});
/** `trades`: every stored trade; timestamps are UTC ISO strings. */
export const tradesBlobSchema = z.object({
  trades: z.array(
    z.object({
      symbol: z.string(),
      side: z.enum(['long', 'short']),
      entry_ts: z.iso.datetime(),
      exit_ts: z.iso.datetime(),
      /** Trade return as a fraction of equity. */
      ret: z.number(),
      /** Return in multiples of the initial risk, when the playbook defines one. */
      r: z.number().nullable().optional(),
    }),
  ),
});
/** `tod`: total P&L by entry slot (US/Eastern `HH:MM`), as a fraction of equity. */
export const todBlobSchema = z.object({
  slots: z.array(z.object({ slot: z.string(), pnl: z.number(), trades: z.number().int() })),
});

/** A ticker as ClickHouse `market_lab` stores it (Compare's `GET /api/prices/:symbol`). */
export const priceSymbol = z.string().regex(/^[A-Z0-9][A-Z0-9.^-]{0,15}$/);
/** `GET /api/prices`: every symbol with daily bars. */
export const priceSymbolsSchema = z.object({ symbols: z.array(z.string()) });
/** `GET /api/prices/:symbol`: split and dividend adjusted daily closes, oldest first. */
export const priceSeriesSchema = z.object({
  symbol: z.string(),
  points: z.array(z.tuple([z.string(), z.number()])),
});
/** `GET /api/playbooks/:id/code?commit=`: the playbook folder's files at the run's commit, read
 * live from GitHub through the researchedge App (nothing is stored). */
export const codeTreeSchema = z.object({
  repo: z.string(),
  commit: z.string(),
  root: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.number().int().nullable() })),
});
/** `GET /api/playbooks/:id/code/file?commit=&path=`: one text file, read-only. */
export const codeFileSchema = z.object({ path: z.string(), content: z.string() });
/** `GET /api/playbooks/:id/commits`: newest first; empty when the repo is not connected. */
export const repoCommitsSchema = z.object({
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), date: z.string().nullable() })),
});
export type RepoCommits = z.infer<typeof repoCommitsSchema>;
export type CodeTree = z.infer<typeof codeTreeSchema>;
export type CodeFile = z.infer<typeof codeFileSchema>;
export type PriceSymbols = z.infer<typeof priceSymbolsSchema>;
export type PriceSeries = z.infer<typeof priceSeriesSchema>;

export type EquityBlob = z.infer<typeof equityBlobSchema>;
export type TradesBlob = z.infer<typeof tradesBlobSchema>;
export type TodBlob = z.infer<typeof todBlobSchema>;
export type BlobKind = z.infer<typeof blobKindSchema>;

/**
 * Jobs: `POST /api/jobs` runs one of a playbook's experiment manifests at a ref. Never a path or a
 * command the caller makes up. Variant runs are queued by `POST /api/variants/run`.
 */
export const jobCreateSchema = z.object({
  playbook: playbookIdSchema,
  /** Which of the playbook's experiment manifests. */
  manifest: repoPathSchema,
  /** The repo ref the runner resolves to a commit (default `main`). */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,100}$/)
    .optional(),
});
export const jobRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['experiment', 'variant']),
  /** A variant job: the variant it runs. */
  variant_id: z.string().nullable().optional(),
  playbook_id: z.string().nullable().optional(),
  manifest: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed']),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  /** Runner jobs (step 8): the playbook commit it ran, its progress and the last log lines. */
  commit_sha: z.string().nullable().optional(),
  /** The platform repo commit the runner built the engine from (step 8f). */
  engine_commit_sha: z.string().nullable().optional(),
  progress: z.number().int().nullable().optional(),
  log_tail: z.string().nullable().optional(),
});
/** `GET /api/jobs?playbook=`: the playbook's newest jobs. */
export const jobsResponseSchema = z.object({ jobs: z.array(jobRowSchema) });
export type JobRow = z.infer<typeof jobRowSchema>;
export type JobsResponse = z.infer<typeof jobsResponseSchema>;

/**
 * What the runner's `GET /jobs/:id` returns (step 8). A finished job lists `reports`: the same API
 * calls the engine made itself before (register, report trials, put a tape). The Worker replays them
 * in-process, only those on the report allowlist (`runner.ts`), so readers see the usual rows and R2 keys.
 * A report with `file` carries that runner file as its body (`GET /jobs/:id/files/:name`).
 */
export const runnerReportSchema = z.object({
  method: z.enum(['POST', 'PUT', 'PATCH']),
  path: z
    .string()
    .regex(/^\/api\/[A-Za-z0-9._~@\/-]+$/)
    // A dot segment would let the URL parser reach a route the allowlist never matched.
    .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..'), 'no dot segments'),
  json: z.record(z.string(), z.unknown()).optional(),
  file: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .optional(),
  headers: z
    .object({ 'X-Date-Range': z.string().max(40), 'X-Content-SHA256': z.string().max(64) })
    .partial()
    .optional(),
});
export type RunnerReport = z.infer<typeof runnerReportSchema>;
export const runnerStatusSchema = z.object({
  state: z.enum(['queued', 'running', 'done', 'failed']),
  progress: z.number().int().min(0).optional(),
  log_tail: z.string().max(20_000).optional(),
  error: z.string().max(2000).optional(),
  /** The full commit SHA the runner resolved the ref to. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** The full commit SHA of the platform repo the engine was built from (step 8f). */
  engine_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  result: z
    .object({
      reports: z.array(runnerReportSchema).max(1500),
      /** Where the caller continues (`GET /jobs/:id?from=N`). */
      next: z.number().int().min(0).optional(),
      /** Runner file holding the full log (`log.txt.gz`). */
      log: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,100}$/)
        .optional(),
    })
    .optional(),
});
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

/** A repo connected through the researchedge GitHub App (step 8f). */
export const repoLinkSchema = z.object({
  repo: z.string(),
  linked_by: z.string(),
  created_at: z.string(),
  /** How many playbooks run from this repo. */
  playbooks: z.number().int(),
  /** GitHub's page for the install this repo came through (pick repos, or uninstall). */
  manage_url: z.string().nullable(),
});
/** `GET /api/repos`: `configured` is false until the App exists; then nothing can be linked. */
export const reposResponseSchema = z.object({
  configured: z.boolean(),
  repos: z.array(repoLinkSchema),
  /** GitHub's page for managing the App's install, once there is one. */
  manage_url: z.string().nullable(),
});
export const repoConnectResponseSchema = z.object({ url: z.string() });
export const repoTreeResponseSchema = z.object({
  branch: z.string(),
  manifests: z.array(z.string()),
});
export type RepoLink = z.infer<typeof repoLinkSchema>;
export type ReposResponse = z.infer<typeof reposResponseSchema>;
export type RepoTreeResponse = z.infer<typeof repoTreeResponseSchema>;

/** Explorer views (Bikram, 2026-10-07): a named table of daily rows; each column is a formula. */
export const EXPLORER_MAX_COLUMNS = 20;
export const explorerRangePresets = ['1m', '3m', '6m', '1y', '2y', '5y', 'all'] as const;
/** A preset counted back from the latest bar, or fixed dates (no `to` = the latest bar). */
export const explorerRangeSchema = z.union([
  z.enum(explorerRangePresets),
  z
    .object({ from: isoDate, to: isoDate.optional() })
    .refine((r) => !r.to || r.to >= r.from, 'to is before from'),
]);
/** How a column's numbers read: percent and signed carry a sign and gain/loss colour. */
export const explorerFormats = ['number', 'price', 'percent', 'signed', 'integer'] as const;
const explorerKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'key: lowercase letters, digits and _');
export const explorerColumnSchema = z.object({
  /** What other columns call this one in their formulas. */
  key: explorerKey,
  label: z.string().trim().min(1).max(40),
  formula: z.string().trim().min(1).max(400),
  format: z.enum(explorerFormats).default('number'),
  /** A hidden column still feeds other formulas; the table and CSV leave it out. */
  hidden: z.boolean().default(false),
});
/** A view parameter: formulas write `{key}` and each read fills it (its default unless given). */
export const explorerParamKinds = ['symbol', 'number'] as const;
export const EXPLORER_SYMBOL = /^[A-Z0-9$^.]{1,16}$/;
export const EXPLORER_NUMBER = /^-?\d{1,9}(\.\d{1,6})?$/;
export const explorerParamSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'key: lowercase letters, digits and _'),
    label: z.string().trim().min(1).max(40),
    kind: z.enum(explorerParamKinds).default('symbol'),
    default: z.string().trim().min(1).max(16),
  })
  .refine(
    (p) => (p.kind === 'symbol' ? EXPLORER_SYMBOL : EXPLORER_NUMBER).test(p.default),
    'default is not a valid value for its kind',
  );
const keysUnique = (xs: { key: string }[]) => new Set(xs.map((x) => x.key)).size === xs.length;
/** Everything a view keeps besides its name, range and columns (one JSON column in D1). */
export const explorerLayoutSchema = z.object({
  params: z.array(explorerParamSchema).max(5).default([]),
  /** How the view shows its rows (its sidebar icon); a read may ask for another. */
  shape: z.enum(viewShapes).default('table'),
  /** The sidebar icon a person picked; null = the shape's. */
  icon: z.enum(viewIconNames).nullable().default(null),
  group: viewGroupSchema.prefault({}),
  pivot: viewPivotSchema.prefault({}),
  filters: viewFilterSchema.prefault({}),
});
export type ExplorerLayout = z.infer<typeof explorerLayoutSchema>;
export const explorerViewSchema = explorerLayoutSchema
  .extend({
    name: z.string().trim().min(1).max(80),
    range: explorerRangeSchema.default('3m'),
    columns: z.array(explorerColumnSchema).min(1).max(EXPLORER_MAX_COLUMNS),
  })
  .refine((v) => keysUnique(v.columns), 'column keys repeat')
  .refine((v) => keysUnique(v.params), 'parameter keys repeat');
/** `PATCH /api/explorer-views/:id`: any of the fields; columns and params are replaced as a whole. */
export const explorerViewPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    range: explorerRangeSchema.optional(),
    columns: z.array(explorerColumnSchema).min(1).max(EXPLORER_MAX_COLUMNS).optional(),
    params: z.array(explorerParamSchema).max(5).optional(),
    shape: z.enum(viewShapes).optional(),
    icon: z.enum(viewIconNames).nullable().optional(),
    group: viewGroupSchema.optional(),
    pivot: viewPivotSchema.optional(),
    filters: viewFilterSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change')
  .refine((b) => !b.columns || keysUnique(b.columns), 'column keys repeat')
  .refine((b) => !b.params || keysUnique(b.params), 'parameter keys repeat');
export type ExplorerRange = z.infer<typeof explorerRangeSchema>;
export type ExplorerColumn = z.infer<typeof explorerColumnSchema>;
export type ExplorerParam = z.infer<typeof explorerParamSchema>;
export type ExplorerView = z.infer<typeof explorerViewSchema>;
/** A saved explorer view (`GET /api/explorer-views/:id`). */
export type ExplorerViewRow = ExplorerView & { id: string; created_at: string; updated_at: string };
/** One value per column: a number, a `span(a, b)` pair, or null where a day has no data. */
export type ExplorerValue = number | null | [number | null, number | null];
/** `GET /api/explorer-views/:id/rows`: rows newest first, computed live. */
export interface ExplorerRowsResponse {
  id: string;
  name: string;
  updated_at: string;
  from: string;
  to: string;
  columns: ExplorerColumn[];
  /** Rows left after the filters. */
  total: number;
  rows: { date: string; values: ExplorerValue[] }[];
  /** The parameter values this read used. */
  params: Record<string, string>;
  /** The filter tokens this read used (the view's defaults unless the read sent others). */
  filters: ViewToken[];
  /** The rows rolled up, when the read asked for `group` or `pivot`. */
  shaped?: ViewGrouped | ViewPivoted;
  /** ClickHouse's own time for the query, and the Worker's whole time for the read (checks, catalog, query). */
  timing: { clickhouse_ms: number; total_ms: number };
}

/** Rows as CSV: a header of `date` and the column keys, numbers as they are, a span as `a;b`, no data empty. */
export function explorerCsv(
  columns: Pick<ExplorerColumn, 'key'>[],
  rows: { date: string; values: ExplorerValue[] }[],
): string {
  const cell = (v: ExplorerValue) =>
    Array.isArray(v) ? v.map((x) => x ?? '').join(';') : v === null ? '' : String(v);
  return [
    ['date', ...columns.map((c) => c.key)],
    ...rows.map((r) => [r.date, ...r.values.map(cell)]),
  ]
    .map((r) => r.join(','))
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Overview (Bikram, 2026-10-10): service health, read live. Nothing here is stored.

/** What the runner's `GET /health` says about itself (bchoor/strategies `runner/http.py`). */
export interface RunnerHealth {
  ok: boolean;
  cpu?: { percent: number | null; cores: number | null };
  memory?: { anon_bytes: number | null; max_bytes: number | null };
  disk?: { free_bytes: number; total_bytes: number };
  uptime_s?: number;
  engine_commit?: string | null;
  job?: { id: string; kind: string; started_at: string | null } | null;
}

/**
 * `GET /api/runner/health`: the runner's health with the Worker's round trip to it as `latency_ms`,
 * or `{ ok: false, error }` when it is unreachable.
 */
export type RunnerHealthResponse =
  | (RunnerHealth & { latency_ms: number | null })
  | { ok: false; error: string };

/** `GET /api/overview`: the Queue and Results stages (the Runner stage polls its own route). */
export interface OverviewResponse {
  queue: {
    queued: number;
    running: number;
    failed_24h: number;
    sent_24h: { count: number; first: string | null; last: string | null };
  };
  /** The newest started runner jobs, newest first. */
  recent: {
    id: string;
    kind: string;
    state: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    wait_s: number | null;
    run_s: number | null;
    label: string | null;
    playbook_name: string | null;
  }[];
  /** Runner jobs that ran in the last 24 h (`end` null while running). */
  busy: { start: string; end: string | null }[];
  results: {
    done_24h: number;
    failed_24h: number;
    playbooks_24h: number;
    /** Variants of live playbooks, and how many have run. */
    variants: number;
    run: number;
    /** Run variants whose newest tape is at the playbook's newest commit. */
    current: number;
    /** The rest, by the commit they ran at. */
    older: { commit: string; count: number }[];
    /** Their ids, for Re-run. */
    older_variants: string[];
    tapes: number;
    bytes: number;
  };
}
