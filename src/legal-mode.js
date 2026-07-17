// Legal Mode: the launch-blocking trust requirement from docs/LEGAL-CATALOG.md.
//
// Why it exists: Anthropic's consumer terms (Aug 2025) TRAIN on Pro/Max data by
// default unless the account has opted out -- and consumer-default terms are
// exactly what defeated privilege in Heppner (SDNY, Feb 2026). A lawyer's box
// must therefore never be deployed on a subscription token without an explicit,
// recorded attestation that the training opt-out has been verified. API keys
// run under commercial terms (no training by default, short retention), so
// they pass without attestation -- and are the recommended path for
// client-confidential work.
//
// We can NOT verify the opt-out programmatically (it's a claude.ai account
// setting), so this is an attestation gate, not a technical check. Copy rule:
// never claim "your data never trains models" -- the honest claim is "Legal
// Mode makes verifying no-training terms a required setup step."
import { confirm } from "./util.js";

export const OPT_OUT_CHECKLIST = [
  "Legal Mode: verify your Claude account is NOT sharing data for model training:",
  "  1. Sign in at claude.ai -> Settings -> Privacy",
  "  2. Ensure 'Help improve Claude' / model-training data sharing is OFF",
  "  3. Prefer an API key (--anthropic-key) for client-confidential work:",
  "     commercial terms do not train on inputs by default and retain briefly.",
];

// Pure: what does Legal Mode require for this flag set? Exported for tests.
export function legalPosture(flags) {
  if (!flags.legal) return { legal: false };
  const usesSubscription = Boolean(flags["oauth-token"]);
  const usesApiKey = Boolean(flags["anthropic-key"]) && !usesSubscription;
  return {
    legal: true,
    posture: usesApiKey ? "api" : usesSubscription ? "subscription" : "none",
    // Subscription tokens need the human attestation; API keys don't; deploying
    // with NO auth is allowed (shell-only box) but the gate re-applies when auth
    // is added, so we surface the checklist either way.
    needsAttestation: usesSubscription && !flags["training-opt-out-verified"],
  };
}

// Interactive gate used by deploy/sync. Returns the extra secrets to stage.
// Throws when the attestation is required and not given (non-TTY included:
// confirm() resolves false without a TTY, so CI/scripts must pass the flag).
export async function enforceLegalMode(flags) {
  const p = legalPosture(flags);
  if (!p.legal) return {};
  for (const line of OPT_OUT_CHECKLIST) console.log(line);
  if (p.posture === "api") {
    console.log("Legal Mode: API key detected -- commercial terms (no training by default). OK.");
  } else if (p.needsAttestation) {
    const ok = await confirm("Have you verified the training opt-out on this Claude account? [y/N]");
    if (!ok) {
      throw new Error(
        "Legal Mode requires the training opt-out attestation.\n" +
        "Verify the setting (claude.ai -> Settings -> Privacy), then re-run with\n" +
        "--training-opt-out-verified, or deploy with an API key (--anthropic-key)."
      );
    }
  } else if (p.posture === "subscription") {
    console.log("Legal Mode: training opt-out attested via --training-opt-out-verified.");
  }
  // LEGAL_MODE rides to the box so start.sh (and later the gate UI) can state
  // the posture; the value records HOW auth was cleared, for the audit trail.
  return { LEGAL_MODE: p.posture === "api" ? "api" : "subscription-attested" };
}
