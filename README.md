# Alert Worker: GraphQL Count-Based Event Increase Detection

## Purpose

This Cloudflare Worker monitors timeseries event data (e.g., firewall events) using the Cloudflare GraphQL API. It detects and alerts whenever there is an **increase in event count** between consecutive timeseries points, with deduplication to avoid duplicate alerts for the same increase.

## How It Works

1. **Fetch Data:**

   - The Worker queries the Cloudflare GraphQL API for the **last 10 minutes** of timeseries data (per minute) for a given zone and ruleset.

2. **Sort and Compare:**

   - The data is sorted by timestamp.
   - For each consecutive pair of points, the Worker checks if the current count is greater than the previous count.

3. **Deduplication:**

   - The Worker stores the timestamp of the last alerted increase in Cloudflare KV (`lastAlertedIncreaseTs`).
   - Only increases with a timestamp newer than the last alerted one are included in the alert.
   - After alerting, the Worker updates KV with the latest alerted timestamp.

4. **Alerting:**

   - If any new increases are found, the Worker sends an alert (e.g., to Slack) with details of all new increases.

5. **KV Storage:**
   - All timeseries points are stored in KV with a TTL of 24 hours for reference and possible future use.

## Example Flow

Suppose your data looks like this (within the last 10 minutes):

| Timestamp | Count | Alert Note         |
| --------- | ----- | ------------------ |
| 08:21:00  | 29    |                    |
| 08:22:00  | 38    | ← increase (alert) |
| 08:23:00  | 38    |                    |
| 08:24:00  | 39    | ← increase (alert) |
| 08:25:00  | 39    |                    |
| 08:26:00  | 39    |                    |
| 08:27:00  | 39    |                    |
| 08:28:00  | 38    |                    |
| 08:29:00  | 39    | ← increase (alert) |

### First Run

- No previous alerts (KV is empty).
- Alerts for increases at 08:22, 08:24, and 08:29.
- Updates KV: `lastAlertedIncreaseTs = "2025-07-03T08:29:00Z"`

### Second Run (same data)

- KV contains: `lastAlertedIncreaseTs = "2025-07-03T08:29:00Z"`
- No new increases detected. No alert sent.

### Third Run (new data arrives)

| Timestamp | Count | Alert Note     |
| --------- | ----- | -------------- |
| ...       | ...   |                |
| 08:29:00  | 39    |                |
| 08:30:00  | 38    |                |
| 08:31:00  | 40    | ← new increase |

- KV contains: `lastAlertedIncreaseTs = "2025-07-03T08:29:00Z"`
- Alerts for increase at 08:31 only.
- Updates KV: `lastAlertedIncreaseTs = "2025-07-03T08:31:00Z"`

## Configuration

- Set your Cloudflare KV namespace in `wrangler.jsonc`.
- Configure your zoneTag, rulesetId, and API token as environment variables or in the Worker code.

## Customization

- You can adjust the time window, alerting logic, or notification method as needed.
- The deduplication logic ensures you only get alerts for new increases, not repeats.

## License

MIT
