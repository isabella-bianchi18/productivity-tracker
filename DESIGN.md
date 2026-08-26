# Productivity Tracker — Design Document

> **Maintained by Kiro.** Updated every time code changes. This is the single source of truth for app architecture, data flow, and known behaviors.

---

## 0. Picking this up again — read this first

Last worked: **2026-08-26**, ending at **5.19.0**. Eleven fix passes: 5.9.0/5.10.0/5.11.0 audits,
5.12.0 against four user-reported bugs, 5.13.0 closing D1, 5.14.0 fixing the blank-screen cold start,
5.15.0 making the reminder inputs observable, 5.16.0 clearing legacy-task cruft, 5.17.0/5.18.0 the
pull and push safety guards, 5.19.0 making the 5.16.0 cleanup actually persist. See 12.1 for what
still needs pushing.

**A correction written with `saveL()` does not survive.** The startup pull replaces `D` wholesale
moments later. Any startup repair that must last has to be re-applied after the pull and marked
dirty — see 12.1. This bit the 5.16.0 reminder cleanup for three versions without being noticed.

**Three days of data were lost on 2026-08-26 and recovered from Gist revision history.** Read D3 and
D4 in §11.1 before touching sync. Both directions are now guarded — receive-side in 5.17.0 (D3),
send-side in 5.18.0 (D4). Last-write-wins on `_lastModified` alone is **not** sufficient, because
"last write" can come from a copy that has been closed for days and will carry the newer timestamp.
Neither guard is cosmetic; do not simplify either away.

**Open: a 21:00 reminder arrives just after local midnight.** Best current explanation, not yet
confirmed: `settings.timezone` was **absent** from the Gist (these reminders predate the app ever
recording it), so the job fell back to `'UTC'` and sent at 21:00 UTC = **17:00 Eastern**; with the
pre-5.13.0 script there was no TTL, so the message sat queued until the phone next woke. 5.15.0
refreshes the timezone on every app load, which should fix it going forward.

**Evidence that pinned the send time** — and the lesson: an Actions log at **19:57** local read
`already sent today`, which the gate makes impossible for a 21:00 reminder. That single line disproved
three earlier hypotheses (stale queued notification, an ICU `hour12` quirk, phone-side delivery lag)
and is the only reason the UTC-fallback theory surfaced. **Get the log before theorising.** Confirm via
`reminder_state.json` → `updatedAt`: ~`21:00Z` means the UTC fallback, ~`01:00Z` means it really did
send at 21:00 local and the theory is wrong.

> **⚠️ Deploy hazard, learned the hard way at 5.13.0.** `index.html`, `sw.js` and
> `scripts/check-reminders.js` were pushed but **`.github/workflows/check-reminders.yml` was not**, so
> the script fix went live while the cron change silently didn't. The symptom (a reminder still
> arriving late) looked like a code bug. **After any push, verify each changed file on `main`**, not
> just the ones you think matter:
> `https://raw.githubusercontent.com/isabella-bianchi18/productivity-tracker/main/<path>`.
> The workflow file is the easiest to forget because it lives outside the app tree.

**There is no longer a known data-loss path.** D1 is closed: `check-reminders.js` never writes
`productivity_data.json` at all now (§8). If you are tempted to make that script write app data
again, read §8 first — it will reintroduce the bug.

**The headline lesson is still §3.7:** a plan-timer completion is invisible to any code that scans
`h.taskId`, because the real record lives in the grouped row's `planTasks[]`, which has no `taskId`.
Three separate reported bugs traced back to it. Read §3.7 before writing any new query over
`pointsHistory`.

One reported bug is **still unresolved and needs data from the user**: a count-based daily task's
streak reading wrong. Two real defects were found in that area but neither was confirmed as the
symptom — see 11.2 C14/C15.

**Where to start, depending on what you want to do:**

| Goal | Read |
|------|------|
| Fix another bug from the backlog | §11, ordered by priority. §11.1 needs your decision first |
| Touch anything that sums or counts `pointsHistory` | §3.4 — the bookkeeping-row rule. This caused 5 separate bugs |
| Ask "when was this task last completed / was it done today?" | §3.7 — **never** scan `h.taskId` yourself, and never read `task.lastCompleted` |
| Touch any date/period comparison | §3.6 — `localISO()` stores local time with a lying `Z` |
| Change when a task counts as "done" | §4.4.1 — "done" is scoped per surface, not global |
| Touch recurring cadence | §4.4.2 — one canonical definition, mirrored in the reminder script |
| Verify a change | §12 "Verifying a change" — the headless harness recipe, including the gotchas |

**Four invariants that are easy to break and were each the root of multiple bugs:**
1. Aggregations go through `realEntries()`, never raw `D.pointsHistory` (§3.4).
2. Period boundaries come from `localDateStr()`/`periodStartStr()`, never `toISOString()` (§3.6).
3. An in-plan goal never writes `lastCompleted`/`completed` (§4.4.1).
4. "Was this completed?" goes through `taskCompletedInEntry()` / `lastCompletionDateStr()`, never a
   hand-rolled `h.taskId` scan and never `task.lastCompleted` (§3.7).

**Verification is not optional for ledger/sync/timer changes.** There's no test runner, but the
inline script runs headlessly in ~40 lines of Node — recipe in §12. Every fix in 5.9.0–5.11.0 was
paired with a negative control (revert the fix, confirm the test fails). That practice caught three
tests of mine that were passing for the wrong reason, and two bugs in the harness plumbing itself.

---

## 1. Overview

Single-file PWA (`index.html` + `sw.js`) for personal productivity tracking. Vanilla JS, no build tools, no frameworks. Data persists in `localStorage` (`pt_v3` key) and optionally syncs via a GitHub Gist.

- **GitHub repo**: https://github.com/isabella-bianchi18/productivity-tracker
- **GitHub Pages**: https://isabella-bianchi18.github.io/productivity-tracker/
- **Local dev**: User opens `file:///...productivity-tracker/index.html` directly in browser.
- **Current version**: 5.17.0 (APP_VERSION in index.html, CACHE_VERSION in sw.js — always bumped together)

---

## 2. File Structure

```
productivity-tracker/
├── index.html          — the entire app (HTML + CSS + JS in one file)
├── sw.js               — service worker (cache-busting, offline support)
├── manifest.json       — PWA manifest (name: "Done!", standalone display)
├── appicon.png         — app icon (180×180, declared at 192 and 512 in manifest)
├── scripts/
│   ├── check-reminders.js — GitHub Actions script for push notifications
│   ├── send-test-push.js — one-off "does push work at all" probe (manual only)
│   └── package.json      — pins web-push 3.6.7; the Action runs `npm install` here
├── .github/workflows/
│   ├── check-reminders.yml — cron */5, the ONLY scheduled sender
│   └── test-push.yml       — `workflow_dispatch` only, no schedule; runs send-test-push.js
├── theme-sampler.html  — standalone sampler (dev-only, not linked from app)
├── pet-sampler.html    — standalone sampler (dev-only)
├── sound-sampler.html  — standalone sampler (dev-only)
└── DESIGN.md           — this file
```

---

## 3. Data Model (`D` object, stored in localStorage as JSON)

This is the literal `DEFAULT_DATA` in index.html. Keep it in sync — several keys previously
documented here were never actually in it.

```javascript
const DEFAULT_DATA = {
  tasks: [],              // Array of task objects
  points: 0,             // Current spendable point balance
  pointsHistory: [],     // All earned/spent entries (the ledger)
  rewards: [],           // Redeemable rewards
  techniques: [],        // Anti-procrastination techniques
  metrics: [],           // Daily habit/feeling trackers
  settings: {            // See 4.2 — pushed to the Gist, but never pulled back
    gistId: '',
    token: '',
    dailyGoal: 0,        // Derived from dailyGoalLog[today()] on pull
    theme: 'default'     // 'default' | 'seasonal' | specific theme name
  },
  dailyGoalLog: {},      // {date: goalValue} — synced, authoritative
  streak: 0,
  fractional: 0,         // Accumulated fractional timer points
  groupOrder: [],        // Legacy (unused; position in D.tasks determines order)
  plan: [],              // Today's plan items
  savedPlans: [],        // [{name, items:[taskIds], rewards?}]
  planSectionRewards: {},// {sectionIdx: [rewardIds]}
  groceries: [],         // [{name, notes, checked}]
  recipes: [],           // [{name, items:['ingredient']}]
  pushSubscription: null // Web Push subscription, consumed by scripts/check-reminders.js
};
```

**Created lazily, not in DEFAULT_DATA.** These appear on `D` the first time something writes
them, so every read must tolerate `undefined`:

| Key | Written by | Notes |
|-----|-----------|-------|
| `_lastModified` | `save()` / `saveDirty()` | Sync conflict detection |
| `_lastDay` | `checkDayChange()` | Once-per-day gate |
| `_unlockedAchievements` | `checkAchievements()` | Seeded on first run |
| `_lastLevel` | `checkAchievements()` | Guard must be `== null`, not `!x` — level 0 is falsy |
| `_highScoreShown` | `checkHighScores()` | `{date_label: true}`, grows unbounded |
| `_planFired` | `setPlanFiredToday()` | `{today: [sectionIdx]}` — plan sections already paid a bonus. **Must stay in `D`** (it gates points, so it has to sync); only today's key is kept |
| `_lastRecap` | `showWeekRecap(true)` | Monday-of-week string |
| `longestStreak` | `updateStreak()` | Recomputed from a 365-day window |
| `settings.timezone` | either reminder modal | IANA name; `check-reminders.js` needs it |

