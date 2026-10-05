/** A single analytics event (matches the server's AnalyticsEvent shape). */
export interface TelemetryEvent {
  name: string;
  timestamp: string;
  metadata: Record<string, string>;
}

/**
 * One spooled line. Carries the request-context fields needed to group events
 * into batches plus the event itself. Grouped by (env, site_name, visitor_id,
 * cli_version) so a single POST never mixes sites or environments.
 */
export interface SpoolRecord {
  env: string;
  site_name: string;
  visitor_id: string;
  cli_version: string;
  event: TelemetryEvent;
}

/** Request body for the dedicated headless/CLI ingestion endpoint. */
export interface CliAnalyticsCreateRequest {
  client: string;
  visitor_id: string;
  site_name: string;
  cli_version: string;
  events: TelemetryEvent[];
}
