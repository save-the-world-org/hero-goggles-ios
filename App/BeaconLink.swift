import CoreBluetooth
import Foundation
import Observation
import os

/// The Bluetooth side of a UWB beacon that runs Qorvo's Nearby Interaction firmware (a DWM3001CDK with QANI): found as
/// it advertises, connected, and spoken to in Apple's accessory messages, the first byte naming the message and the
/// rest its data. The phone writes to the beacon's RX characteristic and hears it on TX's notifications. Nearby
/// Interaction itself is `Seeker`'s; this only carries its messages.
///
/// The service and characteristic UUIDs are Qorvo's Nearby Interaction service and, from Qorvo's older firmware and
/// Apple's accessory sample, the Nordic UART service; the message numbers are Apple's sample's. They are to be checked
/// against Qorvo's SDK, and `servicesSeen` shows what a beacon offers when none of them match.
@MainActor
@Observable
final class BeaconLink: NSObject {
    enum State: Equatable {
        /// Bluetooth is off or not allowed.
        case off
        case idle
        case scanning
        case connecting(String)
        case connected(String)
    }

    /// Apple's Nearby Interaction accessory messages, as Qorvo's firmware speaks them.
    enum MessageID: UInt8, Sendable {
        // From the beacon.
        case accessoryConfigurationData = 0x01
        case accessoryUWBDidStart = 0x02
        case accessoryUWBDidStop = 0x03
        // To the beacon.
        case initialize = 0x0A
        case configureAndStart = 0x0B
        case stop = 0x0C
    }

    /// A GATT service that carries the messages: the beacon receives on `rx` and notifies on `tx`.
    struct Service {
        let name: String
        let id: CBUUID
        let rx: CBUUID
        let tx: CBUUID
    }

