// LG WM12WVC4S6 (kind F_V7_Y___W.B__QEUK).
//
// Same AABB frame layout as F_V8 (verified by capture), so this extends F_V8 and
// reuses all of its sensor/command handling via super.*. What it adds on top is a
// remote-start that survives the firmware's sleep bug: this firmware forgets the
// configured course/spin/temp when it falls asleep with remote_start armed, and
// wakes up running the default (Cotton) program.
//
// Two pieces solve that:
//   1. LATCH: snapshot the last armed program off the status frame and persist it
//      to /data, so it survives add-on / HA restarts.
//   2. RESTORE: a 'remote_start_saved' button drives a small state machine that
//      wakes the device ONLY if it is asleep (power-on is a toggle here, so waking
//      an already-awake device would switch it off) and then sends an f026 "start
//      with this config" command built from the latched snapshot.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import F_V8 from './F_V8_Y___W.B_2QEUK'
import { allowExtendedType } from '@/util/casting'
import { type Connection, type ComponentInfo } from '../homeassistant'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Metadata } from '../thinq'

type SavedConfig = { course: number; spin: number; temp: number }

// IDLE: nothing pending. WAKING: wake sent, waiting for the device to wake (its
// course goes from 0/unknown back to a real program). STARTING: transient, while
// the f026 is built and sent before returning to IDLE.
type FsmState = 'IDLE' | 'WAKING' | 'STARTING'

// Guard timeout: if the device never reports as awake after the wake, give up
// instead of hanging forever (design: "esperar el frame", with a safety timeout).
const WAKE_TIMEOUT_MS = 30_000

export default class Device extends F_V8 {
    // Last course byte and remote_start flag seen on the wire. The wake FSM uses
    // these to detect "asleep": this washer clears state sequentially when it sleeps
    // (spin/temp first, then course to 0 in the last frame before it goes silent), so
    // a truly-asleep device is always course==0 with remote_start still armed.
    // (Validated on-device by the user. The status byte is NOT reliable here.)
    private lastCourse = 0
    private lastRemoteStart = false
    private savedConfig?: SavedConfig
    // serialized form of what is currently on disk, so we only write when it changes.
    private persistedConfig?: string

