import type { QueryResult } from '../shared/types';

export interface SqlRunState {
  running: boolean;
  queryId?: string;
  error?: string;
  result?: QueryResult;
}

export type SqlTab = {
  id: string;
  kind: 'sql';
  title: string;
  content: string;
  result?: SqlRunState;
};

export type TableTab = {
  id: string;
  kind: 'table';
  schema: string;
  name: string;
};

export type Tab = SqlTab | TableTab;
