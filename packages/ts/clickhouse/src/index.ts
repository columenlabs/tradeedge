/**
 * ClickHouse access for history (`market_lab.options_chains`). All services
 * consume from here — no ad-hoc CH drivers in service code.
 *
 * Read path uses the read-only user over the HTTP interface via `fetch`
 * (a VPC service binding on Workers). Writes stay in
 * `packages/python/edgedesk_storage`.
 */
export * from './client';
export * from './history';
export * from './normalize';
export * from './queries';