    private fsm: FsmState = 'IDLE'
    private wakeTimer?: ReturnType<typeof setTimeout>

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta)

        // Add the remote-start button on top of F_V8's components without rewriting
        // them. allowExtendedType is the same escape hatch F_V8 uses for the extra
        // (non-ComponentInfo) keys like command_topic.
        if (this.config) {
            this.setConfig(
                allowExtendedType({
                    ...this.config,
                    components: {
                        ...this.config.components,
                        remote_start_saved: {
                            platform: 'button',
                            unique_id: '$deviceid-remote_start_saved',
                            command_topic: '$this/remote_start_saved/set',
                            payload_press: '',
                            name: 'Remote start (saved config)',
                            icon: 'mdi:play-circle-outline',
                        },
                    },
                }),
            )
        }

        // Restore the latch persisted across add-on / HA restarts: the user arms the
        // washer in the evening but the remote start fires hours later, possibly after
        // a restart, so the saved program must survive on disk (design decision #1).
        try {
            const path = this.savedConfigPath()
            if (existsSync(path)) {
                const raw = readFileSync(path).toString('utf-8')
                this.savedConfig = JSON.parse(raw) as SavedConfig
                this.persistedConfig = raw
            }
        } catch (e) {
            console.warn(`F_V7 ${this.id}: could not read saved config:`, e)
        }
    }

    private savedConfigPath() {
        return `/data/saved_config_${this.id}.json`
    }

    processAABB(buf: Buffer) {
        super.processAABB(buf) // F_V8 publishes all sensors as usual

        if (buf.length !== 80 || buf[0] !== 0x20) return

        const course = buf[48]
        const spin = buf[51]
        const temp = buf[52]
        const remoteStart = buf[58] & 2

        // Track course + armed flag so the wake FSM can detect asleep/awake from the
        // real device state (design decision #2/#3).
        this.lastCourse = course
        this.lastRemoteStart = !!remoteStart

        // LATCH: remember the program only while it is a FULLY valid armed program.
        // When the firmware sleeps it keeps remote_start armed but corrupts the frame:
        // course may still read non-zero (seen: 7) while spin/temp drop to 0, which are
        // invalid indices (SPINS/TEMPERATURES start at 1; 0 == "unknown"). Requiring all
        // three != 0 rejects those sleep frames so they cannot clobber the real snapshot
        // taken while awake. (Confirmed by capture: a sleep frame reported course=7
        // spin=0 temp=0 and overwrote a good Sports Wear 8/2/2.) Persist only on change
        // to avoid rewriting /data on every status frame (design decision #1).
        if (remoteStart && course !== 0 && spin !== 0 && temp !== 0) {
            const next: SavedConfig = { course, spin, temp }
            const serialized = JSON.stringify(next)
            if (serialized !== this.persistedConfig) {
                this.savedConfig = next
                try {
                    writeFileSync(this.savedConfigPath(), serialized)
                    this.persistedConfig = serialized
                } catch (e) {
                    console.warn(`F_V7 ${this.id}: could not persist saved config:`, e)
                }
            }
        }

        // Wake FSM: a device we were waking reports a real course again (course != 0)
        // -> it is awake, so send the saved config.
        if (this.fsm === 'WAKING' && course !== 0) {
            this.clearWakeTimer()
            this.fsm = 'STARTING'
            this.sendF026()
            this.fsm = 'IDLE'
        }
    }

    // Asleep == course reads 0 while remote_start is still armed. The firmware clears
    // state sequentially on sleep and the final pre-sleep frame always drops course to
    // 0, so course==0 + armed uniquely identifies a truly-asleep device. An awake,
    // armed program always reports a real (non-zero) course, so this never misreads
    // awake as asleep — which matters: the wake is a toggle that would power an awake
    // device OFF.
    private isAsleep(): boolean {
        return this.lastRemoteStart && this.lastCourse === 0
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'remote_start_saved') {
            this.executeRemoteStart()
            return
        }
        super.setProperty(prop, mqttValue) // power/pause/start of F_V8 untouched
    }

    // Drives IDLE -> (WAKING) -> STARTING -> IDLE.
    private executeRemoteStart() {
        if (!this.savedConfig) {
            console.warn(`F_V7 ${this.id}: remote_start_saved pressed but no saved config; ignoring`)
            return
        }

        // Re-trigger guard: never restart mid-sequence. The wake (F02A0100) is a
        // TOGGLE on this washer, so re-sending it while already WAKING would turn the
        // device back OFF. Ignore presses until the current sequence settles.
        if (this.fsm !== 'IDLE') {
            console.info(`F_V7 ${this.id}: remote start already in progress (${this.fsm}); ignoring press`)
            return
        }

        if (this.isAsleep()) {
            // Asleep: toggle it on, then wait for it to report a known course (= awake)
            // before starting. Send the wake ONLY here, where we have confirmed it is
            // asleep — the toggle would power an awake device OFF.
            console.info(`F_V7 ${this.id}: device asleep (course unknown + armed), sending wake`)
            this.fsm = 'WAKING'
            this.send(Buffer.from('F02A0100', 'hex'))
            this.wakeTimer = setTimeout(() => {
                console.warn(`F_V7 ${this.id}: timed out waiting for device to wake; aborting`)
                this.fsm = 'IDLE'
                this.wakeTimer = undefined
            }, WAKE_TIMEOUT_MS)
        } else {
            // Already awake: start directly. Do NOT send the wake toggle (it would
            // power the device off).
            console.info(`F_V7 ${this.id}: device awake, starting saved config directly`)
            this.fsm = 'STARTING'
            this.sendF026()
            this.fsm = 'IDLE'
        }
    }

    private clearWakeTimer() {
        if (this.wakeTimer) {
            clearTimeout(this.wakeTimer)
            this.wakeTimer = undefined
        }
    }

    // Builds and sends the f026 "start with this config" command from the latched
    // snapshot. Raw config bytes (no name->byte table). send() of aabb_device adds
    // the aa/len framing and the checksum, so we only provide the inner payload:
    //   f0 26 [course] 03 [spin] [temp] 01 00 00 00 00 00 03 00 00 00 00 00
    // (byte 6 = rinse=normal, byte 8 = delay=off, byte 12 = 03 = start; fixed for v1.)
    private sendF026() {
        const cfg = this.savedConfig
        // Refuse to send an incomplete config: sending spin/temp = 0 (invalid indices)
        // makes the device ack the command but never start. This also guards against a
        // stale snapshot persisted before the latch was tightened.
        if (!cfg || !cfg.course || !cfg.spin || !cfg.temp) {
            console.warn(
                `F_V7 ${this.id}: saved config missing/incomplete (${JSON.stringify(cfg)}); ` +
                    `arm a full program (course/spin/temp) first. Skipping f026.`,
            )
            return
        }
        const inner = Buffer.from([
            0xf0, 0x26, cfg.course, 0x03, cfg.spin, cfg.temp,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])
        console.info(`F_V7 ${this.id}: starting saved config course=${cfg.course} spin=${cfg.spin} temp=${cfg.temp}`)
        this.send(inner)
    }
}
