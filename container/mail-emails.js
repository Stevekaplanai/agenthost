// The 10-send whitepaper nurture sequence -- copy from marketing/EMAIL-PLAN.md
// section (b), adapted for email delivery (markdown markers stripped, links
// inline). Voice rules honored: How I never How to, no em-dashes, all urgency
// real. Day 22 carries its SEND RULE in code: slot numbers are filled from the
// live count and the zero-slots-claimed honest variant is automatic.
//
// One deliberate deviation from the plan: Day 26 says "no links, no signature
// block". A commercial sequence email still needs a visible opt-out (CAN-SPAM's
// clear-and-conspicuous requirement), so Day 26 keeps ONE muted unsubscribe
// line and nothing else. Flagged to Steve 2026-07-18.

const FOOTER = (ctx) =>
  "\n\n--\nYou're getting this because you grabbed The Blast Radius Playbook.\nUnsubscribe: " + ctx.unsubUrl;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Near-plaintext HTML: one pre-wrap block, URLs made clickable. Deliverability
// beats design in a nurture sequence; the text IS the brand voice.
function toHtml(text) {
  const linked = esc(text).replace(/https?:\/\/[^\s)]+/g, (u) => '<a href="' + u + '" style="color:#c2410c">' + u + "</a>");
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.65;color:#16181d;max-width:640px;white-space:pre-wrap">' +
    linked +
    "</div>"
  );
}

