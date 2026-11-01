# Decisions

darkshift's decisions are ADRs in infrared-docs-internal (`docs/decisions/`). An
ADR is never edited to say something else; a new one supersedes it. These shape
this repo:

- **ADR 0015**: commits only from allowlisted accounts, with no AI attribution.
- **ADR 0019**: the agent harness, in trunk mode.

What the spike learned is in `docs/findings.md`, and infrared-docs-internal's
page on it says where it stands. A choice too small for an ADR goes below,
newest first, with its reason.

---

## 2026-11-01: Developer Mode, no Wearables Developer Center app

**Context.** Meta's toolkit registers an app with Meta AI. An app with no
`MetaAppID` registers only while Meta AI's Developer Mode is on; one registered
in Meta's Wearables Developer Center registers anywhere, and only it can ask for
the experimental capabilities.

**Decision.** `MetaAppID` and `ClientToken` stay unset, and the spike uses only
the toolkit's core, its display and its simulated glasses.

**Consequences.** No account at Meta, and nothing to rotate. Developer Mode
turns itself off after a firmware update, so it is turned on again after one.
The Neural Band's own gestures as events, speech heard on the glasses and voice
invocations wait for the owner's decision on an account.

## 2026-11-01: the presses come from the phone on a simulator

**Context.** The simulated glasses' inputs (`MockInputKit.select` and
`navRight`, from the Neural Band or the touchpad) did not press the display's
buttons at 1.0.1, and `MockDisplayKit.sendClick(identifier:)` takes an
identifier the toolkit numbers internally.

**Decision.** `-spike.autoplay YES` presses the button in focus from the phone.

**Consequences.** The simulator proves the drawing and the demo; a press from
the glasses is proven only on a real pair.
