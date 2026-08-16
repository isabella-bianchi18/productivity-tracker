// Checks every task's reminder settings against the current time (in the user's
// timezone) and sends a push for anything that's due. Designed to run on a
// schedule (see .github/workflows/check-reminders.yml) — safe to run as often
// as every few minutes since it de-dupes by writing `lastSent` back to the Gist.
//
// Required environment variables (GitHub Actions secrets):
//   GIST_ID, GIST_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

const webpush = require('web-push');

// ===== Timezone-aware date/time helpers =====
// D.settings.timezone is an IANA name (e.g. "America/New_York"), captured
// automatically client-side when a reminder is saved.
function tzParts(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    hhmm: `${map.hour}:${map.minute}`,
    weekday: weekdayMap[map.weekday],
    day: parseInt(map.day, 10),
    month: parseInt(map.month, 10),
    year: parseInt(map.year, 10),
  };
}
function daysInMonth(year, month1indexed) {
  return new Date(year, month1indexed, 0).getDate();
}

// ===== Goal progress (ported from getGoalProgress() in index.html) =====
function periodStartStr(period, parts) {
  if (period === 'hourly') return `${parts.dateStr}T${parts.hhmm.slice(0, 2)}`;
  if (period === 'daily') return parts.dateStr;
  if (period === 'weekly') {
    const d = new Date(`${parts.dateStr}T00:00:00Z`);
    const dow = d.getUTCDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  if (period === 'monthly') return `${parts.dateStr.slice(0, 7)}-01`;
  if (period === 'annually') return `${parts.dateStr.slice(0, 4)}-01-01`;
  return parts.dateStr;
}
function getGoalProgress(task, pointsHistory, parts) {
  if (!task.goal || !task.goal.target || task.goal.target < 1) return null;
  let entries;
  if (task.goal.period === 'total') {
    entries = pointsHistory.filter((h) => h.taskId === task.id && h.type === 'earned');
  } else {
    const psStr = periodStartStr(task.goal.period, parts);
    const sliceLen = task.goal.period === 'hourly' ? 13 : 10;
    entries = pointsHistory.filter(
      (h) => h.taskId === task.id && h.type === 'earned' && h.date.slice(0, sliceLen) >= psStr.slice(0, sliceLen)
    );
  }
  const current = task.timeBased
    ? entries.reduce((s, h) => s + (h.minutes || 0), 0)
    : task.countBased
      ? entries.reduce((s, h) => s + (h.count || 0), 0)
      : entries.length;
  return { current, target: task.goal.target, pct: Math.min(100, Math.round((current / task.goal.target) * 100)) };
}

// ===== "Is this task already satisfied for its current period?" =====
function isTaskDone(task, pointsHistory, parts) {
  if (task.goal && task.goal.target >= 1) {
    const gp = getGoalProgress(task, pointsHistory, parts);
    return !!gp && gp.pct >= 100;
  }
  if (task.type === 'daily') {
    return pointsHistory.some(
      (h) => h.taskId === task.id && h.type === 'earned' && h.date.slice(0, 10) === parts.dateStr && h.task.includes('✅')
    );
  }
  if (task.type === 'one-time') return !!task.completed;
  // Evergreen tasks (and anything else) have no "done" state — never skip.
  return false;
}

// ===== Recurring tasks: detect the exact day it becomes due again =====
function computeRecurringDueDateStr(task) {
  if (task.dueEarly) return task.dueEarly.slice(0, 10);
  if (!task.lastCompleted) return null; // never completed yet — no due-transition to detect
  const d = new Date(`${task.lastCompleted.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (task.cadenceDays || 1));
  return d.toISOString().slice(0, 10);
}

// ===== Does today match this task's configured schedule? =====
function scheduleMatchesToday(task, parts) {
  const r = task.reminder;
  if (task.type === 'recurring') {
    return computeRecurringDueDateStr(task) === parts.dateStr;
  }
  switch (r.freq) {
    case 'daily':
      return (r.days || []).includes(parts.weekday);
    case 'weekly':
      return r.weekday === parts.weekday;
    case 'monthly':
      if (r.dayOfMonth === 'last') return parts.day === daysInMonth(parts.year, parts.month);
      return parts.day === r.dayOfMonth;
    case 'once':
      return r.date === parts.dateStr;
    default:
      return false;
  }
}

// ===== Full eligibility check for one task =====
function isEligibleNow(task, data, parts) {
  const r = task.reminder;
  if (!r || !r.on || !r.time) return false;
  if (r.lastSent === parts.dateStr) return false; // already sent today, don't repeat
  if (parts.hhmm < r.time) return false; // not time yet
  if (!scheduleMatchesToday(task, parts)) return false;
  if (task.type === 'recurring') {
    // Skip if they already did it today (e.g. completed it right when it became due).
    if (task.lastCompleted && task.lastCompleted.slice(0, 10) === parts.dateStr) return false;
  } else if (isTaskDone(task, data.pointsHistory, parts)) {
    return false;
  }
  return true;
}

module.exports = { tzParts, isEligibleNow, computeRecurringDueDateStr, isTaskDone, getGoalProgress };

// ===== Main (only runs when executed directly, not when required for tests) =====
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

async function main() {
  const { GIST_ID, GIST_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  const missing = ['GIST_ID', 'GIST_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error('Missing required env vars/secrets:', missing.join(', '));
    process.exit(1);
  }

  console.log('Fetching Gist...');
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GIST_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
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
    console.log('No push subscription saved — nothing to do.');
    return;
  }

  const tz = data.settings && data.settings.timezone ? data.settings.timezone : 'UTC';
  const parts = tzParts(tz);
  console.log(`Checking reminders for ${parts.dateStr} ${parts.hhmm} (${tz})`);

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const tasks = (data.tasks || []).filter((t) => !t.archived && t.reminder && t.reminder.on);
  let sentCount = 0;
  let dataChanged = false;
  let subscriptionDead = false;

  console.log(`Found ${tasks.length} task(s) with reminders enabled.`);
  for (const task of tasks) {
    try {
      const r = task.reminder;
      const reasons = [];
      if (r.lastSent === parts.dateStr) reasons.push("already sent today (lastSent="+r.lastSent+")");
      else if (parts.hhmm < r.time) reasons.push("not time yet (now="+parts.hhmm+", scheduled="+r.time+")");
      else if (!scheduleMatchesToday(task, parts)) {
        if (task.type === "recurring") reasons.push("recurring not due (dueDate="+computeRecurringDueDateStr(task)+", today="+parts.dateStr+", lastCompleted="+task.lastCompleted+", cadence="+task.cadenceDays+"d)");
        else reasons.push("schedule mismatch (freq="+r.freq+", days="+JSON.stringify(r.days)+", weekday="+r.weekday+", todayDow="+parts.weekday+")");
      } else if (task.type === "recurring" && task.lastCompleted && task.lastCompleted.slice(0,10) === parts.dateStr) reasons.push("recurring completed today already");
      else if (task.type !== "recurring" && isTaskDone(task, data.pointsHistory, parts)) reasons.push("task done for period");
      if (reasons.length) { console.log("  SKIP \""+task.name+"\": "+reasons.join("; ")); continue; }
      if (!isEligibleNow(task, data, parts)) { console.log("  SKIP \""+task.name+"\": passed manual checks but isEligibleNow=false"); continue; }
      console.log(`Sending reminder for "${task.name}"...`);
      const payload = JSON.stringify({
        title: '⏰ ' + task.name,
        body: task.type === 'recurring' ? 'This is due again today.' : 'Reminder from your task list.',
      });
      await webpush.sendNotification(subscription, payload);
      task.reminder.lastSent = parts.dateStr;
      dataChanged = true;
      sentCount++;
    } catch (err) {
      console.error(`Failed to send for "${task.name}":`, err.statusCode || '', err.body || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        subscriptionDead = true;
      }
    }
  }

  if (subscriptionDead) {
    console.log('Push subscription is no longer valid — clearing it (re-enable reminders in the app to fix).');
    data.pushSubscription = null;
    dataChanged = true;
  }

  if (dataChanged) {
    data._lastModified = Date.now();
    console.log('Writing updated data back to the Gist...');
    const patchRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${GIST_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({ files: { 'productivity_data.json': { content: JSON.stringify(data) } } }),
    });
    if (!patchRes.ok) {
      console.error(`Failed to write back to Gist: ${patchRes.status} ${patchRes.statusText}`);
      process.exit(1);
    }
  }

  console.log(`Done. Sent ${sentCount} reminder(s).`);
}