### 3.1 Task Object
```javascript
{
  id: 'base36timestamp+random',
  name: 'string',
  type: 'one-time' | 'recurring' | 'daily' | 'evergreen',
  category: 'work' | 'home' | 'growth',
  timeBased: bool,       // mutually exclusive with countBased
  countBased: bool,
  points: number,        // flat points (non-time/count tasks)
  ptsAmount: number,     // for time/count: X pts per Y units
  ptsPerMinutes: number, // for time-based
  ptsPerCount: number,   // for count-based
  countUnit: 'string',
  cadenceDays: number,   // recurring only
  lastCompleted: 'ISO string' | null,
  completed: bool,       // one-time only
  completedAt: 'ISO',
  createdAt: 'ISO',
  archived: bool,
  pinned: bool,
  group: 'string' | undefined,
  goal: { target: number, period: 'daily'|'weekly'|'monthly'|'annually'|'hourly'|'total' } | undefined,
  goalSkips: ['date strings'],   // preserves streak — HISTORY, see 6.3
  hiddenToday: ['date strings'], // "not today" — only ever tested against today
  dueEarly: 'date string',      // forces task visible today regardless of cadence/completion
  goalStreakBank: number,        // banked streak when goal target changes
  reminder: {                    // optional; drives scripts/check-reminders.js
    on: bool,
    time: 'HH:MM',               // 24h, local to settings.timezone
    freq: 'recurring-due' | 'daily' | 'weekly' | 'monthly' | 'once',
    days: [0-6],                 // freq 'daily' — which weekdays
    weekday: 0-6,                // freq 'weekly'
    dayOfMonth: 1-31 | 'last',   // freq 'monthly'
    date: 'YYYY-MM-DD',          // freq 'once'
    lastSent: 'YYYY-MM-DD' | null // de-dupe, written back by the Action
  }
}
```

`freq: 'recurring-due'` is set only for `type: 'recurring'` tasks (see `showRecurringReminderModal`);
`check-reminders.js` short-circuits on `task.type === 'recurring'` before reading `freq`.

### 3.2 Plan Item
```javascript
{ type: 'task', id: 'taskId', planGoal?: {target, unit} }
{ type: 'break', savedPlanIdx?: number }
{ type: 'header', savedPlanIdx?: number }
```

### 3.3 History Entry
```javascript
{
  date: 'ISO string',
  task: 'display name (may include ✅)',
  taskId: 'string' | null,
  points: number,
  type: 'earned' | 'spent',
  category: 'work'|'home'|'growth',
  taskType: 'one-time'|'recurring'|'daily'|'evergreen',
  minutes?: number,
  seconds?: number,
  count?: number,
  countUnit?: string,
  bonus?: number,
  rate?: string,
  planTasks?: [{taskId,name,minutes,seconds,points,completed,count,...}], // grouped plan entry
  _tracking?: true,      // plan-mode per-task tracking entry (hidden from UI)
  originalDate?: string  // if date was edited
}
```

### 3.4 Bookkeeping rows vs real rows — **read this before writing any aggregation**

A plan-timer session (`stopSW`/`stopPM` in plan mode) writes **three kinds of row**:

| Row | Points | Purpose |
|-----|--------|---------|
| `⏱️ Plan` / `🍅 Plan` (has `planTasks`) | real total | The one true scoring row for the session |
| `⏱️ <task>` / `🍅 <task>` with `_tracking: true` | 0 | Feeds per-task goal progress (carries `minutes`/`count`) |
| `<task> ✅` with `points: 0` | 0 | Feeds `isDoneToday`/`recurElapsed`; one per completion tap |

The bookkeeping rows duplicate minutes and counts the grouped row already accounts for. Summing
or counting raw `D.pointsHistory` therefore **double-counts time and multiplies row counts** — a
single 4-task session used to emit ~9 rows.

```javascript
isBookkeepingEntry(h)   // _tracking, or 0-point ✅ marker
realEntries(list?)      // list (default D.pointsHistory) minus bookkeeping rows
entryTaskCount(h)       // grouped row -> completed sub-task count; otherwise 1
```

**Rule: anything user-facing that sums or counts the ledger goes through `realEntries()`.**
Current callers: history day summary, history calendar dots, `getWeekRecap()`,
`getAchievements()`, `showTaskDetail()`.

Points totals are safe either way (bookkeeping rows are 0 points), so `getLevel()` and the
header's lifetime figure are unaffected — but use `realEntries()` anyway for consistency.

### 3.5 Category attribution

Timer and grouped plan rows carry no `category` of their own. A grouped row's points and minutes
belong to its `planTasks`, which can span categories.

```javascript
entryCategory(e)                  // e.category, else the linked task's category, else ''
entryMatchesCat(e, cat)           // grouped rows match if ANY sub-task matches
entryFieldForCat(e, cat, field)   // grouped rows contribute only matching sub-tasks
```

Without these, plan sessions vanished entirely from a category-filtered history view.

---

### 3.6 Date & period boundaries — **read before touching any date comparison**

`localISO()` stores **local wall-clock time with a trailing `Z`**. That `Z` is a lie, and it is
load-bearing: `rInsights` relies on it (`new Date(h.date).getUTCHours()` yields the local hour).

The consequence: every period-boundary string compared against `h.date` must also be built from
**local** components. `Date#toISOString()` converts to real UTC and shifts the boundary by the
timezone offset.

| Helper | Returns |
|--------|---------|
| `today()` | local date, `YYYY-MM-DD` |
| `localDateStr(d)` | local date of `d` |
| `localHourStr(d?)` | `YYYY-MM-DDTHH`, local |
| `periodStartStr(period, now?)` | start of the containing period; 13 chars for `hourly`, 10 otherwise — slice by `psStr.length` |
| `periodEndStr(period, pStart)` | exclusive end, via calendar arithmetic (DST-safe, unlike `+864e5`) |

**Never reintroduce `toISOString()` for a boundary string.** The only legitimate use is inside
`localDateStr()` itself, where the offset has already been subtracted. Symptoms it caused:
- **hourly goals never registered any progress at all** — at 14:00 EDT the comparison was `"…T14" >= "…T18"`, permanently false;
- daily/weekly/monthly boundaries were off by a day in positive UTC offsets;
- `getGoalStreak` used `toISOString()` while `getDailyStreak` used `localDateStr()`, so the two disagreed.

`scripts/check-reminders.js` solves the same problem differently — it is timezone-explicit via
`Intl.DateTimeFormat` and `D.settings.timezone`, because it runs on a UTC GitHub runner. Keep the
two in agreement conceptually; they will never share code.

### 3.7 "Was this task completed?" — **the single most repeated bug in this codebase**

A plan-timer completion is written to the ledger in **two** places, and only one of them carries a
`taskId`:

| Row | Has `taskId`? | Points | Notes |
|---|---|---|---|
| `<task> ✅` marker | yes | **0** | one per completion tap |
| grouped `⏱️ Plan` / `🍅 Plan` row's `planTasks[i].completed` | **no** | real | the authoritative record |

So both of these are wrong, and both shipped:
- scanning `h.taskId` only → misses the grouped row;
- **also** filtering out 0-point ✅ rows (which `realEntries()`/`isBookkeepingEntry()` correctly do,
  §3.4) → now misses *both*, and the task looks like it was never completed at all.

`showTaskDetail` managed to do exactly that: it stripped 0-point ✅ markers, then `taskViz`'s
calendar filtered the remainder **for** ✅ — mathematically guaranteed empty. A task completed in the
plan every day showed "No history yet.", `—` in all four stat boxes, and "never completed" on its
card, while the *same* task was correctly sleeping because `recurElapsed()` did look inside
`planTasks`.

Reading `task.lastCompleted` instead is not an escape hatch. It is legitimately absent by design
(an in-plan goal never writes it, §4.4.1; flat daily tasks withhold it until the goal is met;
evergreen never receives it from the plan timer), and startup orphan reconciliation (§6.7) used to
actively **delete** it for plan completions — after which the card fell back to a `taskId` scan,
found nothing, and printed "never completed".

**Use these. Do not hand-roll the query.**

```javascript
taskCompletedInEntry(t, h)   // is this ONE ledger row a completion of t? (marker OR planTasks)
lastCompletionDateStr(t)     // 'YYYY-MM-DD' of the newest completion, or null
completionDaysFor(t)         // Set of every 'YYYY-MM-DD' the task was completed
taskHistFor(tid)             // the task's history for its detail view (see below)
```

`lastCompletionDateStr()` takes a true **max by date**, not `.pop()` / `hist[hist.length-1]`. The
history-edit modal can change an entry's date without re-sorting `pointsHistory`, so array position
is not chronological order.

`taskHistFor(tid)` returns real standalone rows (bookkeeping excluded, as before) **plus a synthetic
row per matching `planTasks` entry**. A plan session therefore contributes exactly once, so minutes
and counts are not double counted — verified by assertion, since getting this wrong reintroduces the
§3.4 doubling from the other direction.

`recurElapsed()` is now just `lastCompletionDateStr()` plus a day-count, and
`scripts/check-reminders.js` mirrors the predicate as its own `taskCompletedInEntry()` —
**keep the two in sync** (§8).

**Known remaining gap:** a task worth **0 points** produces rows that satisfy `isBookkeepingEntry()`
(`points === 0 && task includes ✅`), so even its *direct, non-plan* completions are discarded by
every `realEntries()` surface, and it reads "No history yet." forever. A clean discriminator exists
— `completeTask` always sets `category` and `taskType`, the plan-timer markers never do — but it was
left alone in 5.12.0 because it changes `realEntries()` globally. See 11.2 C16.

## 4. Core Architecture

### 4.1 Render Cycle
- `render()`: rebuilds entire `#app` innerHTML, then calls `bindAll()`.
- All event handlers are rebound on every render (no persistent listeners except global drag/sync).
- `tickRender()`: lightweight update for timer display only (avoids full re-render during active timer).
- `renderTasksBody()` / `renderGroceryBody()`: partial re-render + rebind, used by the search inputs so typing doesn't blow away focus.

**Escaping — `esc()`.** Every view is built by string concatenation into `innerHTML`, so all
user-entered text (task / reward / grocery / recipe / group / metric / technique names, notes,
count units, search terms) **must** be wrapped in `esc()`. Unescaped, a value containing `"`
truncates whatever attribute it lands in — a grocery item named `6" shaft` breaks its own edit
form and loses the rest of the field — and `<` can swallow a whole card.

`esc()` on a `data-*` attribute is transparent to the handlers: `dataset.foo` reads back the
decoded value, so `data-grp="${esc(g)}"` still compares equal to `t.group`.

Exception: `${g}` inside the Gist API URLs is a gist ID, not markup — do not escape those.

