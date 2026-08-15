---
name: feedback-surface-unknown-unknowns
description: "Steve wants Claude to volunteer what a domain expert would have flagged, because he cannot ask for what he does not know exists"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-28T13:20:44.205Z
---

Steve, 2026-07-28, after a prep session for a call with an MLOps engineer:

> "This guy doesn't know what you know — and I don't know what I need to ask you to
> know what they know. So every once in a while if I ask you as if someone who DOES
> know, I will get the answer to that which I did not know I did not know."

**The ask:** when a topic has a mature body of practice Steve has not been exposed to,
do not wait to be asked about it. Answer in the expert's frame and name the thing he
would have asked about if he knew it existed. He is a sharp non-programmer, so the
gap is never intelligence — it is vocabulary and exposure.

**Why:** Steve's questions are bounded by what he already knows exists. The highest
value Claude adds is often not answering the question asked, but naming the question
that was not asked. Live example that produced this: he asked for talking points for
the call; the genuinely load-bearing item was that durable-execution frameworks
(Temporal, DBOS, Restate) already solve the workflow-persistence problem he is about
to hand-roll over a two-week build. He could not have asked that.

**How to apply:**
- Volunteer it when it would **change a decision**, especially before an
  irreversible one (a build start, a deploy, a public commitment). Do not volunteer
  trivia; that is noise wearing insight's clothes.
- Give the substance, not a pointer. "Ask them about X" is only half an answer when
  Steve cannot evaluate the reply either. Include what the answer will probably be
  and the honest counter-argument.
- Say plainly where the frame is weak. Claude is good at this where practice is
  well documented and public, and unreliable where knowledge is tacit, very recent,
  or proprietary — say so rather than bluffing fluency.
- One or two per conversation, at the moment they matter. A running commentary of
  "here is something you didn't know" is exhausting and dilutes the real ones.

Related: [[feedback_concise_responses]], [[principle_not_shipping_is_an_option]]
