---
name: executive-report
description: Report on finished or in-flight work in a compressed executive format — what the reader must decide, what they must worry about, what to track — instead of a narrative of what was done. Use whenever asked for a status update, a summary of what agents or subagents did, a report, a briefing, a standup, "where are we", "what happened", "catch me up", "give me the executive version", or when reporting back after delegating work. Also use unprompted when a turn's result is long enough that a narrative would bury a decision the reader has to make.
---

# Executive report

The reader's time is the scarce resource, not yours. They are not reading to
learn what you did; they are reading to find out whether they need to act. A
report that makes them extract the decisions from a story has failed, however
accurate the story is.

## The test that decides what goes in

For every candidate line, ask: **does the reader do something differently
having read this?** Act on it, worry about it, remember it for later, or
approve it. If nothing changes, cut it — including things you are proud of.

Verification (tests, builds, checks) is a special case. Report it as one line
of evidence, not as a section: it changes what they do only if it *failed*.

## Structure

Lead with a single status line — where the work stands, in one sentence.
Then, in this order, only the sections that have content:

1. **Decisions needed** — where you need them to choose, or where you made a
   call they might want to reverse.
2. **Risks** — what could bite them, including things you already handled
   that will recur.
3. **Follow-ups** — what to track, what is deferred, what is blocked.
4. **Verification** — one line. What ran clean, and how to confirm it.

Number the points across the whole report, not per section. The reader will
reply "2 and 4", and unique numbers are what makes that work.

Order within each section by consequence, not by chronology or by how hard the
work was.

## Writing the points

One sentence per point, in bold, stating the thing itself. If context is
genuinely needed, at most one plain sentence after it.

Lead with the consequence, not the mechanism. "Picking a model on a stopped
agent boots its container" tells them why they care; "`setModel` calls
`ensureStarted()`" makes them work it out.

Mark a point **`[details available]`** when there is a real explanation behind
it — the mechanism, the alternatives you weighed, the measurements — that a
reader might want but most would not. This is the core move of the format:
it lets you be ruthless about compression without losing anything, because the
reader can pull the thread on anything that matters to them. Use it honestly.
A marker on a point with nothing behind it wastes a question; no marker on a
point with a subtle rationale hides something they needed.

## What to leave out

- Narration of your process, tools used, files touched, or order of work.
- Anything that succeeded and needs no decision. Silence means it went fine.
- Restating the request back to them.
- Preamble, and closing offers to help.
- Reassurance. If there is nothing to worry about, say nothing.

## Things worth surfacing that are easy to miss

- A call you made that is **hard to reverse later** — even if it was obviously
  right, because it gets expensive to revisit.
- A problem you already fixed that will **happen again** — the fix helps once,
  the pattern is what they need to know.
- Work you finished that is **unverified in the way that matters** (no browser
  pass, no real account, no production data). Say what was not checked, not
  just what was.
- A thing you deliberately **did not do**, and why.

## Example

A good point:

> **3. Both env workspaces were snapshots of your *dirty* host tree.** One
> carried a superseded theme pass that would have reverted your palette on
> merge — excluded, but this recurs on every env created while the tree is
> dirty. *[details available]*

Consequence first, the handling second, the recurrence flagged because that is
the part that needs a decision. Compare with the same fact told as a story
("While merging I noticed that the environment had been created from a tar
copy, which meant…"), which takes four times the words to reach the same
instruction.

## Length

A report on a day of work should be readable in under a minute. If it runs
long, the compression failed — look for points that are really one point, and
for lines that survived because they were interesting rather than because they
were actionable.
