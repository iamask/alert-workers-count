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
            // Calculate the last 10 minutes window
            const now = new Date();
            const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
            const datetime_geq = tenMinutesAgo.toISOString();
            const datetime_lt = now.toISOString();
            // Use environment variables for accountTag and rulesetId
            const accountTag = env.ACCOUNT_ID;
            const rulesetId = env.RULESET_ID;
            // Use the provided GraphQL query (with variables)
            const query = `
query GetCustomTimeseries {
  viewer {
    accounts(filter: { accountTag: "${accountTag}" }) {
      accountTag
      firewallEventsAdaptiveGroups(
        limit: 5000,
        filter: {
          datetime_geq: "${datetime_geq}",
          datetime_lt: "${datetime_lt}",
          AND: [
            { rulesetId: "${rulesetId}" }
          ]
        },
        orderBy: [datetimeMinute_ASC]
      ) {
        count
        dimensions {
          ts: datetimeMinute
        }
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
            const series = data.data?.viewer?.accounts?.[0]?.firewallEventsAdaptiveGroups || [];
            let alertEvents = [];

            // Debug: Log all timestamps returned by the GraphQL query
            console.log('GraphQL timeseries timestamps:', series.map(p => p.dimensions.ts));

            // Early exit if not enough data points
            if (series.length < 2) {
                console.log('Not enough data points to compare.');
                return;
            }

            // Sort the series by timestamp ascending (do this only once)
            series.sort((a, b) => new Date(a.dimensions.ts) - new Date(b.dimensions.ts));

            // Get the last alerted timestamp from KV to prevent duplicate alerts
            const lastAlertedTs = await env.ALERTS_KV.get('lastAlertedIncreaseTs');
            let latestAlertedTs = lastAlertedTs;

            // Detect all increases between consecutive points, only alert for new ones
            for (let i = 1; i < series.length; i++) {
                const { ts: prevTs } = series[i - 1].dimensions;
                const { count: prevCount } = series[i - 1];
                const { ts: currTs } = series[i].dimensions;
                const { count: currCount } = series[i];
                if (currCount > prevCount) {
                    // Only alert if this increase is newer than the last alerted one
                    if (!lastAlertedTs || currTs > lastAlertedTs) {
                        alertEvents.push({ prevTs, prevCount, currTs, currCount });
                        // Track the latest timestamp we alert on
                        if (!latestAlertedTs || currTs > latestAlertedTs) {
                            latestAlertedTs = currTs;
                        }
                    }
                }
            }

            // Send alert if any new increases were detected and update KV
            if (alertEvents.length > 0) {
                // Prepare a second GraphQL query for detailed events in the last 10 minutes
                const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
                const detailsQuery = `
query Viewer {
  viewer {
    accounts(filter: { accountTag: "${accountTag}" }) {
      accountTag
      firewallEventsAdaptiveGroups(
        filter: {
          date: "${dateStr}"
        }
        limit: 5
      ) {
        count
        dimensions {
          clientIP
          ja4
          description
          action
        }
      }
    }
  }
}`;

                // Fetch the detailed events
                let detailedEvents = [];
                try {
                    const detailsResponse = await fetch('https://api.cloudflare.com/client/v4/graphql', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${env.API_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ query: detailsQuery }),
                    });
                    if (detailsResponse.ok) {
                        const detailsData = await detailsResponse.json();
                        detailedEvents = detailsData.data?.viewer?.accounts?.[0]?.firewallEventsAdaptiveGroups || [];
                    } else {
                        console.error('Failed to fetch detailed events:', await detailsResponse.text());
                    }
                } catch (err) {
                    console.error('Error fetching detailed events:', err);
                }

                // Send both the increases and the detailed events in the alert
                await sendAlert({ increases: alertEvents, details: detailedEvents }, env.ACCOUNT_ID, env);
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
                console.log('Processing point:', ts, count);
                try {
                    await env.ALERTS_KV.put(`timeseries:${ts}`, String(count), { expirationTtl: 86400 });
                    console.log('Stored in KV:', `timeseries:${ts}`);
                } catch (err) {
                    console.error('KV put error:', err);
                }
            }
        } catch (error) {
            console.log(JSON.stringify({
                status: 'error',
                message: error.message
            }));
        }
    },
};