### 4.2 Persistence & Sync
| Function | Purpose |
|----------|---------|
| `saveL()` | Write D to localStorage only. Does **not** mark dirty or push. |
| `save()` | Filter corrupted plan entries + set `_lastModified` + set `localDirty` + saveL + debouncedPush |
| `saveDirty()` | Currently **byte-identical to `save()`**, including the plan filter. Kept only because ~40 call sites use it; collapse them when convenient. |
| `gistPush()` | PATCH to Gist API. Strips credentials from payload. Clears `localDirty` **only on a confirmed `r.ok` and only if `_lastModified` did not change during the request** — clearing it up front meant a failed push (offline, expired token) left data unpushed with nothing to retrigger it. |
| `gistPull()` | GET from Gist. Returns `'updated'` (new data applied), `'current'` (remote not newer), or `'blocked'` (refused by the safety guard below — `D` untouched). Uses `If-None-Match:''` to bust API cache. Increments `dataGen` when it replaces `D`. **Callers must treat `'blocked'` as a failure**: it is truthy, so `ok ? 'Pulled!' : 'Failed'` reports success for a refused pull. |
| `startAutoSync()` | 3-second interval pull. Only renders on `'updated'`. Suppressed during modals/focused inputs with content. |

**`settings` is pushed but never pulled.** `gistPush` strips only `token` and `gistId`, so
`dailyGoal`, `theme`, and `timezone` *do* reach the Gist — `check-reminders.js` depends on
`settings.timezone` being there. `gistPull` then discards the remote `settings` and keeps the
local object, which is what makes it feel device-local. Today's goal is recovered separately by
deriving it from the synced `dailyGoalLog`.

**Conflict resolution**: Last-write-wins via `_lastModified` timestamp. Pull skips overwrite if remote ≤ local.

**Pull safety guard (5.17.0).** Last-write-wins alone is not safe, because "last write" can come
from a copy of the app that has been closed for days. `gistPull()` now runs `pullLossCheck(remote)`
after the timestamp comparison and returns `'blocked'` instead of replacing `D` when either:

- the remote has **fewer than `local − max(10, 10% of local)` history rows**, or
- local has tasks and the **remote has none**.

`pointsHistory` only ever shrinks by targeted deletion (`removeHistoryRows`, deleting a single
entry, goal-bonus recalc) — there is no pruning anywhere — so a large drop arriving from the Gist
is never a legitimate edit. On a block, `showPullGuard()` offers "keep this device's data" (which
sets `pullGuardMuted` and immediately re-pushes local, repairing the Gist so other devices stop
tripping the same guard) or "use the cloud copy anyway" (records the remote's signature in
`pullGuardAccept` so the next pull lets it through).

Three things this must keep doing, all covered by the harness in §11.1/D3:
`pullGuardMuted` stops the 3-second poll re-prompting; the prompt is suppressed while another
modal is open; and the startup pull skips `showStartupModals()` on `'blocked'` so the version
popup can't paint over the one question the user needs to answer. A first sync onto a fresh
install must still work — hence the `!lr && !lt` early return.

**Push side (5.18.0, D4).** `gistPush(force)` applies the mirror-image check via `pushLossCheck()`,
comparing local against `remoteSeen` — what `gistPull()` last observed in the Gist, recorded on every
branch including `'current'` and `'blocked'`, so it normally costs no extra request. `peekRemote()`
covers the cold-start case where a `save()` beats the first pull. A blocked push returns `'blocked'`
and leaves `localDirty` set, so the change retries rather than being dropped.

**Callers must compare against `true`, not truthiness.** Both `gistPush` and `gistPull` return
`'blocked'`, which is truthy; `ok ? 'Pushed!' : 'Failed'` reports success for a refused write. The
four call sites in Settings (`ssv`, `spl`, `spu`) and `showPullGuard` are already correct.

**`dataGen`**: incremented on every pull that replaces `D`. Any deferred callback holding a
snapshot of `D` must capture `dataGen` and bail if it changed — see 4.4.

**Push triggers**: 
- 2s debounce after any `save()`/`saveDirty()` 
- Immediate on `visibilitychange:hidden` or `pagehide` (only if `localDirty`)

**Pull triggers**:
- Every 3s (auto-sync interval)
- On `visibilitychange:visible`
- On app startup

**Rate limit**: 3s polling with `If-None-Match:''` deliberately defeats the API cache, so every
poll counts — roughly 1,200 requests/hour per open tab against GitHub's 5,000/hour.

### 4.3 Timer State (`T` object, in-memory only)
```javascript
T = {
  running, paused, mode: 'sw'|'pm'|null,
  start, elapsed, workDur, breakDur, phase: 'work'|'break',
  note, taskId, pts, per,
  planMode, planQueue:[], planTimes:{}, planCurrentStart,
  planCompleted:[], planCounts:{},
  totalWork, totalBreak, awaitingAck   // startPM sets these; startSW omits them
}
```
- `T.planFlatDone` is **not in any initializer** — `markDoneIfGoalMet()` creates it lazily. It is only valid during an active plan-mode session, so every read must be gated with `T.planMode&&` (or sit inside an `if(T.planMode)` block) and use `?.`.
- `startSW()` omits `totalWork`/`totalBreak`/`awaitingAck`; readers coerce, but don't rely on it.
- **Accumulating time onto a plan task requires `T.running && T.phase!=='break'`.** `stopSW`, `stopPM`, `#plan-skip`, and `pause()` all use this guard. Without it in `pause()`, pausing during a pomodoro break credited the break seconds as work on the current task.

### 4.4 Completion Logic (Single-Sourced)
| Function | Scope | Used By |
|----------|-------|---------|
| `oneTimeDone(t)` | Is a one-time task fully complete? | visibleTasks, sleepingTasks, plan available filter |
| `planTaskDone(t, planGoal)` | Is a task done in plan context? (includes active timer state) | rPlan, checkPlanComplete |
| `completeTask(tid, mins, finished)` | Execute a completion action | cbtn click, timer stop, group-done |

**Undo** (`completeTask`, and the `.grp-done` bulk action):
- Replaces `D.tasks[idx] = prev` (full object replacement, NOT `Object.assign`) so keys that shouldn't exist post-undo are actually removed.
- Removes history rows **by object identity** via `removeHistoryRows(rows)`, and backs the balance out by that function's returned delta. It must never set `pointsHistory.length` to a captured snapshot: the undo toast lives 4s, auto-sync polls every 3s and is *not* suppressed by a toast, so a pull can replace `D` mid-window and an absolute length would truncate freshly synced history.
- Captures `dataGen` and refuses with a toast if it changed. Leaving the completion in place is the safe failure mode.

**Retirement**: see 4.4.1 — "done" is per-surface, and an in-plan goal never writes `lastCompleted`.

**Timer point/bonus ordering**: `checkGoal()` totals the day from `pointsHistory` via
`ptsForDay()`, so it must be called **after** the session row is pushed. Calling it before (as all
four timer stop paths used to) meant the crossing session's own points weren't counted and the
daily bonus silently didn't fire.

### 4.4.1 "Done" is scoped to a surface — do not collapse it into one flag

There is no single global notion of "this task is finished." Each surface answers a different
question, against a different threshold:

| Surface | Question | Threshold | Implementation |
|---|---|---|---|
| **Tasks tab** | Am I done with this *task* today? | the **task's own** goal | `sleepTarget()` → `dailyRetiredToday()`, `recurIsDue()`, `oneTimeDone()`; writes `lastCompleted`/`completed` |
| **Plan tab** | Am I done with what I *committed to* today? | the **plan's** goal | `planTaskDone(t, planGoal)` — strike-through and dimming only |
| **Timer** | Is the current item finished? | whichever context it was launched from: the **plan goal** in plan mode (`__plan__`), the **task goal** for a single selected task | `markDoneIfGoalMet()` → `T.planCompleted` |

A task can legitimately read as done on one surface and open on another, and that is correct:
hitting an in-plan goal of 1 on a 3/day task finishes it *in the plan* while the Tasks tab still
shows 1/3 and keeps reps 2 and 3 available.

**An in-plan goal must never touch `lastCompleted`/`completed`.** It describes today's commitment,
not the task. Two bugs came from blurring this:
- An earlier attempt set the Tasks-tab threshold to `min(taskGoal, planGoal)`, so a plan goal of 1 hid a 3/day task from the Tasks tab entirely.
- `visibleTasks()` used a bare "any ✅ today" test that ignored the goal, so a 3/day task **vanished from the Tasks tab after the first completion** — reps 2 and 3 were unreachable there. That silently overrode `completeTask`'s careful `lastCompleted` gating, and is what `dailyRetiredToday()` fixes.

```javascript
sleepTarget(task)         // the task's own goal target; null => one completion retires it
dailyRetiredToday(task)   // Tasks-tab "finished today?" for daily tasks
taskProgressWithSession(task, sessionSecs, sessionCount, sessionFlatDone)
```

`taskProgressWithSession()` takes the session's contribution as arguments because `stopSW`/`stopPM`
decide whether to retire *before* pushing that session's ✅ markers and `_tracking` rows.

The plan-timer stop paths also `delete t.dueEarly` on retirement, matching `completeTask`. Without
that, a `dueEarly` task stayed visible forever, because `visibleTasks()` short-circuits on
`dueEarly === today()`.

### 4.4.2 Canonical "is this recurring task due?"

`recurIsDue(t)` / `recurIsResting(t)` are the single source of truth. Cadence is measured in
**calendar days** since the last completion via `recurElapsed()`, which reads the ✅ history —
including completions recorded inside a grouped plan entry (`planTasks`) — and **not**
`task.lastCompleted`.

Never compare raw elapsed milliseconds against `lastCompleted`. Cadence 1 completed yesterday at
23:00 is due today by calendar reckoning but only "0.5 days ago" by wall clock, so the two disagree
every evening. That divergence is why the Plan tab could render `○` on a card whose own tap handler
then announced "This task is complete."

Callers: `visibleTasks`, `sleepingTasks`, `planTaskDone`, `rPlan`'s available filter,
`showTaskDetail`, and the `.plan-done-btn` handler. `recurElapsed()` is still used directly where
the *magnitude* matters — overdue badge, days-left label, recurring sort.

`scripts/check-reminders.js` mirrors this with `lastCompletionDateStr()` +
`computeRecurringDueDateStr()`. **Keep the two in sync**; they cannot share code. It previously read
`task.lastCompleted`, which disagreed with the app and — because it returned `null` for a
never-completed task — meant such a task got **no reminder, ever**. It now anchors on `createdAt`
when there is no completion, which preserves the "fires once, on the day it becomes due" promise
rather than nagging every outstanding day.

