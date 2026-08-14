// Sends one test push notification to whatever subscription is stored in the
// synced Gist. Run manually via the "Send Test Push" GitHub Action.
//
// Required environment variables (set as GitHub Actions secrets):
//   GIST_ID            - the same Gist ID used by the app's Settings > Gist Sync
//   GIST_TOKEN         - a GitHub token with "gist" scope (read access is enough)
//   VAPID_PUBLIC_KEY   - public VAPID key (matches the one embedded in index.html)
//   VAPID_PRIVATE_KEY  - private VAPID key (NEVER put this in client code)
//   VAPID_SUBJECT       - a mailto: address or URL, required by the push spec

const webpush = require('web-push');

async function main() {
  const { GIST_ID, GIST_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  const missing = ['GIST_ID', 'GIST_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing required env vars/secrets:', missing.join(', '));
    process.exit(1);
  }

  console.log('Fetching Gist...');
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `token ${GIST_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    console.error(`Failed to fetch Gist: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const gist = await res.json();
  const content = gist.files && gist.files['productivity_data.json'] && gist.files['productivity_data.json'].content;
  if (!content) {
    console.error('Could not find productivity_data.json in the Gist.');
    process.exit(1);
  }

  const data = JSON.parse(content);
  const subscription = data.pushSubscription;
  if (!subscription || !subscription.endpoint) {
    console.error('No push subscription found in synced data. Open the app, go to Settings, and tap "Enable Reminders" first — make sure it syncs (Push or wait a few seconds) before running this again.');
    process.exit(1);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title: '🔔 Test notification',
    body: 'If you see this, the push pipeline works end to end!',
  });

  console.log('Sending push...');
  try {
    await webpush.sendNotification(subscription, payload);
    console.log('✅ Push sent successfully.');
  } catch (err) {
    console.error('❌ Push send failed:', err.statusCode, err.body || err.message);
    process.exit(1);
  }
}

main();
