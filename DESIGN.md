# Productivity Tracker — Design Document

> **Maintained by Kiro.** Updated every time code changes. This is the single source of truth for app architecture, data flow, and known behaviors.

---

## 0. Picking this up again — read this first

Last worked: **2026-08-21**, ending at **5.11.0**. Three consecutive audit/fix passes (5.9.0,
5.10.0, 5.11.0); no feature work. Everything is committed to the working tree but **not yet pushed**
— see 12.1 for the file list.

**Where to start, depending on what you want to do:**

| Goal | Read |
|------|------|
| Fix another bug from the backlog | §11, ordered by priority. §11.1 needs your decision first |
| Touch anything that sums or counts `pointsHistory` | §3.4 — the bookkeeping-row rule. This caused 5 separate bugs |
| Touch any date/period comparison | §3.6 — `localISO()` stores local time with a lying `Z` |
| Change when a task counts as "done" | §4.4.1 — "done" is scoped per surface, not global |
| Touch recurring cadence | §4.4.2 — one canonical definition, mirrored in the reminder script |
| Verify a change | §12 "Verifying a change" — the headless harness recipe, including the gotchas |

**Three invariants that are easy to break and were each the root of multiple bugs:**
1. Aggregations go through `realEntries()`, never raw `D.pointsHistory` (§3.4).
2. Period boundaries come from `localDateStr()`/`periodStartStr()`, never `toISOString()` (§3.6).
3. An in-plan goal never writes `lastCompleted`/`completed` (§4.4.1).

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
- **Current version**: 5.11.0 (APP_VERSION in index.html, CACHE_VERSION in sw.js — always bumped together)

---

## 2. File Structure