### 4.5 Drag & Drop
- Engine: `initDragList(container, itemSelector, onReorder, {nestedGuard})`
- 400ms long-press to arm drag (touch), left-click-hold on desktop.
- Ignores: buttons, inputs, textareas, selects, right-clicks.
- Global `touchmove/touchend/mousemove/mouseup` handlers (one set, not per-item).
- `dragState` object (only one drag at a time), `dragJustEnded` 100ms flag.
- `nestedGuard` option: CSS selector whose children don't trigger this drag level (used for groups).

**Instances**:
| Container | Item Selector | Purpose |
|-----------|--------------|---------|
| `#groc-unchecked` / `#groc-checked` | `.groc-item` | Grocery reorder |
| `.plan-sec-items` (one per section) | `.plan-drag-item` | Plan task reorder, **within a section only** |
| `.task-bucket` | `.bucket-item` | Task+group reorder within type section |
| `.pinned-bucket` | `.bucket-item` | Pinned task reorder |
| `.grp-content` | `.bucket-item` | Within-group reorder |

`#plan-drag-container` exists in the DOM as a plain wrapper — nothing is bound to it. Cross-section
moves are done by swipe (left/right) or the desktop right-click menu, not by drag.

**`onReorder(fromIdx, toIdx)` index convention**: `toIdx` is the placeholder's position in a list
that *still includes the hidden dragged item*. Callers must compensate, and the two established
ways both work — don't mix them:
- Array-splice callers (`.task-bucket`, `.pinned-bucket`): `insertAt = toIdx>fromIdx ? toIdx-1 : toIdx`.
- Insert-before-anchor callers (`.grp-content`, `.plan-sec-items`): use `items[toIdx]` as the anchor; `undefined` means "append to the end".

**Post-drag click suppression**: `dragJustEnded` (100ms) exists because a drop landing near its
origin still fires a `click` on desktop. Only `.grp-hdr` checks it; `.tdet`, `.groc-item`,
`.sldet`, and `.plan-goal-tap` do not, so a short drag on those can open their detail modal.

### 4.6 Swipe Gestures (Mobile)
- **Swipe right** → Add to plan (purple "📋 Plan" indicator, 60px threshold)
- **Swipe left** → Pin/Unpin (amber "📌 Pin/Unpin" indicator, 60px threshold)
- Both use the same DOM structure: `.bucket-item` > `.swipe-plan` + `.swipe-pin` (opacity:0) + `.swipe-card` wrapper
- Function `rSwipeWrap(t, cardHtml)` generates this structure.
- Function `rPlanSwipeWrap(...)` generates plan-specific swipe wraps.

### 4.7 Desktop Context Menu
- Right-click on `.task-drag-item[data-id]` → shows floating `.ctx-menu` with "📋 Add to Plan" + "📌 Pin/Unpin"
- Right-click on `.plan-drag-item[data-gi]` → shows "Move to section X" options

### 4.8 Themes
- CSS variables drive all colors. `resolveTheme()` returns current theme name.
- `D.settings.theme` = `'seasonal'` (auto by month) or a specific theme name.
- Category colors (`catBg()`) can be theme-aware via `CAT_COLORS_BY_THEME`.
- Confetti function dispatched by theme name.
- Sound function dispatched by theme name — `playThemeSound()`, **live in the app**, called from `confetti()`.
- `ac()` returns a **single shared `AudioContext`** held in `_audioCtx` and resumes it if suspended. Never construct one per sound: browsers cap concurrent contexts (~6), after which the constructor throws and the `try/catch` in each sound function swallows it, so sounds silently stop partway through a session.

**Theme palette**: Each theme defines: accent, accentDark, accent2, bg, card, cardTask, cardReward, cardSleep, cardNeutral, text, textDim, border, success, successDark, warning, warningDark, danger, dangerDark.

**Month mapping** (for seasonal mode):
Jan/Feb=Winter, Mar–May=Spring, Jun=Birthday, Jul/Aug=Summer, Sep&Nov=Fall, Oct=Halloween, Dec=Christmas

---

## 5. Views & Rendering

| View | Render Function | Key Features |
|------|----------------|--------------|
| Tasks | `rTasks()` → `rTasksBody()` | Category filter, search, type buckets, groups, pinned section |
| Plan | `rPlan()` | Sections, progress bar, saved plans, section rewards |
| History | `rHistory()` | Calendar, day detail, category filter, streak info |
| Tools | `rTools()` → sub-views | SW/PM timers, rewards, techniques, metrics, insights, achievements, grocery |

### 5.1 Task Card (`rCard`)
- Shared across Tasks tab (in buckets/groups/pinned) and Plan tab.
- Contains: check button, name, badges, points, goal bar, inline log form.
- Wrapped in `.task-drag-item[data-id]` with `user-select:none`.
- Wrapped further in `.bucket-item` (with swipe indicators) for Tasks tab.
- In Plan: wrapped in `.plan-drag-item.plan-sw-wrap[data-gi]` > `.plan-swipe-card` > `.tcard.plan-goal-tap`.

### 5.2 History Filter
- `histCatFilter` state: 'all' | 'work' | 'home' | 'growth'
- Entry list and day summary both run over `realEntries()` (3.4) then `entryMatchesCat()` (3.5). They must stay in agreement — the summary previously skipped the bookkeeping filter, which is what made "⏱ Xm logged" roughly double on plan days.
- Under a category filter, a grouped plan row contributes only its matching sub-tasks' points and minutes (`entryFieldForCat`), rather than dropping out.
- The day summary's points figure **excludes `🎯 Daily goal bonus`**, matching `ptsForDay()` and therefore the calendar cell. Including it made the panel disagree with the cell above it on any day the goal was hit.

---

## 6. Key Behaviors & Rules

### 6.1 Task Visibility

`visibleTasks()` and `sleepingTasks()` are complements. Both express the **Tasks-tab** notion of
done (4.4.1), never the plan's:

| Type | Visible while |
|------|---------------|
| `one-time` | `!oneTimeDone(t)` |
| `recurring` | `recurIsDue(t)` (4.4.2) |
| `daily` | `!dailyRetiredToday(t)` — its **own** goal if it has one, else no ✅ today |
| `evergreen` | always |

Filtered out of both lists first: `archived`, `hiddenToday.includes(today())`,
`goalSkips.includes(today())`.

- `dueEarly === today()` overrides resting for both recurring and daily, and is deleted when the task retires (`completeTask`, `stopSW`, `stopPM`).
- A daily task with a **3/day** goal stays visible until all 3 are logged. It used to disappear after the first — see 4.4.1.

### 6.2 Streaks

**Skip semantics (canonical): a skipped period neither counts toward a streak nor breaks it — it
is stepped over.** `getGoalStreak` and `getDailyStreak` now agree on this. `getGoalStreak`
previously did `streak++` on a skip, which meant a task that had only ever been skipped reported a
365-day streak.

- `getGoalStreak(task)`: consecutive periods where the goal was met, walking back from the current period. An **incomplete current period doesn't break the run** either — it just doesn't count yet. Adds `task.goalStreakBank`.
- **`getGoalStreak`/`getDailyStreak` are memoised wrappers** around `computeGoalStreak`/`computeDailyStreak`, cached per render pass in `_streakMemo`. Invalidated by `clearStreakMemo()`, called from `saveL()` (the choke point every mutation funnels through) and the top of `render()`. If you add a mutation path that bypasses `saveL()`, clear the memo yourself. Both compute functions build a per-day index of the task's rows once instead of re-scanning `pointsHistory` per period. Measured ~170 ms → ~27 ms per pass at 40 tasks / ~11,000 rows (see 11.3 for the caveat).
- Both still count `taskId`-bearing rows only and do **not** look inside `planTasks`, unlike every other completion query (§3.7). That inconsistency is deliberate and tracked as C18.
- `getDailyStreak(task)`: consecutive days with ✅ entries, same skip rule.
- `getGoalStreak` handles `daily`/`weekly`/`monthly`; `hourly`/`annually`/`total` return the bank only (no period walk implemented).
- Boundaries come from `localDateStr()`/`periodEndStr()` — see 3.6.
- `updateStreak()`: daily-goal streak (different from per-task streaks). Recomputed over a 365-day window, so a longest streak older than that is lost.

**`task.goalSkips` is durable history, not transient state.** Both streak functions look backwards
through it. `checkDayChange()` must not prune it to today — doing so broke every streak the morning
after a skip, which is the exact opposite of what "⏭️ Skip today (preserve streak)" promises. It is
trimmed at 400 days, comfortably past the 365-period lookback. `hiddenToday` *is* only ever tested
against today, so pruning that one is fine.

### 6.3 Weekend Auto-Skip
- Runs once per day (gated by `D._lastDay`), inside `checkDayChange()`.
- On Saturday/Sunday: all non-archived `work` category tasks get auto-skipped (if eligible) or auto-hidden.
- Mutations here only `saveL()`, so they don't reach the Gist until some later `save()`.

### 6.4 Timer (Stopwatch/Pomodoro)
- pts/min is **optional** for non-time-based tasks. If empty, 0 time-based points; real points from completion dialog.
- `stopSW()`/`stopPM()` handles ALL point addition and history logging at session end.
- Plan mode: `T.planFlatDone[id]` incremented during session for flat tasks. Only valid when `T.planMode===true`.
- One `<task> ✅` marker is logged **per completion tap** (`T.planFlatDone[id]` times), in both `stopSW` and `stopPM`. These rows are what flat-task goal progress counts, so logging a single marker for repeated taps under-reports the goal.
- `checkGoal()` runs **after** the row is pushed (see 4.4).

### 6.5 History Display Rules
The detail list shows `realEntries()` (3.4) — that is, everything **except** `_tracking` rows and
0-point ✅ markers — then applies the category filter. There is no `seconds`/`points`/`planTasks`
condition; a 0-point Quick Log with no ✅ does appear.

Note that `_tracking` rows also carry `seconds`, so `seconds` cannot be used to tell a real session
from a bookkeeping row. Use `_tracking`.

### 6.6 deleteHistEntry
- Top-level branch: resets `lastCompleted` from remaining **✅** entries only.
- Clears `dueEarly` if no today completions remain
- For one-time: resets `completed`/`completedAt` if no ✅ entries remain
- Plan group entries: also cleans up associated 0-point tracking/marker entries (5s proximity)
- **Inconsistency (open)**: the `planTasks` branch recomputes `lastCompleted` from *all* earned entries, not just ✅ ones, so deleting a plan session can leave a task asleep on the strength of a partial "worked on it" row. Startup orphan reconciliation (6.7) papers over it on the next load.

