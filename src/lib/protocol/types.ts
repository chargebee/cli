/** Chargebee webhook event, mapped from an AppSync `data` payload for local forward. */
export interface WebhookMsg {
  type: "webhook";
  request_id: string;
  event_type: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string; // base64-encoded
}

/** CLI-internal result of forwarding a webhook to localhost. */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
