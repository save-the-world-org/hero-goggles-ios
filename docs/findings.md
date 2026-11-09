# Findings

What the spike, and localred's iPhone app before it, learned about Meta's Wearables Device Access Toolkit and Meta
Ray-Ban Display, from 2026-11-01. Each says how it is known: read in Meta's code or docs, or seen in a run.

## The toolkit

- **What it is** (read): [facebook/meta-wearables-dat-ios](https://github.com/facebook/meta-wearables-dat-ios), 1.0.1
  of 2026-10-09, binary XCFrameworks through Swift Package Manager, iOS only. The spike takes `MWDATCore` (registration,
  devices, sessions), `MWDATDisplay` (the display, stable since 0.7.0 of May 2026) and `MWDATMockDevice` (simulated
  glasses). Binary frameworks for iOS alone: in localred they belong to the iPhone target in `project.yml`, never to
  `Package.swift`, which the Mac app builds without Xcode.
- **Meta's side** (read): an app registers with Meta AI. One with no `MetaAppID` (empty, `0`, or an unexpanded
  `$(META_APP_ID)`) registers only while Meta AI's Developer Mode is on. The Neural Band's gestures as events
  (`MWDATInputs`), speech recognized on the glasses (`MWDATSpeech`) and voice invocations ("Hey Meta, start ...") are
  experimental and need the app in Meta's Wearables Developer Center with each capability approved. The spike and
  localred use none of them.
- **Developer Mode** (read, Meta's
  [getting started](https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit/)): Meta AI v254 or
  later, Settings, App Info, tap the app's version five times, then the Developer Mode switch and Enable. The SDK
  repo's notes put it under the glasses' settings, as older builds did. It turns itself off after a firmware update.
  Ray-Ban Display needs firmware v21 or later. A registered app is listed under Settings, App connections, Developer
  mode apps.
- **Info.plist** (read, the DisplayAccess sample): a URL scheme Meta AI calls back on, named again in `MWDAT` >
  `AppLinkURLScheme`; `MWDAT` > `MetaAppID`, `ClientToken`, `TeamID`, and `Analytics` and `CrashReporting` each with
  `OptOut`; the background modes `bluetooth-central`, `bluetooth-peripheral`, `external-accessory` and `processing`;
  `UISupportedExternalAccessoryProtocols` with `com.meta.ar.wearable`; `NSBluetoothAlwaysUsageDescription`; and for the
  display's high-bandwidth link, `NSLocalNetworkUsageDescription` with `NSBonjourServices` `_bonjour._tcp`.
- **It refuses to start without `CFBundleShortVersionString`** (seen): set `MARKETING_VERSION`.
- **Errors are typed** (read): `DeviceSessionError`, `DisplayError` and the rest are `DatError`s with a `description`.
  Swift 6 does not infer the type of a plain `do`/`catch` over typed throws, so the spike catches by case
  (`catch DeviceSessionError.sessionAlreadyExists`) and describes the rest through `DatError`.

## The display

- **The way in** (read, seen): `Wearables.configure()` once; `startRegistration()` opens Meta AI, which calls the app
  back, and `handleUrl` takes the link (its query has `metaWearablesAction`); an `AutoDeviceSelector` filtered on
  `supportsDisplay()`; `createSession`, `start()`, and at `.started`, `addDisplay()` and `start()`; at
  `DisplayState.started`, `send(FlexBox)`.
- **A send is the whole screen** (read, seen): each replaces what the display showed and every button handler with it.
  The spike sends one at a time, the newest winning, a fifth of a second apart at most.
- **The views** (read): `FlexBox` (direction, spacing, alignment, padding, `.background(.card)`, `onTap`), `Text`
  (styles `heading`, `body`, `meta`; colors `primary`, `secondary`), `Button(label:style:iconName:onClick:)`,
  `ButtonGroup`, `Image`, `Icon`, `VideoPlayer`, and the `IconName` set. Their names are SwiftUI's too, so the file that
  draws for the glasses imports no SwiftUI.
- **Focus** (read, seen in the preview): `.actionRole(.primary)` gives a button the focus, so a pinch presses it and a
  swipe moves to the next.
- **A secondary button with an icon is drawn as the icon alone** (seen): Change showed as a bare pencil. Only the
  primary carries an icon.

## The voice needs none of it

While connected, the glasses are the phone's Bluetooth headset: an app that records and plays with Bluetooth allowed
(`AVAudioSession` `.playAndRecord`, with `.allowBluetoothHFP` and `.allowBluetoothA2DP`) hears their microphones and
speaks in their speakers, as localred's VoiceKit does. The `audio` background mode keeps it going with the phone in a
pocket. The spike leaves the voice out. In localred, a speaker gate trained on the phone's microphone may hold back
words heard through the glasses: re-learn the voice with the glasses on.