### 6.7 Orphan Reconciliation (startup)
- On load: scans all tasks. If `lastCompleted` points to a date with no completion in history → clears it.
- If one-time `completed=true` but no completion in history → resets.
- Prevents stale completion flags from old undo bugs.
- **Both checks honour plan-timer evidence (§3.7).** They used to match standalone ✅ rows only, so
  they actively deleted valid `lastCompleted` values for plan-timer completions — which is what then
  made the card say "never completed". Fixed in 5.12.0 (was C13).
- **This runs before the first paint**, so as of 5.14.0 it builds one `Map<taskId, Set<dateStr>>` in a
  single pass over `pointsHistory` instead of re-scanning history once per task. The per-task scan was
  acceptable when the test was a cheap `h.taskId` comparison; adding the `planTasks` check made it
  materially more expensive at exactly the moment the user is staring at a blank screen.

---

## 7. Service Worker (`sw.js`)

- Network-first strategy for all requests.
- Never caches `sw.js` itself (prevents update loops).
- `CACHE_VERSION` must match `APP_VERSION` — forces cache bust on every update.
- Install: `skipWaiting()`. Activate: clears old caches, claims clients.

---

## 8. Push Notifications (GitHub Actions)

- `check-reminders.yml`: runs every 15 minutes.
- Checks Gist data for tasks due today that haven't been completed.
- Sends web push notification via VAPID.
- User enrolls via `enablePushReminders()` in Settings, which writes `D.pushSubscription`.
- Reminder schedules live on `task.reminder` (3.1). Two modals: `showRecurringReminderModal` (recurring tasks, `freq:'recurring-due'`) and `showTaskReminderModal` (everything else — daily / weekly / monthly / once). Both also stamp `D.settings.timezone`.
- **De-dupe lives in a SECOND Gist file, `reminder_state.json`** — `{lastSent:{taskId:'YYYY-MM-DD'}, updatedAt, subscriptionDead?}`. **This script must never PATCH `productivity_data.json`.** Writing it stamped `_lastModified`, and `gistPull` accepts any newer remote without consulting `localDirty`, so every run could discard unpushed local edits (this was D1). The write is gone entirely rather than made safer, which is what actually closes the hole. `lastSentFor()` still reads the legacy `task.reminder.lastSent` as a fallback so the changeover doesn't re-send anything.
- **Consequence of that:** a dead subscription (404/410) is **not** cleared from `D.pushSubscription` any more — it is recorded as `subscriptionDead` in the state file and logged. Reminders silently stop until re-enabled in Settings. Surfacing that in the app would mean the client reading the state file; not done.
- **Delivery timing.** `PUSH_OPTS = {urgency:'high', TTL:3600}`: `urgency` asks the push service to deliver now rather than batching for battery, and the TTL makes a message expire after an hour instead of the default four weeks, so a 9pm reminder can't surface after midnight. The cron is `*/5` (GitHub's minimum) — since the script refuses to send before `reminder.time`, the interval *is* the lag budget. GitHub's scheduler is best-effort on top of that. `settings.timezone` silently defaults to `'UTC'`, which would make everything fire hours early; the run log prints `Checking reminders for <date> <hhmm> (<tz>)` to settle that in one line.
- The script is timezone-explicit (`Intl.DateTimeFormat` + `settings.timezone`) because it runs on a UTC runner, whereas the app relies on `localISO()`. Different mechanisms, same intent — see 3.6.
- **Its recurring due-date reckoning duplicates the app's** — see 4.4.2. Keep `lastCompletionDateStr()` / `computeRecurringDueDateStr()` in sync with `recurElapsed()` / `recurIsDue()`.
- **`isTaskDone()` decides whether to stay quiet because you already did the thing.** It goes through
  the script's own `taskCompletedInEntry()` / `completedOnDate()`, mirroring §3.7 — a completion done
  in the plan timer counts. **Evergreen is handled there too**; it used to fall through to
  `return false` ("no done state, never skip"), so an evergreen task with a daily reminder nagged
  every single day no matter how often it was actually completed. Fixed in 5.12.0.
- The time gate compares **minutes since midnight** via `hhmmToMinutes()`, and is strictly
  backward-looking, so the script **cannot** fire before the scheduled time in the configured timezone.
  It used to compare the two `HH:MM` strings directly, which is only correct while both are
  zero-padded — `"21:00" < "9:00"` is true, so one unpadded stored time meant a reminder that never
  fired at any hour. An unreadable time now blocks the send and says so in the log.
- **If a reminder fires at the wrong hour, the code is almost certainly not the cause — the stored
  inputs are.** Only two things decide the hour: `settings.timezone` and `reminder.time`. Both are now
  visible in the app under Settings → *Reminder diagnostics* (12-hour rendering, a warning for an
  unreadable time, and a warning when the saved zone differs from the device). Read that first; it
  replaces digging through Actions logs. The run log also prints `Checking reminders for <date> <hhmm>
  (<tz>)` and, on a send, `SENDING "<task>": now=… scheduled=… freq=… type=…`.
- **`settings.timezone` is refreshed on every app load** (5.15.0). It used to be written only when a
  reminder was saved, so a zone captured on another device or before a trip persisted indefinitely —
  and a zone a few hours west makes a 9pm reminder arrive just after local midnight. Because `settings`
  is pushed but never pulled (§4.2), that client-side write is the only way the correct zone reaches
  the job.
- Safe to `require()` for testing — the entry point is guarded by `require.main === module`. Needs a `web-push` stub when `node_modules` isn't installed (§12).

---

## 9. Samplers (Dev-Only)

| File | Purpose |
|------|---------|
| `theme-sampler.html` | Preview all 8 seasonal themes + confetti animations |
| `sound-sampler.html` | Audition completion sounds per theme (AudioContext-generated) |
| `pet-sampler.html` | Companion/pet concept (5 species, moods, growth stages) |

Not linked from the deployed app. No version bumps needed when editing.

---

## 10. Confirmed Sound Assignments

Dispatched by `playThemeSound(themeName)` in index.html. The sampler's names differ (`s1`, `s9`,
`s30`) — the app functions are the ones below.

| Theme | Sound | Function in index.html |
|-------|-------|----------------|
| Default | Pop (sine sweep) | `popSound()` — two sine partials |
| Fall | Leaf Crunch | `soundLeafCrunch()` — bandpass noise burst |
| Winter | Glass, crystal tap | `soundGlassTap()` — two sine harmonics |
| Spring | Warble | `soundWarble()` — sine + LFO vibrato |
| Summer | Sun Sparkle | `soundSunSparkle()` — ascending 4-tone shimmer |
| Christmas | Jingle Shake | `soundJingleShake()` — 10 random-pitched bells with inharmonic overtones |
| Halloween | Eerie Whistle | `soundEerieWhistle()` — sine + slow vibrato LFO |
| Birthday | Fanfare | `soundFanfare()` — trumpet-ish ta-da (square wave) |

---

## 11. Known Issues & Technical Debt

Mostly pre-existing, found during the 5.9.0–5.11.0 audits and deliberately left alone. Roughly in
the order worth fixing. **There is no known data-loss bug left** — D1 was the last one.

### 11.1 Resolved decisions — do not reopen these

**D1 — resolved 2026-08-23.** `check-reminders.js` used to stamp `_lastModified` on every send, and
`gistPull` accepts any newer remote without consulting `localDirty`, so every run opened a window in
which unpushed local edits could be silently discarded. Fixed by moving de-dupe state into its own
Gist file (`reminder_state.json`); the script now never writes `productivity_data.json`. Chosen over
"preserve the original `_lastModified`" (which would have stopped `lastSent` reaching the devices and
risked duplicate notifications) and over "merge `lastSent` on pull" (more moving parts in the client
for no extra benefit). **Tradeoff accepted:** a dead push subscription is no longer cleared in the
app's data — it's recorded in the state file and logged instead, so reminders just stop until they
are re-enabled in Settings. See §8.

**D3 — resolved 2026-08-26.** Data-loss incident and the pull guard (§4.2). At 07:23 local a copy of
the app that had not synced since Aug 23 was opened; it stamped a fresh `_lastModified` and pushed,
taking the Gist from 366 history rows / 1,981 points down to 291 / 1,590. Every other device then
pulled that copy and replaced its own good data. "Pull" could not undo it: the timestamp guard
refuses a remote older than local, which is precisely the case here. Recovered by downloading the
10:58 PM Aug 25 Gist revision and using **Import Backup**, which has no timestamp check
(`D = {...DEFAULT_DATA, ...imported, settings: ls}` then `saveDirty()`).

Chosen fix: refuse the incoming data and ask. Rejected "always keep the larger side automatically"
— it removes the user's say and would be wrong whenever they genuinely delete a lot. Rejected
"rolling local backup key in localStorage" as the primary fix — worth having, but it protects one
device rather than stopping the spread.

The user-facing runbook lives in `recovery/RECOVERY.md`, with `recovery/recover.ps1` to list recent
revisions by counts. Verification harness: extracts the guard + `gistPull` out of `index.html` and
runs it in a `vm` sandbox against synthetic local/remote pairs, including the real incident numbers.
Confirmed by three negative controls (disable the row check, disable the task-less check, make the
guard over-eager). **Note:** a remote that is empty trips *both* signals, so testing the task-less
branch needs a remote with 0 tasks but intact history, or the test proves nothing.

**D4 — resolved 2026-08-26.** Push-side guard, the direction that actually caused the loss.
`gistPush(force)` now runs `pushLossCheck()` before the PATCH and returns `'blocked'` instead of
writing, on the same two signals as the pull guard but measured against the Gist.

How it knows what the Gist holds without doubling request volume: `gistPull()` records
`remoteSeen = {rows, tasks, stamp}` on **every** branch that parsed the file, including `'current'`
and `'blocked'` — the branches that don't apply the data still saw it. The 3-second poll therefore
keeps it fresh for free. `peekRemote()` is the fallback for the one case that can't rely on it: a
`save()` firing before the startup pull lands. That ordering is not hypothetical — it is how the
Aug 26 incident got its opening, because line ~3688 calls `saveDirty()` on a timezone change during
load, which schedules a push 2s later regardless of whether the pull has returned.

