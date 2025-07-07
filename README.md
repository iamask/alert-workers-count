# Alert Worker: GraphQL Count-Based Event Increase Detection

## Purpose

This Cloudflare Worker monitors timeseries event data (e.g., firewall events) using the Cloudflare GraphQL API. It detects and alerts whenever there is an **increase in event count** between consecutive timeseries points, with deduplication to avoid duplicate alerts for the same increase.

## How It Works

1. **Fetch Data:**

   - The Worker queries the Cloudflare GraphQL API for the **latest 10 minutes** of timeseries data (per minute) for a given account and ruleset.
   - The query uses `orderBy: [datetimeMinute_DESC]` and `limit: 10` to fetch the most recent 10 data points.
   - **Note:** The API returns data in descending order (newest to oldest). The code reverses this array to process data in chronological order (oldest to newest), which is necessary for correct increase detection.

2. **Sort and Compare:**

   - The data is compared in chronological order (oldest to newest).
   - For each consecutive pair of points, the Worker checks if the current count is greater than the previous count.

3. **Deduplication:**

   - The Worker stores the timestamp of the last alerted increase in Cloudflare KV (`lastAlertedIncreaseTs`).
   - Only increases with a timestamp newer than the last alerted one are included in the alert.
   - After alerting, the Worker updates KV with the latest alerted timestamp.

4. **Alerting:**

   - If any new increases are found, the Worker sends an alert (e.g., to Slack) with details of all new increases.
   - **Only the top 3 increases and top 3 detailed events are included in the Slack alert** to avoid message length issues.

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

### Required Environment Variables

Set these in your environment or via Wrangler secrets:

- `API_TOKEN`: Cloudflare API Token (with GraphQL and KV permissions)
- `ACCOUNT_ID`: Cloudflare Account Tag (Account ID)
- `RULESET_ID`: Default HTTP DDPS Ruleset ID
- `SLACK_WEBHOOK_URL`: Slack Webhook URL for alerts

### KV Namespace

- The Worker uses a KV namespace for deduplication and timeseries storage.
- Example (from `wrangler.jsonc`):

```
"kv_namespaces": [
  {
    "binding": "ALERTS_KV",
    "id": "<your-kv-namespace-id>"
  }
]
```

### Wrangler Configuration

- Main entry: `src/index.js`
- Compatibility date: set as needed (see `wrangler.jsonc`)

## Usage & Deployment

1. **Install dependencies:**
   ```sh
   npm install
   ```
2. **Set up environment variables and KV namespace** in `wrangler.jsonc` and/or using Wrangler secrets.
3. **Deploy to Cloudflare Workers:**
   ```sh
   npm run deploy
   ```
4. **Development mode:**
   ```sh
   npm run dev
   ```
5. **Run tests:**
   ```sh
   npm test
   ```

## Customization

- You can adjust the time window, alerting logic, or notification method as needed.
- The deduplication logic ensures you only get alerts for new increases, not repeats.
- To change the number of data points or Slack alert truncation, modify the `limit` in the GraphQL query or the slice in the alert logic.

## License

MIT
