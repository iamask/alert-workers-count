// Get time window for last 24 hours...
const getTimeWindow = () => {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
        start: twentyFourHoursAgo.toISOString(),
        end: now.toISOString()
    };
};

// Validate required environment variables
const validateEnv = (env) => {
    const requiredVars = {
        'API_TOKEN': 'Cloudflare API Token',
        'ACCOUNT_ID': 'Account Tag (Account ID)',
        'RULESET_ID': 'Default HTTP DDPS Ruleset ID',
        'SLACK_WEBHOOK_URL': 'Slack Webhook URL'
    };

    const missingVars = [];
    for (const [varName, description] of Object.entries(requiredVars)) {
        if (!env[varName]) {
            missingVars.push(`${varName} (${description})`);
        }
    }

    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables:${missingVars.join('\n')}`);
    }
    console.log('Environment validation completed successfully');
};

// Simple hash function for state comparison
// use 128 characters of the base64 encoded string
const getSimpleHash = (data) => btoa(JSON.stringify(data)).slice(0, 128);

// Send alert to Slack
// Slack has string length limits, so we need to truncate the events data in graphql query like top 3
const sendAlert = async (events, accountTag, env) => {
    const message = {
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `🚨 DDoS Events Detected on Account 🚨 `
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: JSON.stringify(events, null, 2)
                }
            }
        ]
    };

    try {
        const response = await fetch(env.SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message)
        });

        if (!response.ok) {
            throw new Error(`Slack webhook failed: ${response.status}`);
        }
    } catch (error) {
        throw new Error(`Failed to send Slack alert: ${error.message}`);
    }
};

// here all my DDoS override rule names starts with "page%" ; % is a wildcard
// DDoS override rules cannot be filtered by ruleId_like, so we need to filter by description_like which is easier to implement
export default {
    async scheduled(request, env, ctx) {
        try {
            validateEnv(env);
            // Get the last 24 hours time window
            const timeWindow = getTimeWindow();
            // Calculate the last 10 minutes window
            const now = new Date();
            const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
            const datetime_geq = tenMinutesAgo.toISOString();
            const datetime_lt = now.toISOString();
            // Use the provided GraphQL query (updated to use dynamic 10-minute window)
            const query = `
query GetCustomTimeseries {
  viewer {
    scope: zones(filter: { zoneTag: "b58cebb2d5fd636f67c10aaf9371b20b" }) {
      custom_timeseries_series_0: firewallEventsAdaptiveGroups(
        limit: 5000,
        filter: {
          datetime_geq: "${datetime_geq}",
          datetime_lt: "${datetime_lt}",
          AND: [
            { rulesetId: "c48aae6a8efc47c3abb8e3ab19ffab15" }
          ]
        },
        orderBy: [datetimeMinute_ASC]
      ) {
        count
        dimensions {
          ts: datetimeMinute
        }
      }
      custom_timeseries_series_0_total: firewallEventsAdaptiveGroups(
        limit: 1,
        filter: {
          datetime_geq: "${datetime_geq}",
          datetime_lt: "${datetime_lt}",
          AND: [
            { rulesetId: "c48aae6a8efc47c3abb8e3ab19ffab15" }
          ]
        }
      ) {
        count
      }
    }
  }
}`;

            // Fetch the timeseries data
            const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.API_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`GraphQL API request failed with status ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            console.log('GraphQL response received');
            console.log('GraphQL response data:', JSON.stringify(data, null, 2));

            if (data.errors) {
                throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
            }

            // Extract timeseries
            const series = data.data?.viewer?.scope?.[0]?.custom_timeseries_series_0 || [];
            let alertTriggered = false;
            let alertEvents = [];

            // Sort the series by timestamp ascending
            series.sort((a, b) => new Date(a.dimensions.ts) - new Date(b.dimensions.ts));

            // Get the last alerted timestamp from KV to prevent duplicate alerts
            const lastAlertedTs = await env.ALERTS_KV.get('lastAlertedIncreaseTs');
            let latestAlertedTs = lastAlertedTs;

            // Detect all increases between consecutive points, only alert for new ones
            for (let i = 1; i < series.length; i++) {
                const prev = series[i - 1];
                const curr = series[i];
                if (curr.count > prev.count) {
                    // Only alert if this increase is newer than the last alerted one
                    if (!lastAlertedTs || curr.dimensions.ts > lastAlertedTs) {
                        alertEvents.push({
                            prevTs: prev.dimensions.ts,
                            prevCount: prev.count,
                            currTs: curr.dimensions.ts,
                            currCount: curr.count
                        });
                        // Track the latest timestamp we alert on
                        if (!latestAlertedTs || curr.dimensions.ts > latestAlertedTs) {
                            latestAlertedTs = curr.dimensions.ts;
                        }
                    }
                }
            }

            // Send alert if any new increases were detected and update KV
            if (alertEvents.length > 0) {
                await sendAlert(alertEvents, env.ACCOUNT_ID, env);
                console.log('Alert sent for increases:', alertEvents);
                // Update KV with the latest alerted timestamp
                await env.ALERTS_KV.put('lastAlertedIncreaseTs', latestAlertedTs);
            } else {
                console.log('No new increases detected in the timeseries.');
            }

            // Store all timeseries points from the GraphQL response in KV with a TTL of 24 hours
            for (const point of series) {
                const ts = point.dimensions.ts;
                const count = point.count;
                console.log('Storing in KV:', `timeseries:${ts}`, count);
                await env.ALERTS_KV.put(`timeseries:${ts}`, String(count), { expirationTtl: 86400 });
                console.log('Stored in KV:', `timeseries:${ts}`);
            }
        } catch (error) {
            console.log(JSON.stringify({
                status: 'error',
                message: error.message
            }));
        }
    },
};