`gistPull(force)` skips both the timestamp comparison and the loss check. Needed because the stale
copy's `_lastModified` is *newer* than the good remote's, so an ordinary pull answers `'current'` and
does nothing — the exact reason "Pull" could not rescue the user. `showPushGuard()`'s "load the cloud
copy" uses it.

If `peekRemote()` cannot read the Gist, the push proceeds. Refusing would strand local changes on the
device whenever the network is flaky, which is a worse failure than the one being prevented.

**Correction to the record:** an earlier revision of this file said D4 was "deferred at the user's
request." That was wrong. The user was offered section-clear confirmation, the pull guard, and an
import guard, and chose the pull guard; the push side was not on that list, because it was only
identified while implementing the pull guard. Do not attribute deferrals that were never offered.

**D2 — resolved 2026-08-23: yes**, an in-plan goal may be set on a task with no goal of its own.
Confirmed by the user. It has no effect on the Tasks tab (4.4.1) and only gates the plan card and the
timer queue. No code change was needed — this was already the behaviour. Do not "fix" it.

### 11.2 Correctness bugs

| # | Issue |
|---|---|
| **C18** | **Streaks are still marker-only.** `computeGoalStreak`/`computeDailyStreak` count `taskId`-bearing rows and never look inside `planTasks` (§3.7), unlike every other completion query. Markers have been written per completion tap since 5.9.0/5.11.0 so day-to-day streaks are correct, but pre-5.9.0 pomodoro plan sessions with repeat completions under-count. Deliberately left alone in 5.13.0 because the S1 work was contracted to change no numbers; fixing it is a behaviour change and should be its own version. |
| **C14** | **`getGoalProgress` counts a live plan session; `getGoalStreak` can't.** Line ~269 adds `T.planCounts[id]` / `T.planTimes[id]` / `T.planFlatDone[id]`; the streak's inner `met()` has no equivalent term, because those live in memory until `stopSW`/`stopPM` flushes them. So mid-session a card reads `30/30 · 🔥4` when the streak should be 5 — and if the session is never stopped (tab closed, PWA killed) the counts never reach `pointsHistory` at all, so that day is a permanent miss and the streak breaks. Fix by giving both a single shared `periodProgress(task, periodStart)`. **Suspected cause of the user's count-based streak report; unconfirmed.** |
| **C15** | **A 0-point count log is indistinguishable from a bookkeeping row.** `completeTask` writes one row that is both the ✅ marker and the `count` carrier, with `points = floor(count*ptsAmount/ptsPerCount)`. A coarse rate (1 pt per 10 reps, logging 5) gives 0 points, which matches `isBookkeepingEntry`. The goal bar and streak still count it (they read raw history) but every `realEntries()` surface drops it, so 🔥 and the stats disagree about the same day. Same family as C16. |
| **C16** | **A task worth 0 points reads "No history yet." forever** — its `completeTask` rows satisfy `isBookkeepingEntry` even for direct, non-plan completions (§3.7). Discriminator available: `completeTask` always sets `category`/`taskType`, plan-timer markers never do. Deferred in 5.12.0 because it changes `realEntries()` globally. |
| **C3** | **`deleteHistEntry`'s `planTasks` branch** recomputes `lastCompleted` from *all* earned rows, not just ✅ ones (6.6), so deleting a plan session can leave a task asleep on the strength of a partial "worked on it" row. Self-heals at next startup via 6.7, which is itself a smell. |
| **C4** | **Insights "Category Breakdown" ignores all timer points.** It sums `h.category`, which only `completeTask` and Quick Log set. `entryFieldForCat()` (3.5) now exists and would fix it. |
| **C5** | **Duplicate DOM ids when one task sits in two plan sections.** `plan-load`/`plan-sec-add` don't check other sections, so both cards render `id="imi-count"` / `id="ims-work"` / `id="imi-preview"`, and `getElementById` picks the first — the wrong card responds. Either dedupe on add, or key the inline form by `data-gi`. |
| **C6** | **`plan-sec-save` never links a newly saved plan back to its section** (the unlinked branch sets no `savedPlanIdx`), and "Save as new" cannot link **section 0** because it only writes to a preceding `break`. So edits after a fresh save don't sync back — which *is* the behaviour the original change request asked for. |
| **C7** | **`plan-sec-clear` on section 0 removes every `header` item**, including one a previous clear transferred to a later section, orphaning that section's saved-plan link. |
| ~~**C8**~~ | Fixed in 5.13.0. Section rewards are still keyed by array index, but `swapPlanSectionState()` / `removePlanSectionState()` are now the single sanctioned way to maintain that state and both rewards **and** the paid-bonus tracker move together. Any new code that reorders or deletes sections must call them. |
| **C9** | **On-deck queue index desync** in `rSW`/`rPM`: `onDeck` is `.filter(Boolean)`-ed but indexed against `T.planQueue[i+1]`, so one missing task shifts every row's times, points and ▲▼ buttons. |
| **C10** | **Post-drag click leaks** on `.tdet` / `.groc-item` / `.sldet` / `.plan-goal-tap` — none check `dragJustEnded`, so a short desktop drag opens the detail modal on drop. See 4.5. |
| **C11** | **Pinned-section drag reorders unrelated tasks** by splicing all pinned tasks into `D.tasks` at the first pinned index. |
| **C12** | **`stopPM` logs nothing** when stopped during a break with `T.totalWork === 0`. |
| **C19** | **`plan-load` and `plan-add-break` don't touch per-section state at all.** Both only ever append a section at the end, so today's indices stay valid and nothing is wrong — but the invariant is undocumented and one insertion in the middle would break it. If a section is ever inserted anywhere but the end, it must shift `D._planFired` and `planSectionRewards` up, mirroring `removePlanSectionState()`. |

### 11.3 Structural / performance

| # | Issue |
|---|---|
| ~~**S1**~~ | Fixed in 5.13.0 — memoised per render pass + per-day index. **4–8× faster across 6 runs (median ~7×), ~170 ms → ~27 ms per pass** on 40 tasks / ~11,000 rows, streaks verified identical to the old algorithm. Caveat: measured headlessly in Node via `vm`, so treat it as the size of the algorithmic win rather than a browser number; the run-to-run spread is machine noise. **`getGoalProgress` was not touched** and still does a full `pointsHistory` scan per call — called from `rCard`, `dailyRetiredToday`, `planTaskDone` and `completeTask`, it is now the largest remaining per-render cost. |
| **S2** | **Unbounded growth**: `D._highScoreShown` grows forever. (The `pt_firedSec_<date>` localStorage keys are gone as of 5.12.0 — that state moved into `D._planFired`, which self-prunes to today. Old keys are left behind on existing devices but are never read again.) |
| **S3** | **`deleteTask`/archive leave orphan entries** in `D.plan`, `savedPlans`, `planSectionRewards`. Rendering tolerates them; the arrays just grow. |
| ~~**S4**~~ | Fixed in 5.14.0. `render()` now runs unconditionally before the sync branch, so the first paint comes from `localStorage` and the Gist pull just corrects it. **Keep it that way** — moving the first render back inside `gistPull().then(...)` reinstates a blank white screen for the whole round trip, which is what the local copy exists to prevent. Note a version bump also empties the service worker cache (§7), so the load right after any deploy is fully network-bound regardless. |
| **S5** | **3s auto-sync poll with `If-None-Match:''`** deliberately defeats the API cache: ~1,200 requests/hour per open tab against GitHub's 5,000/hour. |
| **S6** | **`checkAchievements` retries forever** while any modal is open (1s `setTimeout`, no attempt cap). |
| **S7** | **`save()` and `saveDirty()` are byte-identical.** Collapse them (~40 call sites). |
| **S8** | **`rSW` and `rPM` duplicate a large block** of plan-display logic verbatim. |
| **S9** | **`checkPlanComplete` keeps its own copy of the section-splitting loop** instead of calling `getPlanSections()`. |
| **S10** | Dead code: `#plan-clear` handler with no matching element; `savedPts`/`savedPer` in `stopSW`; `if(!T.planMode){}`; `const bonus=0`; `planTimes:isPlan?{}:{}`; `groupOrder` in `DEFAULT_DATA`. |

### 11.4 Accepted tradeoffs

- **Gist sync is last-write-wins on the whole blob.** Dedup on pull mitigates duplicate tasks. Fine for one person with a phone and a laptop.
- **Drag requires a 400ms hold** — necessary for left-click to work on plan cards. Accepted.
- **iOS vibration** isn't supported (Apple). Theme sounds are the substitute.
- **`settings` is pushed but never pulled** (4.2). Deliberate, so credentials stay device-local.

## 12. Change Log Protocol

Every code change must:
1. Bump both `APP_VERSION` and `CACHE_VERSION`.
2. Update this DESIGN.md if the change affects: data model, function signatures, sync behavior, rendering rules, or known issues.
3. Tell the user which files need pushing.

### Verifying a change

`index.html` is a single 3,300-line file with no build step and no test runner, but the inline
script *can* be executed headlessly, which is worth doing for anything touching the ledger, sync,
or the timers:

```js
// extract and syntax-check
const code = fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
// -> write to a .js file, then: node --check that_file.js
```

To exercise it, run that code through `vm.runInContext` with a stub `document` / `localStorage` /
`navigator`. Gotchas, in the order you'll hit them:
- `D`, `T`, `view` etc. are top-level `let` bindings, so they are **not** properties of the VM
  global. Append a small bridge (`globalThis.__b = {getD:()=>D, setT:v=>{T=v}, ...}`) to reach them.
  `function` declarations *are* reachable directly.
- Stub `navigator` keys must be **absent**, not `undefined` — the app tests
  `'serviceWorker' in navigator`.
- Every stub element's `.style` needs **`setProperty`** — `applyTheme()` runs at load and calls
  `documentElement.style.setProperty('--accent', …)`.
- The sandbox object itself needs **`addEventListener`** (not just `document`): the tail of the file
  registers `window.addEventListener('pagehide', …)`.
- Set `sandbox.window = sandbox` and `sandbox.globalThis = sandbox` before `createContext`.
- `Intl` must be passed through if you touch anything timezone-related.

