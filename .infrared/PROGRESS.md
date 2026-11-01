# Progress

Append-only. Newest last. Dated, absolute dates only: "yesterday" means nothing
to the session that reads this in three weeks.

Each entry: **Done** (what changed), **Learned** (what surprised you, which is
the half worth keeping), **Next** (specific enough to start on).

---

## 2026-11-01: the spike, run on a simulator

**Done.** At jarededwards's ask, the repo, private, with an iPhone app on Meta's
Wearables Device Access Toolkit 1.0.1: Meta AI's registration in Developer Mode,
the glasses Meta AI knows, a device session and its display, a five-screen demo
in the shape of Infrared's planning session (`App/Glance.swift`) drawn by the
toolkit (`App/GlassesCard.swift`), and the preview on the phone through the
toolkit's simulated Ray-Ban Display. The toolkit's handling is adapted from
localred's `app/Mobile/Glasses` (branch `feat/app-glasses`). `make sim` on an
iPhone 18 Pro simulator (iOS 27.0, Xcode 27.2): registered, the session and its
display started, and every screen drawn and pressed through, the presses from
the phone; `docs/screens/` holds four. The harness from template 0.3.2, in trunk
mode, checked by `make verify`.

**Learned.** The simulated glasses' inputs (`select` and `navRight`, from the
Neural Band or the touchpad) did not press the display's buttons, and
`sendClick(identifier: "0")` returned true and pressed nothing: the identifiers
the toolkit gives its buttons are its own. The toolkit's `MWDATMockDevice` and `MWDATDisplay` both carry
the class `DwaDisplayProtosSwift.DisplayRequest._StorageClass`; the runtime
warns of it at launch, and nothing failed of it. With the owner's 1Password
locked, SwiftPM's clone over SSH (the workstation's `insteadOf` rule) fails;
`GIT_CONFIG_GLOBAL=/dev/null` fetched the public package over HTTPS.

**Next.** The first run on a real pair (`MISSION.md`), with the draw time
written down.
