# Oxyide Forge — Observability

This document describes the metrics Forge exposes, how to scrape them, how to
generate the Grafana dashboard, and how to import it. Forge does not install
or host Grafana or Prometheus — both are customer-managed external services.

## What Forge provides

When `METRICS_ENABLED=true`, the application serves a Prometheus-compatible
endpoint:

- **Path:** `GET /metrics`
- **Format:** Prometheus text exposition v0.0.4
- **Content type:** `text/plain; version=0.0.4; charset=utf-8`
- **Auth:** unauthenticated (like `/health/live` and `/health/ready`)
- **Default:** disabled (`METRICS_ENABLED` defaults to `false`; recording is a NoOp)

The endpoint is `hide`-flagged: it never appears in the public OpenAPI
document, like `/openapi.json`.

### Instruments

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `forge_http_requests_total` | counter | `method`, `route`, `status` | Every completed in-pipeline response |
| `forge_http_errors_total` | counter | `method`, `route`, `status` | Completed responses with status ≥ 500 only (4xx are client errors and are NOT counted here) |
| `forge_http_request_duration_seconds` | histogram | `method`, `route` (+ `le` on `_bucket`) | Response latency; 14 fixed bucket edges from 5 ms to 10 s |

### Bounded labels

Labels are bounded **by construction**: `route` is the Fastify route
template (one of the frozen paths, or the literal `'unknown'` for unmatched
URLs) — never a raw URL, ID, email, IP, token, or query string. `method` and
`status` are server-observed values. A caller physically cannot record an
unbounded dimension: the `ForgeMetrics` interface carries no such parameter.

### What Forge does NOT provide

- CPU, memory, event-loop, GC, or database-pool metrics.
- Distributed tracing (the tracing boundary accepts customer adapters).
- Per-auth-flow counters (auth emits structured security events instead).
- Alerting rules (define these in Prometheus/Alertmanager for your SLOs).

## Prerequisites

- A Prometheus-compatible scraper (Prometheus, Grafana Alloy, VictoriaMetrics, …).
- Network access from the scraper to the application's `/metrics` port.
- Grafana (for the dashboard), version 10+ recommended; the dashboard uses
  `schemaVersion: 39`, supported by Grafana 10 and 11.

**Security note:** `/metrics` is unauthenticated. Do not expose it publicly
without network controls (VPC/security-group restriction, reverse-proxy
allowlist, or equivalent). The endpoint carries no secrets, but traffic-shape
visibility is operational information — restrict it to your monitoring network.

## Scrape configuration

Example Prometheus `scrape_configs` entry (adjust target and interval):

```yaml
scrape_configs:
  - job_name: 'oxyide-forge'
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ['app-host:3000']
```

Set `METRICS_ENABLED=true` in the application environment. Without it,
`/metrics` returns 404 and recording stays NoOp.

## Generating the dashboard

```bash
npm run dashboards
# equivalent: node scripts/generate-dashboards.cjs
```

This reads `observability/grafana/dashboards/manifest.json` (the source of
truth) and writes `observability/grafana/dashboards/oxyide-forge.json`.
Generation is deterministic: repeated runs produce byte-identical output, with
no network, Grafana, or running-application dependency.

Validate the manifest without writing:

```bash
node scripts/generate-dashboards.cjs --check
```

Override paths with `--manifest <path> --out <path>` (or
`DASHBOARD_MANIFEST` / `DASHBOARD_OUT` env vars).

## Importing into Grafana

1. In Grafana: **Dashboards → New → Import**.
2. Upload `observability/grafana/dashboards/oxyide-forge.json` (or paste it).
3. When prompted for the Prometheus datasource, select your Forge scrape
   datasource. The dashboard references the `${DS_PROMETHEUS}` variable, so
   any Prometheus-compatible datasource works — no UID editing required.
4. Set the time range (default `now-1h`, refresh `30s`) to taste.
5. Verify panels populate. If a panel shows "No data", see Troubleshooting.

## Panels

| # | Panel | Query basis |
|---|---|---|
| 1 | Request rate (req/s) | `rate(forge_http_requests_total[5m])` by route+status |
| 2 | HTTP error rate, 5xx only (req/s) | `rate(forge_http_errors_total[5m])` by route+status |
| 3 | Latency p50/p95/p99 | `histogram_quantile()` over `_bucket` by route+`le` |
| 4 | Status distribution | `forge_http_requests_total` by status |
| 5 | Volume by method+route | `forge_http_requests_total` by method+route |

Quantiles are **estimates** derived from histogram buckets, not exact
measurements. A flat zero on rate panels means no traffic in window — check
error rate alongside before concluding health.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/metrics` returns 404 | `METRICS_ENABLED` not `true` | Set `METRICS_ENABLED=true` and restart |
| Dashboard shows "No data" | Scraper not reaching `/metrics` | Check target, port, firewall, scrape config |
| Unknown metric names | Wrong job/datasource selected | Point the dashboard at the Forge scrape job |
| p50/p95/p99 empty but counters work | No histogram samples in window | Generate traffic; check the 5m rate window vs scrape interval |
| Unexpected `route` values | Unmatched URLs bucket as `'unknown'` | Expected — review routes or catch-all handlers |
| High series count | More distinct route templates than expected | `route` is bounded by the frozen path set; investigate route sprawl, not label leakage |

## Maintenance

- **Change the manifest** (`observability/grafana/dashboards/manifest.json`),
  never the generated JSON directly.
- **Add a panel:** append a panel object with a unique `id`, a supported
  `type` (`timeseries`, `stat`, `piechart`, `table`), and `targets[]` whose
  expressions reference only the three verified metrics and bounded labels
  (`method`, `route`, `status`, plus `le` for histograms).
- **Regenerate:** `node scripts/generate-dashboards.cjs`.
- **Validate:** `node scripts/generate-dashboards.cjs --check` plus
  `npx vitest run scripts/generate-dashboards.test.ts`.
- **Review rule:** any new grouping label outside
  `method`/`route`/`status`/`le` is rejected by the generator — this is the
  cardinality guard. Do not weaken it.

## Verification status

- Generator, manifest, dashboard, and tests are verified locally
  (deterministic output, structural validation, allowlist enforcement).
- **Live Grafana import and PromQL execution were NOT tested** (no Grafana or
  Prometheus server in the verification environment). The dashboard is
  structurally valid Grafana JSON referencing verified metrics; import it and
  confirm panels populate in your environment.