    static let services = [
        Service(name: "Qorvo NI", id: CBUUID(string: "2E938FD0-6A61-11ED-A1EB-0242AC120002"),
                rx: CBUUID(string: "2E93998A-6A61-11ED-A1EB-0242AC120002"),
                tx: CBUUID(string: "2E939AF2-6A61-11ED-A1EB-0242AC120002")),
        Service(name: "Nordic UART", id: CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"),
                rx: CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
                tx: CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")),
    ]

    /// Advertised names that mark a Qorvo beacon even when it does not advertise its service.
    private static let names = ["qorvo", "dwm3001", "qani", "qni"]

    private(set) var state: State = .idle
    private(set) var problem: String?
    /// The beacon's advertised name, and its signal when it was found.
    private(set) var name: String?
    private(set) var rssi: Int?
    /// Which of `services` the beacon speaks on.
    private(set) var serviceName: String?
    /// Every service the connected beacon offered, for when none of `services` is among them.
    private(set) var servicesSeen: [String] = []

    @ObservationIgnored var onMessage: (@MainActor (MessageID, Data) -> Void)?
    /// The beacon is connected and listening: messages can go.
    @ObservationIgnored var onReady: (@MainActor () -> Void)?
    /// The beacon went away; the link looks for it again.
    @ObservationIgnored var onLost: (@MainActor () -> Void)?

    /// The beacon to take, by its ID: the 8 hex digits of its DEVICEADDR[0], which it advertises inside its name, "Hero
    /// Finder (86E7C53A)" on our firmware and "DWM3001CDK (86E7C53A)" on Qorvo's. The Influence API's `hardwareId` for
    /// the target (`Seeker.find`). Another beacon is taken only after three seconds without it.
    @ObservationIgnored var preferred: String?
    @ObservationIgnored private var fallback: (peripheral: CBPeripheral, name: String?, rssi: Int)?

    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var rx: CBCharacteristic?
    @ObservationIgnored private var tx: CBCharacteristic?
    @ObservationIgnored private var wanted = false

    private static let log = Logger(subsystem: "io.darkshift.rayban-spike", category: "beacon")

    /// Looks for a beacon and connects to the first one found, then keeps it: found again whenever it goes.
    func start() {
        wanted = true
        problem = nil
        if let central {
            if central.state == .poweredOn { scan() }
        } else {
            // The manager reports its state at once, and a powered-on state starts the scan.
            central = CBCentralManager(delegate: self, queue: .main)
        }
    }

    func stop() {
        wanted = false
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        forget()
        state = central?.state == .poweredOn ? .idle : .off
    }

    /// Sends a message: the ID byte, then the data.
    func send(_ id: MessageID, _ data: Data = Data()) {
        guard let peripheral, let rx else {
            Self.log.info("not sent, no beacon: \(id.rawValue)")
            return
        }
        var message = Data([id.rawValue])
        message.append(data)
        let type: CBCharacteristicWriteType = rx.properties.contains(.write) ? .withResponse : .withoutResponse
        if message.count > peripheral.maximumWriteValueLength(for: type) {
            problem = "A message to the beacon is too long for one write (\(message.count) bytes)."
        }
        Self.log.info("send \(id.rawValue) with \(data.count) bytes")
        peripheral.writeValue(message, for: rx, type: type)
    }

    private func scan() {
        guard wanted, let central, central.state == .poweredOn, peripheral == nil else { return }
        state = .scanning
        // No service filter: a beacon that does not advertise its service is still found by name. Every advert, so a
        // name that comes only in a later scan response is still matched to the target's ID.
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    /// A beacon's ID, upper case, from its advertised name or the API's `hardwareId`: the whole text when it is 8 hex
    /// digits, else the last run of 8 in it ("Hero Finder (86E7C53A)" and "DWM3001CDK (86E7C53A)" are both 86E7C53A).
    static func beaconID(_ text: String?) -> String? {
        guard let text else { return nil }
        return text.matches(of: /[0-9A-Fa-f]{8}/).last.map { String($0.output).uppercased() }
    }

    private func forget() {
        fallback = nil
        peripheral = nil
        rx = nil
        tx = nil
        serviceName = nil
    }

    private func isBeacon(_ advertisement: [String: Any], name: String?) -> Bool {
        let advertised = (advertisement[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
            + (advertisement[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? [])
        if advertised.contains(where: { uuid in Self.services.contains { $0.id == uuid } }) { return true }
        guard let name = name?.lowercased() else { return false }
        return Self.names.contains { name.contains($0) }
    }
}

extension BeaconLink: @preconcurrency CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if state == .off { state = .idle }
            problem = nil
            scan()
        case .unauthorized:
            state = .off
            problem = "Bluetooth isn't allowed for this app: Settings › Apps › Ray-Ban spike."
        case .poweredOff:
            state = .off
            problem = "Bluetooth is off."
        default:
            state = .off
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        let isPreferred = preferred != nil && Self.beaconID(name) == preferred
        guard self.peripheral == nil, isPreferred || isBeacon(advertisementData, name: name) else { return }
        if preferred != nil, !isPreferred {
            // Not the target's beacon: kept, and taken if the target's does not show within three seconds.
            if fallback == nil {
                fallback = (peripheral, name, RSSI.intValue)
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    self?.takeFallback()
                }
            }
            return
        }
        take(peripheral, name: name, rssi: RSSI.intValue)
    }

    private func takeFallback() {
        guard wanted, peripheral == nil, let fallback else { return }
        take(fallback.peripheral, name: fallback.name, rssi: fallback.rssi)
    }

    private func take(_ peripheral: CBPeripheral, name: String?, rssi: Int) {
        guard let central else { return }
        central.stopScan()
        fallback = nil
        self.name = name ?? "Beacon"
        self.rssi = rssi
        self.peripheral = peripheral
        peripheral.delegate = self
        state = .connecting(self.name ?? "Beacon")
        Self.log.info("found \(self.name ?? "-", privacy: .public) at \(rssi) dBm")
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        servicesSeen = []
        // Every service, so a beacon on other UUIDs shows what it has.
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: (any Error)?) {
        problem = "Couldn't connect to the beacon: \(error?.localizedDescription ?? "no reason given")."
        forget()
        scan()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: (any Error)?) {
        Self.log.info("disconnected: \(error?.localizedDescription ?? "asked to", privacy: .public)")
        let was = self.peripheral != nil
        forget()
        if wanted {
            if was { onLost?() }
            scan()
        }
    }
}

extension BeaconLink: @preconcurrency CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: (any Error)?) {
        let offered = peripheral.services ?? []
        servicesSeen = offered.map(\.uuid.uuidString)
        guard let service = offered.first(where: { offered in Self.services.contains { $0.id == offered.uuid } }),
              let known = Self.services.first(where: { $0.id == service.uuid }) else {
            problem = "The beacon offers no service this app knows: \(servicesSeen.joined(separator: ", "))."
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        serviceName = known.name
        peripheral.discoverCharacteristics([known.rx, known.tx], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: (any Error)?) {
        guard let known = Self.services.first(where: { $0.id == service.uuid }) else { return }
        rx = service.characteristics?.first { $0.uuid == known.rx }
        tx = service.characteristics?.first { $0.uuid == known.tx }
        guard let tx, rx != nil else {
            problem = "The beacon's \(known.name) service lacks its RX or TX characteristic."
            return
        }
        peripheral.setNotifyValue(true, for: tx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: (any Error)?) {
        guard characteristic.uuid == tx?.uuid else { return }
        if let error {
            problem = "The beacon refused to notify: \(error.localizedDescription)."
            return
        }
        state = .connected(name ?? "Beacon")
        onReady?()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: (any Error)?) {
        guard characteristic.uuid == tx?.uuid, let value = characteristic.value, let first = value.first else { return }
        guard let id = MessageID(rawValue: first) else {
            Self.log.info("unknown message \(first) with \(value.count - 1) bytes")
            return
        }
        Self.log.info("heard \(first) with \(value.count - 1) bytes")
        onMessage?(id, Data(value.dropFirst()))
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                    error: (any Error)?) {
        if let error { problem = "Couldn't write to the beacon: \(error.localizedDescription)." }
    }
}
