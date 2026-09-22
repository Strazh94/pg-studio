import type { PgStudioApi } from '../shared/types';

declare global {
  interface Window {
    api: PgStudioApi;
  }
}

export {};
