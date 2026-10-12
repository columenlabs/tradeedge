/**
 * Market data providers (TS side). Mirrors `packages/python/edgedesk_providers`.
 * Consumers depend on `LiveOptionsProvider`, never a concrete vendor client.
 */
export * from './types';
export * from './occ';
export { AlpacaClient, envAlpacaConfig, normalizeOptionSnapshot } from './alpaca';
export type { AlpacaConfig, NewsArticle } from './alpaca';
