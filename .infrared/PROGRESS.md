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

## 2026-11-07 to 2026-11-09: seeking a UWB beacon, "Kelsey Finder"

**Done.** At jarededwards's ask ("phone first, my rayban ai glasses are the critical one for navigating to this
beacon"), the app seeks a Qorvo DWM3001CDK on Qorvo's Nearby Interaction firmware: `BeaconLink` (Bluetooth: scan,
connect, Qorvo's service and messages), `Seeker` (Nearby Interaction, the readings, the words), `SeekView` (the phone),
`SeekLog` (every reading to `seek-*.csv` in Documents) and `Beeper` (hot and cold beeps). In the lens: "Kelsey Finder"
as every screen's title, an arrow drawn into an image when there is a direction, the distance, and one line; "Find
Kelsey" with a Find button when not seeking. Who moves, from Core Motion; an alert past 10 m; Lost with where he was
last seen. Ran on jarededwards's iPhone 17 Pro with the glasses on 2026-11-08: distance on the phone and in the lens.
`make verify` passes; `SEEK=1 scripts/run-simulator` walks a made-up beacon closer.

**Learned.** iPhones give a third-party accessory a direction only with camera assistance. The toolkit's `Image` at
`.icon` is too small for an arrow, and a small image at `.fill` blurs: a 640 by 280 canvas reads. The distances seemed
"a touch off and stuck at weird increments": the voice rounded coarsely (finer since), and the beacon ranges on Qorvo's
default calibration after a chip erase (beacon-firmware `docs/qani.md`). `docs/findings.md`, Seeking a UWB beacon.

**Next.** jarededwards's test away from the Mac, the beacon on a power bank: past 10 m for the alert, standing still
while the beacon moves, out of range for Lost, and a measured 1 m and 3 m held for a few seconds each. Then pull the
logs (`README.md`, Seek a UWB beacon) and correct the distance, in the app or by calibrating the beacon.
