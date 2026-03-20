/**
 * Zigbee2MQTT external converter for Myuet AR331 Pro / Matosio AR331-WZ TRV.
 * Device fingerprint: TS0601 / _TZE284_nbv4tdaz
 *
 * Full DP map (confirmed via Tuya Cloud API "query properties"):
 *   DP  1  (bool)  - preheat: read-only status bit; true while boost heating (DP101) is active
 *   DP  2  (enum)  - mode/preset: auto|manual|holiday|eco|comfort|standby
 *   DP  3  (enum)  - work_state: opened|closed (valve/running state)
 *   DP  4  (value) - temp_set: target temperature (°C × 10, 50–400)
 *   DP  5  (value) - temp_current: local temperature (°C × 10, signed)
 *   DP  6  (value) - battery_percentage (0–100)
 *   DP  7  (bool)  - child_lock: true=LOCK, false=UNLOCK
 *   DP  9  (value) - upper_temp: upper temperature limit (°C × 10, 280–400) — stored but NOT enforced by device
 *   DP 10  (value) - lower_temp: lower temperature limit (°C × 10, 50–200) — stored but NOT enforced by device
 *   DP 14  (bool)  - window_check: open window detection enabled
 *   DP 15  (enum)  - window_state: closed|open (read-only)
 *   DP 16  (value) - window_temp: window detection temperature drop threshold (°C × 10)
 *   DP 18  (value) - backlight/display_brightness (0–7)
 *   DP 19  (bool)  - factory_reset: not triggerable via Zigbee (device-button or cloud only)
 *   DP 28–34 (raw) - week_program_13_1..7: weekly schedule Mon–Sun (8 timeslots, 33 bytes each)
 *   DP 35  (bitmap)- fault code (read-only)
 *   DP 47  (value) - temp_correction: local temperature calibration (°C × 10, signed, –100…100)
 *   DP 49  (enum)  - valve_state: open|close (read-only)
 *   DP 101 (bool)  - boost_en: boost heating on/off
 *   DP 102 (value) - boost_timestamp: boost countdown (seconds, 0–86400, step 1800)
 *   DP 103 (value) - eco_tmp: eco target temperature (°C × 10)
 *   DP 104 (value) - comfort_tmp: comfort target temperature (°C × 10)
 *   DP 105 (value) - window_timestamp: open-window detection delay (seconds, step 60)
 *   DP 106 (raw)   - holiday_timestamp: holiday start/end [prefix, ts_start_LE4, ts_end_LE4] (9 bytes)
 *   DP 107 (value) - freezing_tmp: frost protection temperature (°C × 10, 0–150)
 *   DP 108 (value) - window_stoptime: min. window-open duration before closing valve (seconds, step 60)
 *   DP 109 (bool)  - heating_or_cooling: false=heating, true=cooling
 *   DP 110 (bool)  - battery_status: battery low flag (read-only)
 *   DP 111 (value) - display_direction: screen orientation in degrees (0/90/180/270)
 *   DP 112 (enum)  - pro_mode: schedule type — 52day|7day|24hour
 *                    Controls how the weekly program repeats:
 *                      7day   = 7 individual day programs (Mon–Sun), repeated weekly (default)
 *                      24hour = one program applies to all days
 *                      52day  = one program per calendar day (requires Tuya cloud; not usable over Zigbee)
 *                    Not exposed — changing this over Zigbee is error-prone and rarely needed.
 *   DP 113 (bool)  - switch: summer mode (true=ON → heating disabled, valve stays closed;
 *                    frost protection via DP 107 still active as safety net)
 *   DP 114 (value) - override_temp: temporary manual override temperature (°C × 10)
 *   DP 115 (bool)  - overide_en: temporary manual override active
 *
 * Notes:
 *   - DP 102 boost_timestamp is in seconds (max 86400), step 1800 (= 30 min steps).
 *     Exposed as minutes for usability (÷60 / ×60).
 *   - DP 111 display_direction sent as plain uint32 (degrees), NOT as Tuya enum.
 *   - holiday_temperature (the per-holiday setpoint) does not have a dedicated DP in the
 *     Tuya API response; it is likely encoded inside DP 106 or is the DP 4 value at holiday switch.
 *     Left unmapped until confirmed.
 *   - DP 15 window_state is an enum ("closed"/"open"), not a bool — using custom converter.
 *
 * Schedule RAW byte format (DP 28–34), 8 timeslots per day:
 *   Byte[0]       = day number (1=Mon … 7=Sun)
 *   Byte[1+i*4]   = hour   slot i  (0–23)
 *   Byte[2+i*4]   = minute slot i  (0–59)
 *   Byte[3+i*4]   = temp high byte ─┐ uint16 BE = temp × 10
 *   Byte[4+i*4]   = temp low  byte ─┘
 *   33 bytes total (1 + 8 slots × 4 bytes)
 */