## The simulated glasses

- **The preview** (seen): `MockDeviceKit.shared.enable()`, `pairGlasses(model: .metaRayBanDisplay)`, `powerOn()`,
  `don()`, then `services.display.createPreviewView()`: the toolkit draws what the glasses would show, in the app, and
  the simulated Meta AI registers the app at once. One `UIView`, shown in one place: put in two, it draws black.
- **It stops the app if the toolkit did not start** (seen): "Call `configure()` before attempting to access
  Wearables!". The spike pairs simulated glasses only once the toolkit started.
- **Its inputs do not press the display's buttons** (seen, 1.0.1, iPhone 18 Pro simulator): `services.input.select`
  and `navRight`, from `.neuralBand` or `.captouch`, pressed nothing, and `services.display.sendClick(identifier: "0")`
  returned true and pressed nothing; the identifiers the toolkit gives its buttons are its own. So on a simulator the
  presses come from the phone, and a press from the glasses is proven only on a real pair.
- **A class in two frameworks** (seen): `MWDATMockDevice` and `MWDATDisplay` both carry
  `DwaDisplayProtosSwift.DisplayRequest._StorageClass`, and the runtime warns of it at launch. Nothing failed of it.

## Builds

- The spike builds for the iOS Simulator; localred's app does not on Xcode 27.2, as mlx-swift 0.30.2 under its neural
  voice does not link there (`_MTLTensorDomain`, `_MTLIOErrorDomain`).
- A workstation whose git rewrites `https://github.com/` to SSH fetches the toolkit with the person's SSH key; with the
  key locked, `GIT_CONFIG_GLOBAL=/dev/null` fetches the public package over HTTPS.

## Seeking a UWB beacon

From 2026-11-07, with a Qorvo DWM3001CDK on Qorvo's Nearby Interaction firmware (QANI, SDK 1.1.1) and an iPhone 17 Pro.
The beacon's side is darkshiftio/beacon-firmware (`docs/qani.md`).

- **The handshake** (read in Qorvo's source, seen): connect over Bluetooth, subscribe to QANI's TX characteristic,
  write `0x0A` to its RX; the beacon answers `0x01` and its accessory configuration data, which makes a
  `NINearbyAccessoryConfiguration`; run it in an `NISession`, which hands back a shareable configuration in
  `didGenerateShareableConfigurationData`; write `0x0B` and that data; the beacon answers `0x02`, and readings arrive in
  `didUpdate`. `0x0C` stops it, and it answers `0x03`.
- **Direction needs the camera** (read, Apple's docs; seen in the capabilities): an iPhone gives a third-party
  accessory a direction only with camera assistance (`isCameraAssistanceEnabled`), and the iPhone 17 Pro reports
  `supportsDirectionMeasurement` false. With camera assistance on and no `setARSession`, Nearby Interaction runs an AR
  session of its own. The arrow's angle is `atan2(x, -z)` of the direction vector (x right, y up, minus z forward).
  Distance works without the camera.
- **Only one phone at a time** (seen): QANI takes one connection, so Qorvo's iPhone app, left open, keeps this one out.
- **An arrow in the lens** (seen on the pair): the toolkit's `Icon` set has no arrows at every angle, so the app draws
  one into a `UIImage` and sends `Image(image:sizePreset:)`. At `.icon` it was too small to read; at `.fill` from a
  120-pixel image, blurred and too big. A 640 by 280 canvas with the arrow drawn in its middle, at `.fill`, reads well.
- **The glasses are its speakers** (seen): spoken words and `AVAudioEngine` beeps play in the glasses while they are
  the phone's Bluetooth headset. A change of route stops the engine; the beeper starts it again on the next beep.
- **Who moves** (seen): Core Motion's activity (`CMMotionActivityManager`) says whether the person is walking or still,
  which tells "the beacon is moving away" from "you are walking away".
- **The distances seemed "a touch off and stuck at weird increments"** (jarededwards, 2026-11-08). The voice rounded
  coarsely, and says tenths from 1 to 5 m since; every reading goes to `seek-*.csv` to show the rest. The beacon runs on
  Qorvo's default UWB calibration, which Qorvo says ranges less accurately, after a chip erase (beacon-firmware
  `docs/qani.md`, Calibration).
- **Swift 6** (built): `NISessionDelegate` and `CBCentralManagerDelegate` are not isolated to the main actor, so the
  app's `@MainActor` classes conform with `@preconcurrency`.