```
productivity-tracker/
├── index.html          — the entire app (HTML + CSS + JS in one file)
├── sw.js               — service worker (cache-busting, offline support)
├── manifest.json       — PWA manifest (name: "Done!", standalone display)
├── appicon.png         — app icon (180×180, declared at 192 and 512 in manifest)
├── scripts/
│   └── check-reminders.js — GitHub Actions script for push notifications
├── .github/workflows/
│   └── check-reminders.yml — runs every 15 min for reminder notifications
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
| `gistPull()` | GET from Gist. Returns `'updated'` (new data applied) or `'current'` (no change). Uses `If-None-Match:''` to bust API cache. Increments `dataGen` when it replaces `D`. |
| `startAutoSync()` | 3-second interval pull. Only renders on `'updated'`. Suppressed during modals/focused inputs with content. |

**`settings` is pushed but never pulled.** `gistPush` strips only `token` and `gistId`, so
`dailyGoal`, `theme`, and `timezone` *do* reach the Gist — `check-reminders.js` depends on
`settings.timezone` being there. `gistPull` then discards the remote `settings` and keeps the
local object, which is what makes it feel device-local. Today's goal is recovered separately by
deriving it from the synced `dailyGoalLog`.

**Conflict resolution**: Last-write-wins via `_lastModified` timestamp. Pull skips overwrite if remote ≤ local.

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
- On load: scans all tasks. If `lastCompleted` points to a date with no matching ✅ entry in history → clears it.
- If one-time `completed=true` but no ✅ entry in history → resets.
- Prevents stale completion flags from old undo bugs.

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
- **De-dupe**: `reminder.lastSent` (a date string) is written back to the Gist after a send. That write-back is the cause of open issue **D1** (11.1).
- The script is timezone-explicit (`Intl.DateTimeFormat` + `settings.timezone`) because it runs on a UTC runner, whereas the app relies on `localISO()`. Different mechanisms, same intent — see 3.6.
- **Its recurring due-date reckoning duplicates the app's** — see 4.4.2. Keep `lastCompletionDateStr()` / `computeRecurringDueDateStr()` in sync with `recurElapsed()` / `recurIsDue()`.
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

None of these are regressions from 5.9.0–5.11.0; they are pre-existing, found during the audit and
deliberately left alone. Roughly in the order worth fixing.

### 11.1 Needs a decision before coding

| # | Issue |
|---|---|
| **D1** | **`check-reminders.js` write-back can clobber unpushed local edits.** It sets `_lastModified = Date.now()` whenever it sends, and `gistPull` accepts any newer remote without consulting `localDirty` — so every 15 minutes there is a window where `lastSent` bookkeeping discards local work. Preserving the original `_lastModified` fixes the data loss (the script only touches `reminder.lastSent`), but then `lastSent` never reaches your devices, risking a duplicate notification. Other options: keep reminder state in a separate Gist file excluded from conflict detection, or have the client merge `lastSent` on pull rather than replacing `D` wholesale. |
| **D2** | **Should an in-plan goal be settable on a task that has no goal of its own?** Today it can be. Per 4.4.1 it correctly has no effect on the Tasks tab, but it does gate the plan card and the timer queue. Confirm that's intended, or hide the option for goal-less tasks. |

### 11.2 Correctness bugs

| # | Issue |
|---|---|
| **C1** | **Editing a plan sub-task doesn't update the row that drives goals.** `plan-st-edit` updates `planTasks[i]`, the grouped totals, and `D.points`, but never the sibling `_tracking` row that `getGoalProgress` reads. The history detail and the goal bar diverge permanently after an edit. |
| **C2** | **Plan-timer completions never appear on the task's own calendar.** `showTaskDetail` builds `hist` excluding 0-point ✅ markers, then `taskViz`'s calendar branch filters that list *for* ✅ — guaranteed empty for plan completions. |
| **C3** | **`deleteHistEntry`'s `planTasks` branch** recomputes `lastCompleted` from *all* earned rows, not just ✅ ones (6.6), so deleting a plan session can leave a task asleep on the strength of a partial "worked on it" row. Self-heals at next startup via 6.7, which is itself a smell. |
| **C4** | **Insights "Category Breakdown" ignores all timer points.** It sums `h.category`, which only `completeTask` and Quick Log set. `entryFieldForCat()` (3.5) now exists and would fix it. |
| **C5** | **Duplicate DOM ids when one task sits in two plan sections.** `plan-load`/`plan-sec-add` don't check other sections, so both cards render `id="imi-count"` / `id="ims-work"` / `id="imi-preview"`, and `getElementById` picks the first — the wrong card responds. Either dedupe on add, or key the inline form by `data-gi`. |
| **C6** | **`plan-sec-save` never links a newly saved plan back to its section** (the unlinked branch sets no `savedPlanIdx`), and "Save as new" cannot link **section 0** because it only writes to a preceding `break`. So edits after a fresh save don't sync back — which *is* the behaviour the original change request asked for. |
| **C7** | **`plan-sec-clear` on section 0 removes every `header` item**, including one a previous clear transferred to a later section, orphaning that section's saved-plan link. |
| **C8** | **Section rewards are keyed by array index.** `plan-sec-clear` reindexes them; `plan-sec-move` does not, so swapping two sections leaves their rewards behind. |
| **C9** | **On-deck queue index desync** in `rSW`/`rPM`: `onDeck` is `.filter(Boolean)`-ed but indexed against `T.planQueue[i+1]`, so one missing task shifts every row's times, points and ▲▼ buttons. |
| **C10** | **Post-drag click leaks** on `.tdet` / `.groc-item` / `.sldet` / `.plan-goal-tap` — none check `dragJustEnded`, so a short desktop drag opens the detail modal on drop. See 4.5. |
| **C11** | **Pinned-section drag reorders unrelated tasks** by splicing all pinned tasks into `D.tasks` at the first pinned index. |
| **C12** | **`stopPM` logs nothing** when stopped during a break with `T.totalWork === 0`. |
| **C13** | **Orphan reconciliation (6.7) may still clear `lastCompleted` for plan-timer completions** — it only matches standalone ✅ rows, not `planTasks` entries. Less likely now that markers are logged per tap, but the gap remains. |

### 11.3 Structural / performance

| # | Issue |
|---|---|
| **S1** | **`getGoalStreak` is O(365 × history) and `rCard` calls it ~3× per card.** With ~40 tasks and a few thousand history rows this dominates every `render()`. Memoise per render pass. |
| **S2** | **Unbounded localStorage growth**: one `pt_firedSec_<date>` key per day, never cleaned up; `D._highScoreShown` likewise. |
| **S3** | **`deleteTask`/archive leave orphan entries** in `D.plan`, `savedPlans`, `planSectionRewards`. Rendering tolerates them; the arrays just grow. |
| **S4** | **Blank screen on cold start with sync enabled** — `render()` only runs inside `gistPull().then(...)`, so a slow network shows nothing at all. |
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
`navigator`. Two gotchas:
- `D`, `T`, `view` etc. are top-level `let` bindings, so they are **not** properties of the VM
  global. Append a small bridge (`globalThis.__b = {getD:()=>D, setT:v=>{T=v}, ...}`) to reach them.
  `function` declarations *are* reachable directly.
- Stub `navigator` keys must be **absent**, not `undefined` — the app tests
  `'serviceWorker' in navigator`.

Pair each assertion with a negative control: revert the fix in the extracted source and confirm
the assertion fails. A test that passes before and after proves nothing.

### 12.1 Fixed in 5.11.0

Corrects the 5.10.0 retirement model and unifies the recurring-due logic. 50 harness assertions,
17/17 negative controls discriminating.

| Area | Change |
|------|--------|
| Retirement | **"Done" is now explicitly scoped per surface** (4.4.1). Reverted 5.10.0's `min(taskGoal, planGoal)`: an in-plan goal no longer writes `lastCompleted`, so it can't hide a task from the Tasks tab. `sleepTarget()` takes only the task |
| Tasks tab | **A 3-per-day task no longer vanishes after the first completion.** `visibleTasks`/`sleepingTasks` were testing "any ✅ today" and ignoring the goal entirely; both now go through `dailyRetiredToday()` |
| Recurring | One canonical `recurIsDue()`/`recurIsResting()` replaces four divergent definitions, including the `.plan-done-btn` handler's raw-millisecond comparison that disagreed with the card it was attached to (4.4.2) |
| Recurring | Plan-timer retirement now clears `dueEarly`, so a "due early" task actually sleeps once done |
| Reminders | `check-reminders.js` derives due dates from the ✅ history (including plan-grouped completions) instead of `task.lastCompleted`, and falls back to `createdAt` — a never-completed recurring task previously got **no reminder ever** |

### 12.2 Fixed in 5.10.0

Follow-up to the 5.9.0 audit pass, resolving the three decisions left open there. 54 harness
assertions, 15/15 negative controls discriminating.

| Area | Change |
|------|--------|
| Retirement | New shared `sleepTarget()` / `taskProgressWithSession()`. A **smaller in-plan goal now retires a task early**; a larger one never delays retirement; a `total`/one-time goal can't be shortcut. Applied in `completeTask`, `stopSW`, and `stopPM` (4.4.1) |
| Streaks | Skips **neither add to nor break** a streak in either streak function; `getGoalStreak` rewritten and no longer reports 365 for a never-done, always-skipped task (6.2) |
| Goals | **Hourly goals now register progress at all.** Added `localHourStr()` / `periodStartStr()` / `periodEndStr()` and removed every `toISOString()`-derived boundary string (3.6) |
| History | Day summary now shows `✨ N pts earned  +M bonus` — the bare number still matches the calendar cell, but the bonus is no longer invisible (5.2) |

### 12.3 Fixed in 5.9.0

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
