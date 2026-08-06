export interface Candidate {
  el: HTMLElement;
  name: string;
  role: string;
  rect: DOMRect;
}

export interface RankedCandidate extends Candidate {
  score: number;
}

export type BoostFn = (queryTokens: Set<string>, candidate: Candidate) => number;

// One row of the backend's GET /api/resolutions response — a past
// (query, matched control) pair confirmed enough times to be worth
// reinforcing on this hostname. See backend/app/api/resolutions/route.ts.
export interface DynamicHint {
  query: string;
  matchedName: string;
  score: number;
  confirmations: number;
}

export interface LogResolutionPayload {
  hostname: string;
  query: string;
  matchedName: string;
  score: number;
  confirmed: boolean;
}
