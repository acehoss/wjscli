import { afterEach, beforeEach } from 'vitest';
import { TokenStore } from '../../src/util/token-store.js';
import { WikiClient } from '../../src/wiki/client.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from '../mock/graphql-server.js';

// Shared test scaffold used by every per-tool test file: spins up the
// in-process mock + WikiClient bound to an in-memory TokenStore, tears
// everything down afterEach.
export type ToolTestCtx = {
  mock: MockGraphQLServer;
  client: WikiClient;
};

export function setupToolTest(): { ctx: () => ToolTestCtx } {
  let mock: MockGraphQLServer | undefined;
  let client: WikiClient | undefined;

  beforeEach(async () => {
    mock = await startMockGraphQLServer();
    const store = TokenStore.inMemory(
      mock.url,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0Iiwic2NvcGUiOiJ0In0.signaturesignature',
    );
    client = new WikiClient({ tokenStore: store });
  });

  afterEach(async () => {
    if (mock !== undefined) await mock.close();
    mock = undefined;
    client = undefined;
  });

  return {
    ctx: () => {
      if (mock === undefined || client === undefined) {
        throw new Error('setupToolTest: ctx accessed outside a beforeEach/it');
      }
      return { mock, client };
    },
  };
}