const tuya = require("zigbee-herdsman-converters/lib/tuya");
const e = require("zigbee-herdsman-converters/lib/exposes").presets;
const ea = require("zigbee-herdsman-converters/lib/exposes").access;
const globalStore = require("zigbee-herdsman-converters/lib/store");

const SCHEDULE_SLOTS = 8;
const SCHEDULE_BYTES = 1 + SCHEDULE_SLOTS * 4; // 33

const scheduleExample = "00:00/16.0 06:00/20.5 09:00/18.0 12:00/21.0 14:00/18.0 17:00/21.0 22:00/16.0 23:00/16.0";

// Schedule converter: supports 8 timeslots per day, temperature range 5–40°C.
// Byte format: [dayNum, HH, MM, TH, TL, HH, MM, TH, TL, ...] (33 bytes total)
function scheduleConverter(dayNum) {
    return {
        from: (v) => {
            if (!v || v.length < SCHEDULE_BYTES) return undefined;
            const slots = [];
            for (let i = 1; i < SCHEDULE_BYTES; i += 4) {
                
                const hh = v[i];
                const mm = v[i + 1];
                const temp = ((v[i + 2] << 8) | v[i + 3]) / 10;
                if (hh > 23 || mm > 59) return undefined;
                slots.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}/${temp.toFixed(1)}`);
            }
            return slots.join(" ");
        },
        to: (v) => {
            if (v == null || (typeof v === "string" && !v.trim())) return undefined;
            const parts = v.trim().split(/\s+/).filter(Boolean);
            if (parts.length !== SCHEDULE_SLOTS)
                throw new Error(`Invalid schedule: expected ${SCHEDULE_SLOTS} timeslots, got ${parts.length}`);
            const payload = new Array(SCHEDULE_BYTES).fill(0);
            payload[0] = dayNum;
            parts.forEach((part, idx) => {
                const [time, tempStr] = part.split("/");
                const [hh, mm] = time.split(":");
                const t = Math.round(parseFloat(tempStr) * 10);
                payload[1 + idx * 4] = parseInt(hh, 10);
                payload[1 + idx * 4 + 1] = parseInt(mm, 10);
                payload[1 + idx * 4 + 2] = (t >> 8) & 0xff;
                payload[1 + idx * 4 + 3] = t & 0xff;
            });
            return payload;
        },
    };
}

// Holiday-time converter for DP 106: [prefix_byte, ts_start_LE4, ts_end_LE4]
// Encodes/decodes to "YYYY/MM/DD HH:MM | YYYY/MM/DD HH:MM" (same format as TRV603-WZ DP 110)
const holidayTimeConverter = {
    from: (v) => {
        if (!v || v.length < 9) return "";
        const readLE32 = (arr, offset) =>
            (arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16) | (arr[offset + 3] * 16777216)) >>> 0;
        const startTS = readLE32(v, 1);
        const endTS = readLE32(v, 5);
        const fmt = (ts) => {
            const d = new Date(ts * 1000);
            const pad = (n) => String(n).padStart(2, "0");
            return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        };
        return `${fmt(startTS)} | ${fmt(endTS)}`;
    },
    to: (v) => {
        const [startStr, endStr] = v.split("|").map((s) => s.trim());
        const parseTS = (s) => {
            const [datePart, timePart] = s.split(" ");
            const [y, m, d] = datePart.split("/").map(Number);
            const [h, min] = timePart.split(":").map(Number);
            const ts = Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000);
            return [ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff];
        };
        return [0, ...parseTS(startStr), ...parseTS(endStr)];
    },
};

// Preset converter wrapper: records timestamp of last preset change so that the
// setpoint filter below can tell apart a mode-switch DP4 burst from a manual setpoint change.
function makePresetConverter(lookupMap) {
    const base = tuya.valueConverterBasic.lookup(lookupMap);
    return {
        from: (v, meta) => {
            if (meta && meta.device) globalStore.putValue(meta.device, "dp2Time", Date.now());
            return base.from(v);
        },
        to: base.to,
    };
}

// Setpoint filter:
// The device periodically broadcasts ALL preset temperatures as DP4 in rapid succession
// (garbage → 9°C → 16°C → 26.5°C → 12°C → 0°C, all within ~5 sec) without any DP2.
// A genuine mode-switch at the device always sends DP2 first, then DP4 within ~1 sec.
// A genuine manual setpoint change sends a single isolated DP4.
// Strategy:
//   - Out-of-range (< 5°C or > 40°C raw): always discard → burst artefact
//   - DP4 arrives within 2 sec of a DP2 (preset change): accept → mode-switch setpoint
//   - DP4 arrives without recent DP2, but <3 sec after previous DP4: discard → burst
//   - Otherwise: accept
function setpointFrom(v, meta) {
    const keepCurrent = () => {
        const cur = meta && meta.state && meta.state.current_heating_setpoint;
        return (cur !== undefined && cur !== null && cur >= 5) ? cur : 5;
    };
    if (v < 50 || v > 400) return keepCurrent();
    const device = meta && meta.device;
    if (device) {
        const now = Date.now();
        const lastPreset = globalStore.getValue(device, "dp2Time", 0);
        if (lastPreset > 0 && now - lastPreset < 2000) return v / 10; // mode-switch → accept
        const lastDp4 = globalStore.getValue(device, "dp4Time", 0);
        globalStore.putValue(device, "dp4Time", now);
        if (lastDp4 > 0 && now - lastDp4 < 3000) return keepCurrent(); // burst → discard
    }
    return v / 10;
}

// Setpoint converter: enforces comfort (18.5–40°C), eco (5–18°C) and holiday (5–15°C) ranges
const setpointConverter = {
    from: setpointFrom,
    to: (v, meta) => {
        const preset = meta && meta.state && meta.state.preset;
        let val = v;
        if (val < 5) val = 5;
        if (val > 40) val = 40;
        if (preset === "holiday" && val > 15) val = 15;
        if (preset === "eco" && val > 18) val = 18;
        if (preset === "comfort" && val < 18.5) val = 18.5;
        return Math.round(val * 10);
    },
};

// Local temperature calibration: signed value stored as uint32 with wrap-around for negatives.
// Range: -7 to +7°C in 0.5°C steps, stored as value × 10.
const localTempCalibrationConverter = {
    from: (v) => {
        if (v > 0x7fffffff) v -= 0x100000000;
        return v / 10;
    },
    to: (v) => {
        const scaled = Math.round(v * 10);
        if (scaled < 0) return scaled + 0x100000000;
        return scaled;
    },
};

// DP114 corrector: when the device sends an out-of-range override_temperature (e.g. a signed int16
// underflow when the knob is turned below 5°C), write the clamped minimum back to the device.
// Uses a 2-second debounce to avoid sending the correction twice (device echoes DP114 twice per change).
const fzDp114Corrector = {
    cluster: 'manuSpecificTuya',
    type: ['commandDataReport', 'commandDataResponse'],
    convert: (model, msg, publish, options, meta) => {
        for (const dpValue of msg.data.dpValues) {
            if (dpValue.dp !== 114) continue;
            const buf = dpValue.data;
            let raw;
            if (dpValue.datatype === 2) {
                raw = buf.readUInt32BE(0);
                if (raw > 32767) raw -= 65536; // signed int16 underflow
            } else if (dpValue.datatype === 0) {
                if (buf.length < 2) continue;
                raw = buf.readUInt16LE(0);
                if (raw > 32767) raw -= 65536;
            } else {
                continue;
            }
            const temp = raw / 10;
            if (temp < 5 || temp > 40) {
                // Debounce: device echoes DP114 twice per change, only correct once
                const now = Date.now();
                const lastCorrection = globalStore.getValue(msg.device, 'dp114CorrectionTime', 0);
                if (now - lastCorrection < 2000) continue;
                globalStore.putValue(msg.device, 'dp114CorrectionTime', now);
                const corrected = Math.round(Math.max(5, Math.min(40, temp)) * 10);
                msg.endpoint.command(
                    'manuSpecificTuya', 'dataRequest',
                    {seq: 1, dpValues: [{dp: 114, datatype: 2, data: corrected}]},
                    {disableDefaultResponse: true},
                ).catch(() => {});
            }
        }
    },
};

// AR331 Pro (_TZE284_nbv4tdaz): 6 presets, 8 schedule timeslots/day, boost, frost protection, etc.
const ar331pro = {
    fingerprint: [{modelID: "TS0601", manufacturerName: "_TZE284_nbv4tdaz"}],
    model: "AR331Pro",
    vendor: "Tuya",
    description: "Thermostatic radiator valve",
    fromZigbee: [tuya.fz.datapoints, fzDp114Corrector],
    toZigbee: [tuya.tz.datapoints],
    onEvent: tuya.onEventSetTime,
    exposes: [
        e.battery().withUnit("%"),
        e.binary("battery_status", ea.STATE, true, false).withDescription("Battery low warning"),
        e.binary("preheat", ea.STATE, "ON", "OFF").withDescription("Preheat/boost active (read-only status; use boost_heating to control)"),
        e.child_lock(),
        e
            .climate()
            .withPreset(["auto", "manual", "holiday", "comfort", "eco", "standby"], ea.STATE_SET)
            .withSetpoint("current_heating_setpoint", 5, 40, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withLocalTemperatureCalibration(-7, 7, 0.5, ea.STATE_SET)
            .withRunningState(["idle", "heat"], ea.STATE),
        // Summer mode: disables heating (valve stays closed). Frost protection (DP107) still active.
        e.binary("summer_mode", ea.STATE_SET, "ON", "OFF").withDescription("Summer mode: disables heating, valve stays closed. Frost protection temperature (DP107) remains active as safety net."),
        e.enum("heating_cooling_mode", ea.STATE_SET, ["heat", "cool"]).withDescription("Heating or cooling mode - In cooling mode valve is closed, works as temperature and window/door sensor"),
        // Temperature limits (DP9/DP10) — device stores these values but does NOT enforce them;
        // the setpoint can still be set to the full 5–40°C range regardless. Not exposed.
        // e.numeric("upper_temp", ea.STATE_SET)...
        // e.numeric("lower_temp", ea.STATE_SET)...
        // Stored per-preset temperatures
        e.eco_temperature().withValueMin(5).withValueMax(20).withValueStep(0.5),
        e.comfort_temperature().withValueMin(5).withValueMax(40).withValueStep(0.5),
        // Holiday
        e.text("holiday_time", ea.STATE_SET).withDescription("Holiday start and end in format YYYY/MM/DD HH:MM | YYYY/MM/DD HH:MM"),
        // Frost protection
        e.numeric("frost_protection_temperature", ea.STATE_SET).withUnit("°C").withDescription("Frost protection: valve opens below this temperature, closes at +3°C").withValueMin(0).withValueMax(15).withValueStep(0.5),
        // Boost heating
        e.binary("boost_heating", ea.STATE_SET, "ON", "OFF").withDescription("Boost Heating: the device will enter the boost heating mode."),
        e.numeric("boost_time", ea.STATE_SET).withUnit("min").withDescription("Boost duration in minutes").withValueMin(0).withValueMax(1440).withValueStep(30),
        // Open window detection
        e.binary("window_detection", ea.STATE_SET, "ON", "OFF").withDescription("Enable open-window detection"),
        e.binary("window_open", ea.STATE, "open", "closed").withDescription("Window is currently detected as open"),
        e.numeric("window_temp", ea.STATE_SET).withUnit("°C").withDescription("Window detection: temperature drop threshold").withValueMin(5).withValueMax(40).withValueStep(0.5),
        e.numeric("window_delay", ea.STATE_SET).withUnit("min").withDescription("Window detection: delay before triggering (minutes)").withValueMin(0).withValueMax(1440).withValueStep(1),
        e.numeric("window_close_delay", ea.STATE_SET).withUnit("min").withDescription("Window detection: minimum open time before valve closes (minutes)").withValueMin(0).withValueMax(1440).withValueStep(1),
        // Valve state
        e.binary("valve_state", ea.STATE, "open", "close").withDescription("Current valve state (read-only)"),
        // Fault code
        e.numeric("fault_code", ea.STATE).withDescription("Fault code bitmap (bit 0: program_fault, bit 1: low_battery, bit 2: sensor_fault)"),
        // DP19 factory_reset: not triggerable via Zigbee DP — omitted
        // Display
        e.enum("screen_orientation", ea.STATE_SET, ["up", "right", "down", "left"]).withDescription("Display orientation"),
        e.numeric("display_brightness", ea.STATE_SET).withDescription("Display brightness (1–7)").withValueMin(1).withValueMax(7).withValueStep(1),
        // Schedule mode (DP 112) intentionally not exposed — see header comment.
        // Override (temporary manual setpoint)
        e.binary("override_active", ea.STATE_SET, "ON", "OFF").withDescription("Temporary manual override active"),
        e.numeric("override_temperature", ea.STATE_SET).withUnit("°C").withDescription("Temporary manual override temperature").withValueMin(5).withValueMax(40).withValueStep(0.5),
        // Weekly schedule (8 timeslots per day)
        ...tuya.exposes.scheduleAllDays(ea.STATE_SET, scheduleExample),
    ],
    meta: {
        tuyaDatapoints: [
            [1, "preheat", tuya.valueConverter.onOff],
            [2, "preset", makePresetConverter({auto: tuya.enum(0), manual: tuya.enum(1), holiday: tuya.enum(2), eco: tuya.enum(3), comfort: tuya.enum(4), standby: tuya.enum(5)})],
            // work_state range: ["opened","closed"] → index 0 = opened = heating, index 1 = closed = idle
            [3, "running_state", tuya.valueConverterBasic.lookup({heat: tuya.enum(0), idle: tuya.enum(1)})],
            [4, "current_heating_setpoint", setpointConverter],
            [5, "local_temperature", {from: (v) => (v > 32767 ? v - 65536 : v) / 10}],
            [6, "battery", tuya.valueConverter.raw],
            [7, "child_lock", tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            // DP9/DP10: stored by device but not enforced — not mapped
            // [9, "upper_temp", tuya.valueConverter.divideBy10],
            // [10, "lower_temp", tuya.valueConverter.divideBy10],
            [14, "window_detection", tuya.valueConverter.onOff],
            [15, "window_open", tuya.valueConverterBasic.lookup({open: tuya.enum(0), closed: tuya.enum(1)})],
            [16, "window_temp", tuya.valueConverter.divideBy10],
            [18, "display_brightness", tuya.valueConverter.raw],
            // DP19 factory_reset: not triggerable via Zigbee DP — not mapped
            [35, "fault_code", tuya.valueConverter.raw],
            [47, "local_temperature_calibration", localTempCalibrationConverter],
            [49, "valve_state", tuya.valueConverterBasic.lookup({open: tuya.enum(0), close: tuya.enum(1)})],
            [101, "boost_heating", tuya.valueConverter.onOff],
            // DP 102 boost_timestamp is in seconds (step=1800); convert to/from minutes
            [102, "boost_time", {from: (v) => Math.round(v / 60), to: (v) => Math.round(v) * 60}],
            [103, "eco_temperature", tuya.valueConverter.divideBy10],
            [104, "comfort_temperature", tuya.valueConverter.divideBy10],
            // DP 105 window_timestamp: delay in seconds, expose as minutes
            [105, "window_delay", {from: (v) => Math.round(v / 60), to: (v) => Math.round(v) * 60}],
            [106, "holiday_time", holidayTimeConverter],
            [107, "frost_protection_temperature", tuya.valueConverter.divideBy10],
            // DP 108 window_stoptime: min open duration in seconds, expose as minutes
            [108, "window_close_delay", {from: (v) => Math.round(v / 60), to: (v) => Math.round(v) * 60}],
            [109, "heating_cooling_mode", tuya.valueConverterBasic.lookup({heat: false, cool: true})],
            [110, "battery_status", tuya.valueConverter.raw],
            // DP 111: screen orientation in degrees (plain uint32, NOT Tuya enum)
            [111, "screen_orientation", tuya.valueConverterBasic.lookup({up: 0, right: 90, down: 180, left: 270})],
            // DP 112 pro_mode intentionally not mapped — see header comment.
            [113, "summer_mode", tuya.valueConverter.onOff],
            // DP 114: device echoes the value twice — first as uint32 BE (datatype=2), then as
            // 2-byte little-endian raw buffer (datatype=0). Values below 0°C arrive as signed
            // int16 underflow (e.g. knob turned below minimum → 0xFFD3 = -4.5°C).
            // Decoded signed, then clamped. fzDp114Corrector writes the clamped value back.
            [114, "override_temperature", {
                from: (v) => {
                    let raw;
                    if (Buffer.isBuffer(v)) {
                        if (v.length < 2) return null;
                        raw = v.readUInt16LE(0);
                    } else {
                        raw = v;
                    }
                    if (raw > 32767) raw -= 65536; // signed int16 underflow
                    const temp = raw / 10;
                    return Math.max(5, Math.min(40, temp));
                },
                to: (v) => Math.round(v * 10),
            }],
            // DP 115: override_active is effectively read-only — the device ignores external write commands.
            // To clear the override remotely, cycle the preset: send preset=manual then preset=auto (2 s apart).
            [115, "override_active", tuya.valueConverter.onOff],
            // Weekly schedule: 8 timeslots per day, 33-byte raw payload
            [28, "schedule_monday", scheduleConverter(1)],
            [29, "schedule_tuesday", scheduleConverter(2)],
            [30, "schedule_wednesday", scheduleConverter(3)],
            [31, "schedule_thursday", scheduleConverter(4)],
            [32, "schedule_friday", scheduleConverter(5)],
            [33, "schedule_saturday", scheduleConverter(6)],
            [34, "schedule_sunday", scheduleConverter(7)],
        ],
    },
};

module.exports = [ar331pro];
