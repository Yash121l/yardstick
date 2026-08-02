export interface Event {
  id: string;
  payload: unknown;
}

export interface Http {
  post(url: string, body: unknown): Promise<{ status: number }>;
}

export interface DispatchResult {
  delivered: boolean;
  attempts: number;
}

/** Post one event to one endpoint. */
export async function dispatch(http: Http, url: string, ev: Event): Promise<DispatchResult> {
  const res = await http.post(url, ev.payload);
  return { delivered: res.status >= 200 && res.status < 300, attempts: 1 };
}
