// LG WM12WVC4S6 (kind F_V7_Y___W.B__QEUK).
//
// Same AABB frame layout as F_V8 (verified by capture), so this extends F_V8 and
// reuses all of its sensor/command handling via super.*. What it adds on top is a
// "latch": this firmware forgets the configured course/spin/temp when it falls
// asleep with remote_start armed, and wakes up running the default (Cotton) program.
// To work around that we snapshot the last armed program off the status frame and
// persist it, so a later remote start can restore it. Restoring the program (FSM +
// f026 command) lands in a follow-up; this commit only does the latch + persistence.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import F_V8 from './F_V8_Y___W.B_2QEUK'
import { type Connection } from '../homeassistant'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Metadata } from '../thinq'

type SavedConfig = { course: number; spin: number; temp: number }

export default class Device extends F_V8 {
    // last status byte seen on the wire; the wake FSM (follow-up) uses it to tell
    // a sleeping device (status 0) from an awake one.
    private lastStatus = 0
    private savedConfig?: SavedConfig
    // serialized form of what is currently on disk, so we only write when it changes.
    private persistedConfig?: string

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta)

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

        // Always track the live status so the wake FSM (follow-up) can react to the
        // real device state instead of guessing with delays (design decision #2/#3).
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
    }
}
