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

**The default is to say nothing.** A point has to earn its way in, and the
only thing that earns it is the reader having to act: decide something, worry
about something, or remember something for later. If nothing changes for
them, cut it — including things you are proud of, and especially things that
went well.

Over-reporting is not a venial sin here. A reader who has to wade through six
points to find the one that needed them is a reader who falls behind, and
being behind is worse than missing a detail. Protect their attention and their
working memory the way you would protect a production database.

## Never report these

Each of these feels informative and is not. They are the failure mode, and
they are seductive because they are all true things you did.

- **A decision you made, are confident in, and that is cheap to reverse.** It
  is yours. Only surface a call you would want overruled, or one that is
  expensive to undo later.
- **That you are on top of something, tracking it, or will check it later.**
  That is your job, not news. Report the thing when it turns into a decision
  or a risk, and not before.
- **Verification that passed.** One line of evidence at the end, or nothing.
  Report it only when it *failed*.
- **Work in progress, or what an agent is currently doing.** Report on work
  when it lands.
- **How you did something.** The mechanism, the sequence, the obstacle you got
  around, the clever bit. Nobody is grading the method.
- **A problem you hit and fully solved**, unless it will recur.

## The rule for risks: mitigate, or ask. Never narrate.

A risk is not news. Work through it in this order and only the last branch
reaches the reader:

1. **Already handled, and it will not recur?** Say nothing. It is not a risk,
   it is a thing that happened.
2. **Can you do something about it?** Do that, and say nothing. Telling them
   about a hazard you are capable of managing just moves your job into their
   head.
3. **Only they can act?** Then tell them — and write it as *what needs doing*,
   not as a description of the danger. "The env pins are gone with no
   migration; say if you want one" beats a paragraph on what could go wrong.

The instinct this kills is the one that wants credit for noticing something.
A risk you spotted, handled, and reported is a risk you reported for yourself.

## Define the vocabulary before you use it

When the work invents a term — or, worse, introduces a second term next to one
that already exists — the reader does not yet have the distinction you spent
an hour building. A decision phrased in vocabulary they have not been taught
is not a decision they can make; it is a research task you handed them.

So lead with the meanings, in one compact line each, and *then* ask the
question. This is the one place where a few extra words are not padding: they
are what makes the rest of the report answerable at all.

> Archived: hidden from the sidebar, still fully live. Retired: kept forever,
> read-only, cannot be started. Deleted: actually gone from the database.
>
> Retiring also archives, which is what kept retired sessions off every live
> surface without touching any caller. Reversing that later means re-auditing
> every one of them.

Note the ordering: three definitions, then the consequence, then the decision.
The version that opens with "retiring a session sets `archived = true` and
that is load-bearing" is unanswerable, because the reader does not yet know
what either word means here.

## Answering a direct question

When the reader asked you something, the report *is* the answer. Give it,
say where the work went if it went somewhere, and stop. Two sentences is
normal. Do not attach your reasoning, the alternatives, or a summary of what
you did about it — if they want the reasoning they will ask, and the marker
below is how they know they can.

> Yes, it's worth capturing — it proved its value this session already. I've
> added it to the "clean-workspace-populate" agent.

That is a complete report. Anything more is for you, not for them.

## Structure

Lead with a single status line — where the work stands, in one sentence.
Then, in this order, only the sections that have content:

1. **Decisions needed** — where you need them to choose, or where you made a
   call they might want to reverse.
2. **Risks** — only where *they* have to act. See below; this section is
   empty far more often than it feels like it should be.
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

Most reports are one to three points. A report on a full day of parallel work
should still be readable in well under a minute.

If it runs long, the compression failed. Check for the two usual causes:
points that are really one point, and lines that survived because they were
*interesting* rather than because they were *actionable*. Interesting is not
the bar. Then check the harder one — whether you wrote a point to show that
the work was done well, which is the instinct this whole format exists to
suppress.
