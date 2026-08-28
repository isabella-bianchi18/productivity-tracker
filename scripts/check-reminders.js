// Checks every task's reminder settings against the current time (in the user's
// timezone) and sends a push for anything that's due. Designed to run on a
// schedule (see .github/workflows/check-reminders.yml) — safe to run as often
// as every few minutes since it de-dupes per day via a separate Gist file.
//
// Required environment variables (GitHub Actions secrets):
//   GIST_ID, GIST_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

const webpush = require('web-push');

// Reminder de-dupe state lives in its OWN Gist file, separate from productivity_data.json.
// See the write-back section of main() for why that matters.
const STATE_FILE = 'reminder_state.json';
// Push delivery options. `urgency: 'high'` asks the push service to deliver promptly rather than
// batching for battery.
//
// TTL was 3600. That was wrong, and silently lost reminders: `lastSent` is recorded as soon as the
// push service ACCEPTS the message, which is not the same as the device receiving it. If the phone
// stayed asleep for an hour the service discarded the message, but the task was already marked sent
// for the day, so it never retried and the reminder simply never arrived. Six hours, chosen so a
// late reminder still shows up — the user's stated preference over losing it — while never
// resurfacing a full day later.
//
// The notification body deliberately does NOT state the scheduled time. It was added here and the
// user asked for it out; do not reintroduce it as a way of explaining a late reminder.
const PUSH_OPTS = { urgency: 'high', TTL: 21600 };

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
// A parts-like object for a different calendar date, for asking "was this due yesterday?".
// Only the date fields are shifted; hhmm is meaningless here and is left as the caller's.
function shiftParts(parts, deltaDays) {
  const d = new Date(`${parts.dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const dateStr = d.toISOString().slice(0, 10);
  return {
    dateStr, hhmm: parts.hhmm, weekday: d.getUTCDay(),
    day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear(),
  };
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
// Mirror of taskCompletedInEntry() in index.html — KEEP THE TWO IN SYNC. A plan-timer completion is
// recorded twice: a 0-point "name ✅" marker carrying taskId, and the grouped '⏱️/🍅 Plan' row's
// planTasks[], which carries NO taskId. Checking taskId alone misses the second form.
function taskCompletedInEntry(task, h) {
  if (h.type !== 'earned') return false;
  if (h.taskId === task.id && typeof h.task === 'string' && h.task.includes('✅')) return true;
  return !!(h.planTasks && h.planTasks.some((p) => p.taskId === task.id && p.completed));
}
function completedOnDate(task, pointsHistory, dateStr) {
  return (pointsHistory || []).some((h) => taskCompletedInEntry(task, h) && h.date.slice(0, 10) === dateStr);
}
function isTaskDone(task, pointsHistory, parts) {
  if (task.goal && task.goal.target >= 1) {
    const gp = getGoalProgress(task, pointsHistory, parts);
    return !!gp && gp.pct >= 100;
  }
  // Evergreen belongs here too. It used to fall through to `return false` ("no done state, never
  // skip"), so an evergreen task with a daily reminder nagged every single day no matter how often
  // it was actually completed.
  if (task.type === 'daily' || task.type === 'evergreen') {
    return pointsHistory.some(
      (h) => taskCompletedInEntry(task, h) && h.date.slice(0, 10) === parts.dateStr
    );
  }
  if (task.type === 'one-time') return !!task.completed || completedOnDate(task, pointsHistory, parts.dateStr);
  return false;
}

// ===== Recurring tasks: detect the exact day it becomes due again =====
// Mirror of recurElapsed()/recurIsDue() in index.html — KEEP THE TWO IN SYNC. The app's notion of
// "last completed" is the most recent ✅ entry in pointsHistory, which includes completions
// recorded inside a grouped plan-timer entry (planTasks). It is deliberately NOT task.lastCompleted:
// that field can be stale or, for plan-timer completions, never written as a standalone row.
// Reading lastCompleted here made the script disagree with the app about which day a task is due.
function lastCompletionDateStr(task, pointsHistory) {
  let last = null;
  const bump = (iso) => { const d = iso.slice(0, 10); if (!last || d > last) last = d };
  for (const h of pointsHistory || []) {
    if (h.type !== 'earned') continue;
    if (h.taskId === task.id && typeof h.task === 'string' && h.task.includes('✅')) bump(h.date);
    else if (h.planTasks && h.planTasks.some((p) => p.taskId === task.id && p.completed)) bump(h.date);
  }
  return last;
}
function computeRecurringDueDateStr(task, pointsHistory, todayStr) {
  if (task.dueEarly) return task.dueEarly.slice(0, 10);
  // Never completed: fall back to createdAt so there is still exactly ONE transition day to fire
  // on. Previously this returned null, so a recurring task that had never been completed got no
  // reminder at all — ever — even though the app lists it as due. Anchoring on createdAt keeps the
  // "fires once, on the day it becomes due" promise instead of nagging every outstanding day.
  // Last resort: anchor on today. A legacy task with neither a completion nor a createdAt used to
  // return null here, which meant NO reminder ever — silently, forever. Anchoring on today makes it
  // become due in cadenceDays instead. The app also backfills createdAt on load, so this is a net.
  const base = lastCompletionDateStr(task, pointsHistory)
    || (task.createdAt ? task.createdAt.slice(0, 10) : null)
    || todayStr
    || null;
  if (!base) return null;
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (task.cadenceDays || 1));
  return d.toISOString().slice(0, 10);
}

// ===== Does today match this task's configured schedule? =====
// Explain a mismatch in terms of the field that actually governs this freq. Printing `days` and
// `weekday` for a one-off — where only `date` matters, and both of those are undefined — made the log
// actively misleading rather than merely unhelpful.
function scheduleMismatchReason(task, parts) {
  const r = task.reminder || {};
  if (task.type === 'recurring') return 'recurring not due';
  switch (r.freq) {
    case 'daily':
      return `not scheduled for this weekday (days=${JSON.stringify(r.days || [])}, todayDow=${parts.weekday})`;
    case 'weekly':
      return `not this weekday (weekday=${r.weekday}, todayDow=${parts.weekday})`;
    case 'monthly':
      return `not this day of month (dayOfMonth=${r.dayOfMonth}, today=${parts.day})`;
    case 'once':
      if (!r.date) return 'one-off with no date set';
      return r.date < parts.dateStr
        ? `one-off date has passed (date=${r.date}, today=${parts.dateStr}) — it can never fire again, switch it off`
        : `one-off not due yet (date=${r.date}, today=${parts.dateStr})`;
    default:
      return `unrecognised freq (${JSON.stringify(r.freq)})`;
  }
}
function scheduleMatchesToday(task, parts, pointsHistory) {
  const r = task.reminder;
  if (task.type === 'recurring') {
    return computeRecurringDueDateStr(task, pointsHistory, parts.dateStr) === parts.dateStr;
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
// Where "already sent today" is recorded. The map from reminder_state.json wins; task.reminder.lastSent
// is the legacy location and is still read so switching over doesn't re-send something already sent.
// Minutes since midnight, tolerant of an unpadded "9:00". The gate used to compare the two HH:MM
// strings directly, which is only correct while both are zero-padded — "21:00" < "9:00" is true, so a
// single unpadded stored time meant the reminder never fired at any hour of the day.
function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function lastSentFor(task, lastSentMap) {
  if (lastSentMap && lastSentMap[task.id] != null) return lastSentMap[task.id];
  return task.reminder && task.reminder.lastSent;
}
function isEligibleNow(task, data, parts, lastSentMap) {
  const r = task.reminder;
  if (!r || !r.on || !r.time) return false;
  if (lastSentFor(task, lastSentMap) === parts.dateStr) return false; // already sent today
  const nowMin = hhmmToMinutes(parts.hhmm), dueMin = hhmmToMinutes(r.time);
  if (dueMin === null || nowMin === null) return false; // unreadable schedule — never guess
  if (nowMin < dueMin) return false; // not time yet
  if (!scheduleMatchesToday(task, parts, data.pointsHistory)) return false;
  if (task.type === 'recurring') {
    // Skip if they already did it today (e.g. completed it right when it became due). Uses the
    // same history-based reckoning as computeRecurringDueDateStr, not task.lastCompleted.
    if (lastCompletionDateStr(task, data.pointsHistory) === parts.dateStr) return false;
  } else if (isTaskDone(task, data.pointsHistory, parts)) {
    return false;
  }
  return true;
}

module.exports = { tzParts, shiftParts, isEligibleNow, computeRecurringDueDateStr, lastCompletionDateStr, isTaskDone, getGoalProgress, taskCompletedInEntry, completedOnDate, lastSentFor, hhmmToMinutes, scheduleMismatchReason, STATE_FILE, PUSH_OPTS };

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
  // Load reminder state from its own file. This script must NEVER PATCH productivity_data.json:
  // doing so bumped `_lastModified`, and the app's gistPull() accepts any newer remote without
  // consulting `localDirty`, so every single run opened a window in which unpushed edits made on a
  // device could be silently discarded. Keeping de-dupe state in a separate file removes the write
  // entirely, which is what closes that hole.
  const stateRaw = gist.files && gist.files[STATE_FILE] && gist.files[STATE_FILE].content;
  let remState = {};
  if (stateRaw) {
    try { remState = JSON.parse(stateRaw) } catch (e) { console.warn(`${STATE_FILE} is not valid JSON — starting fresh.`) }
  }
  if (!remState.lastSent || typeof remState.lastSent !== 'object') remState.lastSent = {};
  const allTasks = data.tasks || [];
  const withReminder = allTasks.filter(t => t.reminder);
  const withReminderOn = allTasks.filter(t => t.reminder && t.reminder.on);
  console.log(`Total tasks: ${allTasks.length}, with reminder field: ${withReminder.length}, with reminder.on=true: ${withReminderOn.length}`);
  if (withReminder.length > 0 && withReminderOn.length === 0) {
    console.log("Sample reminder objects (first 3):");
    withReminder.slice(0, 3).forEach(t => console.log(`  task ${t.id}: ${JSON.stringify(t.reminder)}`));
  }
  if (withReminderOn.length > 0) {
    withReminderOn.forEach(t => console.log(`  ENABLED: task ${t.id} reminder=${JSON.stringify(t.reminder)}`));
  }

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
  let stateChanged = false;
  let subscriptionDead = false;

  console.log(`Found ${tasks.length} task(s) with reminders enabled.`);
  for (const task of tasks) {
    try {
      const r = task.reminder;
      // Visibility for the failure mode a cron audit turned up on 2026-08-27: GitHub honours only
      // about one in eight of the requested runs (median gap 36 min, worst observed 587 min). If no
      // run happens between a reminder's due time and midnight, the date rolls over, the gate says
      // "not time yet", and the reminder is dropped with nothing recorded anywhere. Say it out loud
      // so a miss is diagnosable instead of invisible.
      if (hhmmToMinutes(r.time) !== null) {
        const yp = shiftParts(parts, -1);
        const sentYesterday = lastSentFor(task, remState.lastSent) === yp.dateStr;
        const doneYesterday = task.type === 'recurring'
          ? lastCompletionDateStr(task, data.pointsHistory) === yp.dateStr
          : isTaskDone(task, data.pointsHistory, yp);
        if (!sentYesterday && !doneYesterday && scheduleMatchesToday(task, yp, data.pointsHistory)) {
          console.log(`  MISSED task ${task.id}: was due ${yp.dateStr} at ${r.time}, never sent, and the day has rolled over. No run occurred between the due time and midnight.`);
        }
      }
      const reasons = [];
      if (lastSentFor(task, remState.lastSent) === parts.dateStr) reasons.push("already sent today (lastSent="+lastSentFor(task, remState.lastSent)+")");
      else if (hhmmToMinutes(r.time) === null) reasons.push("unreadable reminder time ("+JSON.stringify(r.time)+") — re-save this reminder in the app");
      else if (hhmmToMinutes(parts.hhmm) < hhmmToMinutes(r.time)) reasons.push("not time yet (now="+parts.hhmm+", scheduled="+r.time+")");
      else if (!scheduleMatchesToday(task, parts, data.pointsHistory)) {
        if (task.type === "recurring") reasons.push("recurring not due (dueDate="+computeRecurringDueDateStr(task, data.pointsHistory, parts.dateStr)+", today="+parts.dateStr+", lastCompletion="+lastCompletionDateStr(task, data.pointsHistory)+", createdAt="+((task.createdAt||'(none)').slice(0,10))+", cadence="+task.cadenceDays+"d)");
        else reasons.push(scheduleMismatchReason(task, parts));
      } else if (task.type === "recurring" && lastCompletionDateStr(task, data.pointsHistory) === parts.dateStr) reasons.push("recurring completed today already");
      else if (task.type !== "recurring" && isTaskDone(task, data.pointsHistory, parts)) reasons.push("task done for period");
      if (reasons.length) { console.log("  SKIP task "+task.id+": "+reasons.join("; ")); continue; }
      if (!isEligibleNow(task, data, parts, remState.lastSent)) { console.log("  SKIP task "+task.id+": passed manual checks but isEligibleNow=false"); continue; }
      // Log the inputs that justified sending, not just the fact of it. A send that looks wrong is
      // almost always a wrong `tz` or a wrong `r.time`, and both are invisible without this.
      console.log(`SENDING task ${task.id}: now=${parts.dateStr} ${parts.hhmm} (${tz}), scheduled=${r.time}, freq=${r.freq}, type=${task.type}`);
      // The tag MUST be per task. It was the constant 'pt-reminder', and a tag replaces any
      // notification already showing under the same tag — so two reminders due in the same window
      // collapsed into one and the first was silently swallowed.
      const payload = JSON.stringify({
        title: '⏰ ' + task.name,
        body: task.type === 'recurring' ? 'This is due again today.' : 'Reminder from your task list.',
        tag: 'pt-' + task.id,
      });
      // Log what the push service actually answered. "lastSent recorded" only ever meant "no
      // exception thrown"; without the status code there is no way to tell an accepted-but-never-
      // displayed notification from one that was never accepted.
      const res = await webpush.sendNotification(subscription, payload, PUSH_OPTS);
      const apnsId = res && res.headers ? (res.headers['apns-id'] || res.headers['apns-unique-id'] || '') : '';
      console.log(`  push accepted: status=${res ? res.statusCode : '?'}${apnsId ? ` apns-id=${apnsId}` : ''}`);
      remState.lastSent[task.id] = parts.dateStr;
      stateChanged = true;
      sentCount++;
    } catch (err) {
      console.error(`Failed to send for task ${task.id}:`, err.statusCode || '', err.body || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        subscriptionDead = true;
      }
    }
  }

  if (subscriptionDead) {
    // Deliberately NOT clearing data.pushSubscription — that would mean writing
    // productivity_data.json, which is exactly the data-loss risk this design removes. Recorded in
    // the state file instead; reminders simply stop until re-enabled in Settings.
    console.log('Push subscription is no longer valid. Re-enable reminders in the app Settings to fix.');
    remState.subscriptionDead = new Date().toISOString();
    stateChanged = true;
  } else if (remState.subscriptionDead) {
    delete remState.subscriptionDead;
    stateChanged = true;
  }

  if (stateChanged) {
    remState.updatedAt = new Date().toISOString();
    // Drop entries for tasks that no longer exist, so this file can't grow without bound.
    { const live = new Set(allTasks.map((t) => t.id)); Object.keys(remState.lastSent).forEach((k) => { if (!live.has(k)) delete remState.lastSent[k] }) }
    console.log(`Writing ${STATE_FILE} — productivity_data.json is never modified by this script.`);
    const patchRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${GIST_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify(remState, null, 2) } } }),
    });
    if (!patchRes.ok) {
      console.error(`Failed to write back to Gist: ${patchRes.status} ${patchRes.statusText}`);
      process.exit(1);
    }
  }

  console.log(`Done. Sent ${sentCount} reminder(s).`);
}