Pair each assertion with a negative control: revert the fix in the extracted source and confirm
the assertion fails. A test that passes before and after proves nothing. The cheap way to run a
control is a `HARNESS_MUTATE='["<exact source>","<replacement>"]'` env var that string-replaces the
fix out before the `vm` run, and to treat "0 assertions failed" under a control as a **harness bug**.

**Emoji census as of 5.14.0** (literal UTF-8, no BOM — verify before/after any scripted rewrite of
`index.html`): U+2705 ✅ = **62**, U+1F3AF 🎯 = **31**, U+1F3C6 🏆 = **6**.

Seed `localStorage['pt_v3']` **before** running the app in the `vm` if you are touching anything on
the startup path. Loading against an empty store exercises none of the reconciliation or first-paint
behaviour, and both bugs fixed in 5.14.0 were invisible without a realistic seeded profile.

A benchmark is worth writing for any performance claim — build a corpus at the scale §11.3 cites
(~40 tasks, ~11,000 rows), time the old algorithm against the new one in the same process, and assert
the results are identical. "It should be faster" is not a finding.

### 12.1 Fixed in 5.19.0

**The 5.16.0 one-off-reminder retirement never worked on a synced device.** The startup block wrote
its correction with `saveL()`, which neither stamps `_lastModified` nor pushes. The startup
`gistPull()` runs seconds later, and any newer remote replaced `D` wholesale — putting
`reminder.on:true` straight back. So the Gist kept the spent reminder enabled forever,
`check-reminders.js` kept re-evaluating it every 5 minutes, and it kept appearing in the Settings
diagnostics panel (which lists only `reminder.on===true`, so it was reporting the truth).

It could accidentally work: if the pull happened to return `'current'` the correction survived in
memory and rode along on the next `save()`. That is why it was not obvious.

Fixed by extracting the block into `reconcileLegacyTasks()` (returns whether it changed anything,
and is idempotent) and calling it from three places:

| Call site | Persistence | Why |
|---|---|---|
| Startup | `saveL()` only | Bumping the stamp before the first pull is the stale-overwrite shape from D3/D4. Do not "improve" this to `saveDirty()` |
| End of `gistPull()`, after `D` is replaced | stamp + `localDirty` + `debouncedPush()` | The correction has to reach the Gist or the reminder job never sees it |
| Import Backup handler | covered by the existing `saveDirty()` | Restoring an old backup reintroduces the old data. This is what the user actually hit after the Aug 26 recovery: the Aug 25 file predated the fix and carried the reminder back in switched on |

Guard against regression: reconciliation must only mark data dirty when it **actually changed
something**, or every pull triggers a push and devices fight each other. The harness asserts a clean
pull leaves `localDirty` false.

| Area | Change |
|------|--------|
| Reminders | Spent one-off reminders now genuinely retire, and the correction propagates to the Gist |
| Reminders | `createdAt` backfill has the same three call sites, so a restored backup no longer leaves recurring tasks unanchored |
| Plan | **Empty sections now render their ▲/▼ move buttons.** The whole button row lived inside `if(secItems.length)`, so a section could not be reordered once emptied — and emptying a section to move it is exactly when you'd want to. The `.plan-sec-move` handler is index-based and already handled empty sections; only the markup was missing |

16 reconciliation assertions + 38 sync-guard regression assertions. 3 negative controls on the
reconciliation, all discriminating — notably, reverting the pull-side call reproduces the original
symptom exactly (reminder still on after the pull, Gist still holding it on).

**Needs pushing:** `index.html`, `sw.js`, `DESIGN.md`.

### 12.2 Fixed in 5.17.0 + 5.18.0

Sync safety guards in both directions, after three days of data were lost and recovered (D3/D4,
§11.1). 5.17.0 was never deployed, so both land in one push; the version is still bumped twice in
case it was.

51 harness assertions; 5 negative controls, all discriminating. Two lessons worth keeping: one
control initially showed 0 failures, which exposed a test that wasn't isolating the branch it claimed
to cover (an empty remote trips *both* signals — see D3); and deleting the `remoteSeen` assignment is
the control that proves the push guard is using the cached snapshot rather than issuing its own GET.

| Area | Change |
|------|--------|
| Sync | `gistPull(force)` returns `'blocked'` and leaves `D` alone when the remote lost more than `max(10, 10%)` of local history rows, or has no tasks while local does. `showPullGuard()` asks; "keep mine" re-pushes to repair the Gist |
| Sync | `gistPush(force)` returns `'blocked'` and writes nothing when local is smaller than the Gist by the same margin, or has no tasks while the Gist does. `showPushGuard()` offers load-cloud / save-to-file / push-anyway. `localDirty` stays set so the change retries |
| Sync | `gistPull()` records `remoteSeen` on every parsed branch, so the push check is normally free. `peekRemote()` covers a push that beats the first pull of a cold start |
| Sync | `force` on both bypasses the guards *and* the timestamp comparison — required because the stale copy holds the newer `_lastModified`, which is why "Pull" couldn't rescue the user |
| Sync | Settings **Pull**/**Push**/**Sync** no longer report success for a refused operation (`'blocked'` is truthy) |
| Startup | Startup pull skips `showStartupModals()` on `'blocked'`, so the version popup can't paint over the guard prompt |
| Docs | `recovery/RECOVERY.md` + `recovery/recover.ps1` — user-facing recovery runbook, lists recent Gist revisions by counts and hides bookkeeping-only revisions |

**Needs pushing:** `index.html`, `sw.js`, `DESIGN.md`.

**Still open, offered and not yet chosen:** confirmation on the per-section plan clear button (one
unconfirmed tap wipes a whole section — the Aug 25 22:58 plan truncation), and rejecting an
Import Backup whose file contains no `tasks` array (importing `reminder_state.json` by mistake
empties everything and syncs it).

### 12.3 Fixed in 5.16.0

Cleanup of legacy-task cruft surfaced by reading a real Actions log. 29 harness assertions, 10/10
negative controls discriminating.

**Needs pushing:** `index.html`, `sw.js`, `scripts/check-reminders.js`, `DESIGN.md`.

| Area | Change |
|------|--------|
| Reminders | **A one-off reminder whose date has passed is switched off on app load.** It could never fire again but stayed enabled and was re-evaluated on every run forever. Done in the app, **not** the script — the script must never write `productivity_data.json` (§8), so anything touching task data belongs client-side. A one-off dated *today* is left alone; it still has hours left |
| Reminders | **`createdAt` is backfilled on load** from the earliest ledger row for that task, including rows nested in a grouped plan entry, falling back to today only when there is no history at all. Tasks predating the field had none, and a recurring task with neither `createdAt` nor a completion gets **no reminder ever** (§8) |
| Reminders | `computeRecurringDueDateStr()` takes an optional `todayStr` and anchors on it as a last resort instead of returning `null`. Belt-and-braces behind the backfill above |
| Logging | **Mismatch reasons now name the field that actually governs the schedule.** A one-off printed `days=undefined, weekday=undefined` — the two fields irrelevant to it — while omitting the `date` that decides it. `scheduleMismatchReason()` branches per freq, and a spent one-off says so explicitly |

Housekeeping is idempotent across loads, asserted directly.

### 12.2 Fixed in 5.15.0

Chasing a reminder that kept arriving just after midnight for a 21:00 schedule, across three
sightings. 24 harness assertions, 7/7 negative controls discriminating.

**Needs pushing:** `index.html`, `sw.js`, `scripts/check-reminders.js`, `DESIGN.md`.

**Process note worth keeping.** Three rounds were spent on hypotheses that all turned out to be
wrong — a stale queued notification (disproved once everything was deployed and it recurred), an ICU
`hour12:false` quirk emitting `"24:07"` (disproved by running `Intl` directly: it yields `"00:07"`),
and the script's goal branch being blind to `planTasks` (disproved by re-reading §3.4 — a plan
session's per-task contribution always lands in a `taskId`-bearing bookkeeping row, so counting those
is correct and complete). The gate provably cannot fire at 00:07 for a 21:00 reminder in the user's
own timezone, which leaves the two **stored inputs**. Those were invisible from inside the app, which
is the actual defect: **when the logic is proven and the symptom persists, stop theorising and make
the inputs observable.**

| Area | Change |
|------|--------|
| Reminders | **Settings → Reminder diagnostics**: every enabled reminder's stored time (rendered in 12-hour form), its frequency, the saved timezone, a warning when that zone differs from the device's, and a warning for a time string the job can't read |
| Reminders | **`settings.timezone` is refreshed on every load**, not just when a reminder is saved. A stale zone a few hours west of the user produces exactly the "9pm reminder at 00:07" symptom, and nothing in the app previously corrected it |
| Reminders | **Time comparison is numeric** (`hhmmToMinutes()`) instead of lexicographic on `HH:MM`. An unpadded `"9:00"` used to compare as *later* than `"21:00"`, so such a reminder never fired at all; an unreadable time now blocks the send and logs why |
| Reminders | A send now logs the inputs that justified it (`now`, `tz`, `scheduled`, `freq`, `type`) rather than just announcing itself |

### 12.3 Fixed in 5.14.0

Cold-start responsiveness. 16 harness assertions (including 60 randomised reconciliation profiles),
6/6 negative controls discriminating.

**Needs pushing:** `index.html`, `sw.js`, `DESIGN.md`, and — still outstanding from 5.13.0 —
**`.github/workflows/check-reminders.yml`**, which was missed in that push. See the deploy hazard note
in §0.

| Area | Change |
|------|--------|
| Startup | **S4: the app paints from `localStorage` immediately instead of waiting for the Gist.** `render()` was only called inside `gistPull().then(...)`, so with sync enabled a cold start showed a blank white screen for the entire network round trip. Moved above the sync branch; the pull still re-renders when it lands |
| Startup | Orphan reconciliation (§6.7) now builds one task→completion-days map in a single pass rather than scanning all of `pointsHistory` once per task. It runs before the first paint, and the `planTasks` check added in 5.12.0 had made the per-task scan much more expensive |

Investigated and **not** a code bug: a reminder arriving at 00:44 for a 21:00 schedule. The script
cannot send before `reminder.time` in the configured timezone, so this is either a notification queued
by the pre-5.12.0 script (four-week TTL, no completion check) or a stale `settings.timezone` pointing
west of the user. §8 has the one log line that distinguishes them.

### 12.4 Fixed in 5.13.0

