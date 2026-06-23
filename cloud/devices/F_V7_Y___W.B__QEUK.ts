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
//      wakes the device if asleep and then sends an f026 "start with this config"
//      command built from the latched snapshot.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import F_V8 from './F_V8_Y___W.B_2QEUK'
import { allowExtendedType } from '@/util/casting'
import { type Connection, type ComponentInfo } from '../homeassistant'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Metadata } from '../thinq'

type SavedConfig = { course: number; spin: number; temp: number }

// IDLE: nothing pending. WAKING: wake sent, waiting for an awake status frame.
// STARTING: transient, while the f026 is built and sent before returning to IDLE.
type FsmState = 'IDLE' | 'WAKING' | 'STARTING'

// Guard timeout: if no awake frame arrives after the wake, give up instead of
// hanging forever (design: "esperar el frame, no delays", with a safety timeout).
const WAKE_TIMEOUT_MS = 30_000

export default class Device extends F_V8 {
    // last status byte seen on the wire; the wake FSM uses it to tell a sleeping
    // device (status 0) from an awake one.
    private lastStatus = 0
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

        const status = buf[43]
        const course = buf[48]
        const spin = buf[51]
        const temp = buf[52]
        const remoteStart = buf[58] & 2

        // Always track the live status so the wake FSM reacts to the real device
        // state instead of guessing with delays (design decision #2/#3).
        this.lastStatus = status

        // LATCH: remember the program only while it is real and armed. The firmware
        // wipes course/spin/temp on sleep, so we snapshot it while remote_start is
        // armed and the course is still valid (!= 0). Persist only on change to avoid
        // rewriting /data on every status frame (design decision #1).
        if (remoteStart && course !== 0) {
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

        // Wake FSM: the device we were waking is now awake -> send the saved config.
        if (this.fsm === 'WAKING' && status > 0) {
            this.clearWakeTimer()
            this.fsm = 'STARTING'
            this.sendF026()
            this.fsm = 'IDLE'
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'remote_start_saved') {
            this.executeRemoteStart()
            return
        }
        super.setProperty(prop, mqttValue) // power/pause/start of F_V8 untouched
    }

    // Drives IDLE -> (WAKING) -> STARTING -> IDLE. A re-trigger restarts the
    // sequence from scratch (clears any pending wake/timeout and re-evaluates).
    private executeRemoteStart() {
        if (!this.savedConfig) {
            console.warn(`F_V7 ${this.id}: remote_start_saved pressed but no saved config; ignoring`)
            return
        }

        this.clearWakeTimer()

        if (this.lastStatus === 0) {
            // Device asleep: wake it, then wait for the next awake frame (no fixed delay).
            console.info(`F_V7 ${this.id}: device asleep, sending wake before saved start`)
            this.fsm = 'WAKING'
            this.send(Buffer.from('F02A0100', 'hex'))
            this.wakeTimer = setTimeout(() => {
                console.warn(`F_V7 ${this.id}: timed out waiting for wake frame; aborting remote start`)
                this.fsm = 'IDLE'
                this.wakeTimer = undefined
            }, WAKE_TIMEOUT_MS)
        } else {
            // Already awake: start immediately.
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
        if (!cfg) {
            console.warn(`F_V7 ${this.id}: sendF026 with no saved config; skipping`)
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
