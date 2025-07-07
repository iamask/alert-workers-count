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
// Only the top 3 increases and top 3 details will be sent to avoid Slack string length nps
const sendAlert = async (events, accountTag, env) => {
    // Truncate increases and details to top 3 each if present
    const truncatedEvents = {
        increases: Array.isArray(events.increases) ? events.increases.slice(0, 3) : events.increases,
        details: Array.isArray(events.details) ? events.details.slice(0, 3) : events.details
    };
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
                    text: JSON.stringify(truncatedEvents, null, 2)
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
        filter: {
          datetime_geq: "${datetime_geq}",
          datetime_lt: "${datetime_lt}",
          AND: [
            { rulesetId: "${rulesetId}" }
          ]
        },
        orderBy: [datetimeMinute_ASC],
        limit: 1000
      ) {
        count
        dimensions {
          ts: datetimeMinute
        }
      }
    }
  }
}`;
            // Log the main query for troubleshooting
            console.log('Main GraphQL query:', query);

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
            let series = data.data?.viewer?.accounts?.[0]?.firewallEventsAdaptiveGroups || [];
            let alertEvents = [];

            // Debug: Log all timestamps returned by the GraphQL query
            console.log('GraphQL timeseries timestamps:', series.map(p => p.dimensions.ts));

            // Early exit if not enough data points
            if (series.length < 2) {
                console.log('Not enough data points to compare.');
                return;
            }

            // No need to sort; series is already in chronological order from the API

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
                // Prepare a second GraphQL query for detailed events in the last 2 minutes
                const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
                const datetime_geq_details = twoMinutesAgo.toISOString();
                const datetime_lt_details = now.toISOString();
                const detailsQuery = `
query Viewer {
  viewer {
    accounts(filter: { accountTag: "${accountTag}" }) {
      accountTag
      firewallEventsAdaptiveGroups(
        filter: {
          datetime_geq: "${datetime_geq_details}",
          datetime_lt: "${datetime_lt_details}"
        },
        orderBy: [datetimeMinute_DESC]
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
                // Log the detailsQuery for troubleshooting
                console.log('Details GraphQL query:', detailsQuery);
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
                    console.log('Details fetch response status:', detailsResponse.status);
                    const detailsRawText = await detailsResponse.text();
                    console.log('Details fetch raw response:', detailsRawText);
                    if (detailsResponse.ok) {
                        const detailsData = JSON.parse(detailsRawText);
                        detailedEvents = detailsData.data?.viewer?.accounts?.[0]?.firewallEventsAdaptiveGroups || [];
                    } else {
                        console.error('Failed to fetch detailed events:', detailsRawText);
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