Closes D1 — the last known data-loss path — plus the backlog items it unblocked. 47 harness
assertions, 14/14 negative controls discriminating, and a benchmark for the performance claim.

**Needs pushing:** `index.html`, `sw.js`, `scripts/check-reminders.js`,
`.github/workflows/check-reminders.yml`, `DESIGN.md`.

**One-time note:** the first run after deploying creates `reminder_state.json` in the Gist. Nothing
needs migrating — `lastSentFor()` falls back to the legacy `task.reminder.lastSent`, so no reminder
that already went out today will be re-sent.

| Area | Change |
|------|--------|
| Sync | **D1 closed. `check-reminders.js` no longer writes `productivity_data.json` at all** (§8, §11.1). De-dupe state moved to its own Gist file, so the 15-minutely window in which reminder bookkeeping could discard unpushed local edits is gone rather than narrowed. Tradeoff: a dead push subscription is recorded in the state file and logged instead of being cleared in app data |
| Reminders | **Delivery timing.** `urgency: 'high'` asks the push service to deliver immediately rather than batching for battery; `TTL: 3600` makes a message expire after an hour instead of the default four weeks, so a 9pm reminder can no longer surface after midnight. Cron tightened from `*/15` to `*/5`, GitHub's minimum — since the script refuses to send before `reminder.time`, the interval *is* the lag budget. The scheduling logic itself was not touched; it was never the problem |
| Plan | **C17 + C8: per-section state now travels with the sections.** New `swapPlanSectionState()` / `removePlanSectionState()` are the only sanctioned way to maintain it, and they move the paid-bonus tracker **and** the rewards together. Reordering sections used to make a section moved into an already-paid slot lose its bonus while the one moved out could be paid twice; deleting a section **wiped** the tracker outright, which let every already-paid section pay again |
| Plan | **C1: editing a plan sub-task now updates the row that drives goal progress.** New `syncPlanTrackingRow()`. `plan-st-edit` updated `planTasks`, the grouped totals and the balance but never the sibling `_tracking` row `getGoalProgress` reads, so history and the goal bar diverged permanently and never reconciled. Also creates the tracking row when a sub-task logged with no time/count is edited upward |
| Performance | **S1: streaks memoised per render pass and indexed by day.** `rCard` called `getGoalStreak` 3× per card and each call re-scanned all of `pointsHistory` for up to 365 periods. `getGoalStreak`/`getDailyStreak` are now thin memoised wrappers over `computeGoalStreak`/`computeDailyStreak`; invalidation hangs off `saveL()` plus the top of `render()`. **Measured 4–8× faster across 6 runs (median ~7×), ~170 ms → ~27 ms per render pass** at 40 tasks / ~11,000 rows, with every streak verified identical to the old algorithm. Measured in Node, so it's the algorithmic win rather than a browser figure |

Deliberately not changed: streaks still ignore `planTasks` (now tracked as **C18**), and
`getGoalProgress` still does a full scan per call — it is the largest remaining per-render cost.

### 12.5 Fixed in 5.12.0

First pass driven by **user-reported bugs from real use** rather than an audit. 33 harness
assertions, 9/9 negative controls discriminating.

**Needs pushing:** `index.html`, `sw.js`, `scripts/check-reminders.js`, `DESIGN.md`.

| Area | Change |
|------|--------|
| Plan UI | **The swipe-reveal bar behind a plan card is no longer taller than the card.** `.plan-sw-wrap` has `overflow:hidden`, making it a block formatting context, so `.tcard`'s `margin-bottom:8px` couldn't collapse out the way it does through `.bucket-item` on the Tasks tab — the wrapper was 8px taller than the card and the `top:0;bottom:0` ▲Up/▼Down bars hung below it. Two new rules move the gap outside the wrapper. **These are the first real CSS selectors for the swipe layers**; everything else about them is inline styles inside `rSwipeWrap`/`rPlanSwipeWrap` |
| Completions | **New canonical `taskCompletedInEntry()` / `lastCompletionDateStr()` / `completionDaysFor()` / `taskHistFor()` (§3.7).** `recurElapsed()` now delegates to them. This is the fix for three separate reported symptoms |
| Tasks tab | **Cards no longer say "never completed" for a task completed via the plan timer.** The recurring branch was gated on `t.lastCompleted` and all three branches fell back to a `taskId`-only `.pop()` scan. The daily/evergreen scans also accepted any earned row, so a "worked on it" partial could read as "last: today" |
| Task detail | **"No history yet." and `—` in all four stat boxes are fixed for plan-timer completions**, and the mini calendar marks those days (was C2). `hist` comes from `taskHistFor()`; the calendar comes from `completionDaysFor()` rather than filtering a list the caller had already stripped ✅ rows out of. "Last:" now means last *completion*, taken as a max by date rather than by array position |
| Startup | **Orphan reconciliation no longer deletes valid `lastCompleted`** for plan-timer completions (was C13) — it was the trigger that demoted `rCard` onto the broken path |
| Plan | **Finishing one section now pays a bonus: 10% of that section's own points.** Previously the only point-bearing award was a whole-plan bonus, so completing a section logged a `points: 0` reward row and nothing else. There is no separate whole-plan payout any more — the last section's award covers it |
| Plan | **The whole-plan bonus had been ignoring every point earned through the plan timer**, because it matched `h.taskId` and the grouped row has none. `planSectionPtsToday()` reads `planTasks` |
| Plan | **Fired-section state moved from `localStorage['pt_firedSec_<date>']` into `D._planFired`** so it syncs. It now gates a real points award, and a device-local copy would let the same section pay out again on every other device. Self-prunes to today (partly addresses S2). New helpers `planFiredToday()` / `setPlanFiredToday()` / `unfirePlanSection()` / `planSectionOfTask()` replace four hand-rolled section-index loops |
| Reminders | **A task completed today no longer gets reminded about it.** `isTaskDone()` mirrors §3.7, so plan-timer completions count. **Evergreen tasks previously had no "done" state at all** and fell through to `return false`, so an evergreen task with a daily reminder nagged every day regardless |

Not changed: the reminder **schedule** logic. The gate is strictly backward-looking, so early-looking
sends are a timezone or push-delivery-latency question, not a scheduling one (§8).

### 12.3 Fixed in 5.11.0

Corrects the 5.10.0 retirement model and unifies the recurring-due logic. 50 harness assertions,
17/17 negative controls discriminating.

| Area | Change |
|------|--------|
| Retirement | **"Done" is now explicitly scoped per surface** (4.4.1). Reverted 5.10.0's `min(taskGoal, planGoal)`: an in-plan goal no longer writes `lastCompleted`, so it can't hide a task from the Tasks tab. `sleepTarget()` takes only the task |
| Tasks tab | **A 3-per-day task no longer vanishes after the first completion.** `visibleTasks`/`sleepingTasks` were testing "any ✅ today" and ignoring the goal entirely; both now go through `dailyRetiredToday()` |
| Recurring | One canonical `recurIsDue()`/`recurIsResting()` replaces four divergent definitions, including the `.plan-done-btn` handler's raw-millisecond comparison that disagreed with the card it was attached to (4.4.2) |
| Recurring | Plan-timer retirement now clears `dueEarly`, so a "due early" task actually sleeps once done |
| Reminders | `check-reminders.js` derives due dates from the ✅ history (including plan-grouped completions) instead of `task.lastCompleted`, and falls back to `createdAt` — a never-completed recurring task previously got **no reminder ever** |

### 12.4 Fixed in 5.10.0

Follow-up to the 5.9.0 audit pass, resolving the three decisions left open there. 54 harness
assertions, 15/15 negative controls discriminating.

| Area | Change |
|------|--------|
| Retirement | New shared `sleepTarget()` / `taskProgressWithSession()`. A **smaller in-plan goal now retires a task early**; a larger one never delays retirement; a `total`/one-time goal can't be shortcut. Applied in `completeTask`, `stopSW`, and `stopPM` (4.4.1) |
| Streaks | Skips **neither add to nor break** a streak in either streak function; `getGoalStreak` rewritten and no longer reports 365 for a never-done, always-skipped task (6.2) |
| Goals | **Hourly goals now register progress at all.** Added `localHourStr()` / `periodStartStr()` / `periodEndStr()` and removed every `toISOString()`-derived boundary string (3.6) |
| History | Day summary now shows `✨ N pts earned  +M bonus` — the bare number still matches the calendar cell, but the bonus is no longer invisible (5.2) |

### 12.5 Fixed in 5.9.0

Audit pass, no new features. All of the below were verified with a headless harness plus negative
controls.

| Area | Fix |
|------|-----|
| Streaks | `checkDayChange()` no longer prunes `goalSkips` to today, which had been silently breaking every streak the morning after a skip (6.2) |
| Ledger | Added `realEntries()` / `entryTaskCount()` and routed the history day summary, calendar dots, `getWeekRecap()`, and `getAchievements()` through them — fixes doubled "time logged" and task counts inflated ~9× per plan session (3.4) |
| Achievements | "Speed Demon" and "Decathlon" no longer unlock off a single plan session |
| History | Day-summary points now exclude the goal bonus so the panel agrees with the calendar cell; grouped plan rows are now attributed per-category instead of vanishing under a filter (3.5, 5.2) |
| Timers | `checkGoal()` moved after the history push in all four stop paths — the daily bonus never fired for the session that crossed the goal (4.4) |
| Timers | `pause()` gained the `T.phase!=='break'` guard; break seconds were being billed as work on the current plan task (4.3) |
| Timers | `stopPM` now logs one ✅ marker per completion tap, matching `stopSW` (6.4) |
| Timers | Plan-timer completion only sleeps a task once its goal is actually met, matching `completeTask` (4.4) |
| Sync | `gistPush()` clears `localDirty` only on a confirmed write (4.2) |
| Undo | Identity-based row removal + `dataGen` guard; an absolute `pointsHistory.length` could truncate freshly synced history (4.4) |
| Rendering | Added `esc()` and applied it to ~90 interpolation sites; a name containing `"` corrupted its own edit form (4.1) |
| Audio | Single shared `AudioContext`; sounds used to die after ~6 completions (4.8) |
| Levels | `_lastLevel` guard changed to `== null`; the first level-up was never celebrated |
| HTML | Added the missing `<!DOCTYPE html>` — the app had been rendering in quirks mode |
