/**
 * Zigbee2MQTT external converter for Myuet AR331 Pro/Matosio AR331-WZ TRV.
 *
 * AR331 Pro/AR331-WZ (_TZE284_nbv4tdaz): 6 presets – auto / manual / holiday / eco / comfort / off
 *
 * Datapoints (confirmed via log analysis):
 *   DP 2  (enum)   - preset mode: 0=auto, 1=manual, 2=holiday, 3=eco, 4=comfort, 5=off
 *   DP 3  (enum)   - running state: 0=idle, 1=heat
 *   DP 4  (uint32) - current heating setpoint (°C × 10)
 *   DP 5  (int16)  - local temperature (°C × 10, signed; two's complement above 32767)
 *   DP 6  (uint32) - battery level (%)
 *   DP 7  (bool)   - child lock: false=LOCK, true=UNLOCK
 *   DP 28–34 (raw) - weekly schedule Mon–Sun
 *
 * Preset-specific setpoint ranges (firmware-enforced):
 *   eco     (3): 5–18°C
 *   comfort (4): 18.5–40°C
 *   holiday (2): up to 15°C
 *
 * NOTE: 'provisional mode' (manual override in auto) also reports DP2=2,
 *       indistinguishable from holiday.
 *
 * Additional DPs observed in logs (unconfirmed / best-guess):
 *   DP 103 (uint32) - eco_temperature: mirrors DP4 when setpoint changed in eco preset.
 *                     Likely the device's stored eco target. Observed range: 10–18°C.
 *   DP 104 (uint32) - comfort_temperature: mirrors DP4 when setpoint changed in comfort preset.
 *                     Likely the device's stored comfort target. Observed: 22.5°C.
 *   DP 107 (uint32) - holiday_temperature: mirrors DP4 while holiday preset active.
 *                     Strictly the stored holiday target temp. Observed: 10–10.5°C.
 *   DP 111 (uint32) - unknown; reported once as 0 at device startup. Possibly error/status counter.
 *   DP 114 (raw)    - unknown; reported as [200, 0] (uint16 LE = 200). May be a timer/threshold setting.
 *   DP 115 (bool)   - unknown; always false. Observed after preset changes. Possibly open-window toggle.
 *   DP 106 (raw)    - holiday schedule dates; 9-byte payload [0, ts_start_LE4, ts_end_LE4].
 *                     Bytes 1–4 = holiday start, bytes 5–8 = holiday end (Unix timestamps, LE uint32).
 *                     ts2 − ts1 is always exactly 14 days (= 1209600 s) when a holiday is programmed.
 *                     Sentinel value [0,64,46,117,103,64,46,117,103] = no holiday scheduled.
 *
 * Schedule RAW byte format (DP 28–34):
 *   Byte[0]       = day number (1=Mon … 7=Sun)
 *   Byte[1+i*4]   = hour   slot i  (0–23)
 *   Byte[2+i*4]   = minute slot i  (0–59)
 *   Byte[3+i*4]   = temp high byte ─┐ uint16 BE = temp × 10
 *   Byte[4+i*4]   = temp low  byte ─┘
 *   Always 17 bytes fixed (1 + 4 slots × 4 bytes).
 */
const tuya = require("zigbee-herdsman-converters/lib/tuya");
const e = require("zigbee-herdsman-converters/lib/exposes").presets;
const ea = require("zigbee-herdsman-converters/lib/exposes").access;
const globalStore = require("zigbee-herdsman-converters/lib/store");

const scheduleExample = "00:00/16.0 06:00/20.5 17:00/21.0 22:00/16.0";

// Schedule converter: handles empty/null values silently and supports the full
// AR331-WZ temperature range (5–40°C). The built-in tuya converter caps at 35°C.
function scheduleConverter(dayNum) {
    return {
        from: (v) => {
            if (!v || v.length < 17) return undefined;
            const slots = [];
            for (let i = 1; i <= 13; i += 4) {
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
            if (parts.length !== 4) throw new Error(`Invalid schedule: there should be 4 transitions`);
            const payload = new Array(17).fill(0);
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

// Preset converter wrapper: records timestamp of last preset change so that the
// setpoint filter below can tell apart a mode-switch DP4 from a burst DP4.
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
        return (cur !== undefined && cur !== null) ? cur : 5;
    };
    if (v < 50 || v > 400) return keepCurrent();
    const device = meta && meta.device;
    if (device) {
        const now = Date.now();
        const lastPreset = globalStore.getValue(device, "dp2Time", 0);
        if (lastPreset > 0 && (now - lastPreset) < 2000) return v / 10; // mode-switch → accept
        const lastDp4 = globalStore.getValue(device, "dp4Time", 0);
        globalStore.putValue(device, "dp4Time", now);
        if (lastDp4 > 0 && (now - lastDp4) < 3000) return keepCurrent(); // burst → discard
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

// --- AR331-WZ (_TZE284_nbv4tdaz): 6 presets, comfort/eco/off ---
// NOTE: 'provisional mode' (manual override in auto) also reports DP2=2, indistinguishable from holiday
const ar331wz = {
    fingerprint: [{modelID: "TS0601", manufacturerName: "_TZE284_nbv4tdaz"}],
    model: "AR331-WZ",
    vendor: "Tuya",
    description: "Thermostatic Radiator Valve",
    fromZigbee: [tuya.fz.datapoints],
    toZigbee: [tuya.tz.datapoints],
    onEvent: tuya.onEventSetTime,
    exposes: [
        e.battery().withUnit("%"),
        e.child_lock(),
        e
            .climate()
            .withPreset(["auto", "manual", "holiday", "comfort", "eco", "off"], ea.STATE_SET)
            .withSetpoint("current_heating_setpoint", 5, 40, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withRunningState(["idle", "heat"], ea.STATE)
            .withSystemMode(["heat"], ea.STATE_SET, "Only for Homeassistant"),
        // DP 103: stored eco target — observed mirroring DP4 whenever setpoint adjusted in eco preset
        e.eco_temperature().withValueMin(5).withValueMax(18).withValueStep(0.5),
        // DP 104: stored comfort target — observed mirroring DP4 whenever setpoint adjusted in comfort preset
        e.comfort_temperature().withValueMin(18.5).withValueMax(40).withValueStep(0.5),
        // DP 107 tentative: observed mirroring DP4 while holiday preset active → stored holiday target temp
        e.numeric("holiday_temperature", ea.STATE_SET).withUnit("°C").withDescription("Holiday (away) temperature").withValueMin(5).withValueMax(15).withValueStep(0.5),
        ...tuya.exposes.scheduleAllDays(ea.STATE_SET, scheduleExample),
    ],
    meta: {
        tuyaDatapoints: [
            [
                2,
                "preset",
                makePresetConverter({
                    auto: tuya.enum(0),
                    manual: tuya.enum(1),
                    holiday: tuya.enum(2),
                    eco: tuya.enum(3),
                    comfort: tuya.enum(4),
                    off: tuya.enum(5),
                }),
            ],
            [3, "running_state", tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, "current_heating_setpoint", setpointConverter],
            [5, "local_temperature", {from: (v) => (v > 32767 ? v - 65536 : v) / 10}],
            [6, "battery", tuya.valueConverter.raw],
            [7, "child_lock", tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            [103, "eco_temperature", tuya.valueConverter.divideBy10],
            [104, "comfort_temperature", tuya.valueConverter.divideBy10],
            [107, "holiday_temperature", tuya.valueConverter.divideBy10],
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

module.exports = [ar331wz];
