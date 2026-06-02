import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url)));

export const DATA_CHANNELS = {
  futuresAccounts:           () => data.futuresAccounts,
  predictionsAccounts:       () => data.predictionsAccounts,
  predictionsRecentProducts: () => data.predictionsRecentProducts,
  pulseEvents:               () => data.pulseEvents,
  allMarkets:                () => data.allMarkets,
  featured_markets:          () => data.featured_markets,
  portfolio:                 () => data.portfolio,
};