const EMAILS = {
  0: (ctx) => ({
    subject: "Your Blast Radius Playbook (and everything else, no drip)",
    body:
      "Here's your copy of The Blast Radius Playbook, for keeps:\n\n" +
      "Download the PDF: " + ctx.pdfUrl + "\n\n" +
      "You already got it on the page. This one's for your archive.\n\n" +
      "I'm not going to drip the good parts out over six weeks. Everything worth having is available today:\n\n" +
      "- The playbook itself. The four rails, the production log with the bugs left in, and the self-audit in Section 8.\n" +
      "- The CLI, free, on npm. npx agenthost-cli deploys the whole thing to your own Fly account. The code that enforces every rail in the paper is the code you can read. If you'd rather run it all yourself, genuinely, go.\n" +
      "- The 60-second self-audit. Five questions about your current agent setup. Most people who score their own rig find the same summary: always-on-ish, blast radius everything, gate open, budget none, review self.\n\n" +
      "Over the next few weeks I'll send a handful of short emails: what happened the first day I let my agents run unattended, the dates that make this moment strange, and how the four rails work in plain language. Near the end I'll tell you about the one paid thing we offer. That's the whole arc, disclosed up front.\n\n" +
      "If you read one section of the paper, read Section 8. It's about your setup, not mine.\n\n" +
      "Steve\nAgentHost - " + ctx.siteUrl,
  }),

  1: () => ({
    subject: "One question, 60 seconds: what could it touch?",
    body:
      "Question 2 of the self-audit is the one that changes minds, so here it is on its own:\n\n" +
      "If an agent went rogue at 3am tonight, what is the worst thing it could touch?\n\n" +
      "Not what it would touch. What it could.\n\n" +
      "Take 60 seconds and answer honestly for your current setup. For most laptop rigs the honest answer is \"everything with my SSH key on it.\" Repos. Browser sessions. .env files. Production CLI tokens. Nobody decided to give the agent production access. Nobody decided not to.\n\n" +
      "That was the PocketOS failure in April: a routine staging task, an unscoped Railway token that happened to be visible, and 9 seconds later the production database and every backup were gone. The model was frontier-class. The access was the bug.\n\n" +
      "On my box, the answer to question 2 is \"system libraries and a scratch folder,\" because autonomous runs happen inside a read-jail where my home directory and credentials don't exist. Not locked away. Absent.\n\n" +
      "Here's the small action: hit reply and tell me your answer to question 2. One line is fine. \"Everything\" is a common and useful answer. I read every reply, and it's the single best way to tell me what to write about next.\n\n" +
      "Steve",
  }),

  3: () => ({
    subject: "The first day I let them run unattended (4 bugs, nothing escaped)",
    body:
      "July 18, 2026. I flipped autonomy on for the first time, on my own box, doing my own real work.\n\n" +
      "Understand the stakes. This isn't a demo rig. This box runs my actual board, next to my actual projects, on my actual subscription tokens. If the rails didn't hold, the thing on the other side was my working life. I'd spent weeks building four layers of containment and had exactly zero days of evidence they worked outside a test.\n\n" +
      "Day one found four real bugs.\n\n" +
      "A lifetime-clock bug in the chain budget accounting. A sandbox bug where Codex's home directory needed to be writable inside its wrapper. A lost-results race in the task pipeline. Real bugs, in the safety system itself, on the first live day.\n\n" +
      "And the rails held. Tasks got blocked. Budgets tripped. Reviews rejected. Nothing escaped. The gate even produced two false positives, harmless tasks it held for me because their wording didn't match the safe-verb list. That's the gate erring in the only direction a gate should err.\n\n" +
      "Why am I telling you about the bugs? Because a system that reports four bugs and four holds on day one is describing reality, and a system that reports zero is describing marketing. The fixes are annotated in the code at the lines they touched, and the code is public on npm. We have no customers and no testimonials yet. This log is the proof we have, and it's the only proof I'll claim until customers exist.\n\n" +
      "Full postmortem is in Section 6 of the playbook.\n\n" +
      "Steve",
  }),

  5: () => ({
    subject: "Four dates that explain why this is happening now",
    body:
      "No argument today. Just dates.\n\n" +
      "July 18, 2025. Replit's agent deleted a live production database during an explicit code freeze. 1,200+ executive records. The founding disaster of the category turned one year old the week the playbook shipped.\n\n" +
      "April 25, 2026. It happened again, worse. PocketOS: a routine staging task, an unscoped token, and 9 seconds to delete the production database and every volume-level backup. 30+ hour outage.\n\n" +
      "July 7, 2026. Anthropic expanded Claude Cowork to cloud background tasks. Schedule work for 6am, close the laptop, come back to finished output. The company that makes Claude just validated the premise: agents that die at laptop-close are broken. Their fix runs on their cloud.\n\n" +
      "July 27, 2026. Moonshot's Kimi K3 weights drop. 2.8 trillion parameters, the largest open-weight model ever, priced in Claude Sonnet territory. The intelligence layer is commoditizing in real time.\n\n" +
      "Add them up. Everyone now agrees agents should keep working when you leave. Everyone was reminded, twice in twelve months, what an unconfined agent does. And the models themselves are becoming interchangeable, which means the durable asset is everything around the model: your memory, your budgets, your box.\n\n" +
      "Two windows are open at once. That's the whole reason AgentHost exists this month and not next year.\n\n" +
      "Steve",
  }),

  8: () => ({
    subject: "You're paying for 24 hours and using 8",
    body:
      "Quick math on what you already pay.\n\n" +
      "On May 6, Anthropic permanently doubled Claude Code's rate limits for Pro and Max and removed peak-hour throttling. Your subscription got materially more capable overnight, for $0 extra. But a subscription works roughly eight hours a day if your agents die when your laptop closes. You're paying for around-the-clock intelligence and consuming it part-time.\n\n" +
      "Now the metered alternative. Devin's floor dropped to $20/month, which sounds great until you read the meter: $2.25 per Agent Compute Unit, roughly 15 minutes of autonomous work. Run that always-on and it's a mortgage. Metered autonomy punishes exactly the long-horizon, overnight usage you actually want.\n\n" +
      "Here's the reframe: you don't have a compute problem. You have an uptime problem. The intelligence is already paid for and sitting on your card. What's missing is a machine that keeps consuming it after you stand up, and that isn't a model purchase. It's infrastructure: a persistent box, your keys, your budgets, running the subscription you already own around the clock.\n\n" +
      "That's the entire wedge. One command stands the box up (npx agenthost-cli, free, your own Fly account, on the order of $60+/month in Fly costs that bill to you, not us). The model bill never grows, because you already paid it.\n\n" +
      "Always-on is only affordable when the intelligence is already paid for.\n\n" +
      "Steve",
  }),

  11: () => ({
    subject: "The Blast Radius Model in 60 seconds",
    body:
      "The claim: agent safety is an infrastructure problem, not a model problem. You don't make a demolition safe by hiring a calmer crew. You make it safe by controlling what's inside the blast radius before anything detonates.\n\n" +
      "Four rails, all enforced in code outside the model, all running in production today:\n\n" +
      "1. The read-jail. Autonomous runs execute in a throwaway root filesystem built from an allowlist: system libraries, TLS certs, a scratch folder, nothing else. Your credentials aren't hidden from the run. They don't exist inside it.\n\n" +
      "2. The fail-closed human-gate. A task auto-runs only if its title leads with an audited safe verb (review, analyze, draft, plan) and contains no risky keyword anywhere (deploy, send, pay, delete, token). Everything else waits for a human. Yes, it sometimes gates harmless tasks. That's the point: an allowlist can be complete, a blocklist never can.\n\n" +
      "3. Hard chain budgets. 6 runs, 45 minutes, 150K tokens, $5 per chain, enforced outside the model. A chain cannot extend its own budget.\n\n" +
      "4. Independent cross-engine review. No task is done because the agent says so. A different engine reads the raw result and votes an explicit approve or reject. A reviewer that crashes never defaults to approval.\n\n" +
      "And the fine print, because you'd find it anyway: one residual is documented rather than papered over. The run's own environment must hold the single OAuth token that inference needs. Mitigated by plan-mode, output scrubbing, and a 4-key environment. Not provably zero. Confined and mitigated, never escape-proof.\n\n" +
      "Full mechanics in Section 5 of the playbook.\n\n" +
      "Steve",
  }),

  14: (ctx) => ({
    subject: "Founding Operator: 10 boxes a month, live in 48 hours or you pay nothing",
    body:
      "Everything so far has been free and stays free. Here's the one paid thing we offer.\n\n" +
      "The Founding Operator setup: your own always-on box. Claude, Hermes, and Codex on a Fly machine in your account, with your keys, deployed with me personally on the hook until it's provably running. Every setup includes the Blast Radius Audit, the Team Charter Pack (the actual production charter, annotated), the battle-tested budget-rail config from my own box, the Autonomy Day Postmortem, and per-engine cost tracking configured on day one.\n\n" +
      "The guarantee, two parts.\n\n" +
      "Part 1, the Live Box Guarantee: if your box isn't deployed, running all three engines, and completing its first gated autonomous run within 48 hours of onboarding, I get on a call and fix it with you personally until it is. Or you pay nothing.\n\n" +
      "Part 2, the Own-the-Box Guarantee, standing: it's your Fly account and your keys. Cancel anytime and the box, the data, and the vault stay yours. There is nothing of yours on our servers, because there are no our-servers.\n\n" +
      "The real constraint: I onboard every box personally, and I am one person. The cap is 10 boxes per month. When a month fills, the page says so.\n\n" +
      "Three honest options:\n\n" +
      "1. Run it yourself, free. npx agenthost-cli. The whole stack, public on npm. If you enjoy tuning rails, you don't need me.\n" +
      "2. Founding Operator. Stood up in 48 hours, rails pre-tuned, founding rate kept for as long as you stay subscribed: " + ctx.siteUrl + "\n" +
      "3. Not now. Keep the playbook, keep reading. Nothing expires except this month's cohort.\n\n" +
      "Steve",
  }),

  18: (ctx) => ({
    subject: "Who shouldn't buy this (and what we won't claim)",
    body:
      "The honest anti-pitch. Save yourself the call if any of these apply.\n\n" +
      "Don't buy if you like running your own infrastructure. The CLI is free and public, the rails are documented, and the playbook explains the whole containment model. Some of the best users of this thing will never pay us. That's fine and intended.\n\n" +
      "Don't buy if you want a hosted service. There is no AgentHost backend and there never will be a multi-tenant tier. You bring your own keys and subscription tokens. We never see them, never proxy them, never resell them. If \"you run it for me on your cloud\" is the requirement, we are structurally not it.\n\n" +
      "Don't buy if you need certifications. No SOC 2, no ISO 27001. The audit log and two-factor login are features, not certifications.\n\n" +
      "Don't buy if you need a security absolute. We say confined and mitigated, never escape-proof. The OAuth-token residual is documented in the paper. A vendor that names its residual risk is a vendor you can believe about its rails. That trade is the whole strategy.\n\n" +
      "And the full cost picture: the CLI is free, but the box bills through your own Fly account, on the order of $60+/month for the default machine, plus model usage billed by your own provider. No hidden line items because there's no way for us to hide them. They're your accounts.\n\n" +
      "Still here? Then you're probably the exact person this was built for: " + ctx.siteUrl + "\n\n" +
      "Steve",
  }),

  22: (ctx) => {
    // SEND RULE (EMAIL-PLAN.md, do not skip): the numbers must be TRUE at send
    // time. An unknown count (FOUNDING_SLOTS_TAKEN secret missing) must never
    // fail open to "all 10 open" -- returning null makes the gate HOLD this
    // send (audited, retried daily) instead of mailing a claim nobody checked.
    if (!Number.isFinite(ctx.slotsTaken)) return null;
    const taken = Math.max(0, Math.min(10, ctx.slotsTaken));
    const remaining = 10 - taken;
    // Zero slots claimed -> the honest "cohort hasn't filled" variant.
    const statusLine = taken === 0
      ? "As of today, all 10 slots for " + ctx.monthName + " are open. Cohort 1 hasn't filled and I won't pretend otherwise. The cap is real going forward either way."
      : "As of today: " + remaining + " of 10 slots remain for " + ctx.monthName + ". When it hits zero the page says \"cohort full\" and the next cohort opens the following month. No waitlist games, no timer widgets. The constraint is my calendar, and you're reading its status.";
    return {
      subject: "Cohort status: " + remaining + " of 10 boxes left this month",
      body:
        "Short update on the only scarce thing we have.\n\n" +
        "The Founding Operator cap is 10 boxes per month. That number isn't a marketing device. I onboard every box personally, on calls, until the Live Box Guarantee is satisfied. Ten is what one person can do well in a month while also building the product.\n\n" +
        statusLine + "\n\n" +
        "Two things Founding Operators lock in that later cohorts won't:\n\n" +
        "1. The founding rate, kept for as long as you stay continuously subscribed. Pre-general-availability pricing, for the real reason that early operators take the most risk on an unproven vendor.\n" +
        "2. First-in-line for what ships next. New rails and engine integrations land on Founding boxes first.\n\n" +
        "If you were waiting to see whether this is real, the honest answer is: the production log is the realest thing we have, and you've already read it.\n\n" +
        ctx.siteUrl + "\n\n" +
        "Steve",
    };
  },

  26: () => ({
    subject: "quick question",
    body: "Still babysitting terminals to keep an agent alive?\n\nSteve",
    minimalFooter: true,
  }),
};

// renderEmail(step, ctx) -> { subject, text, html }, or null for unknown steps
// AND for a step whose own guard refuses to render (Day 22 without a verified
// slot count) -- the caller treats null as "hold, do not send".
// ctx: { pdfUrl, siteUrl, unsubUrl, slotsTaken, monthName }
function renderEmail(step, ctx) {
  const make = EMAILS[step];
  if (!make) return null;
  const e = make(ctx);
  if (!e) return null;
  const footer = e.minimalFooter ? "\n\n\nunsubscribe: " + ctx.unsubUrl : FOOTER(ctx);
  const text = e.body + footer;
  return { subject: e.subject, text, html: toHtml(text) };
}

module.exports = { renderEmail, EMAIL_STEPS: Object.keys(EMAILS).map(Number).sort((a, b) => a - b) };
