/**
 * Zigbee2MQTT external converters for Myuet/Matosio AR331-series TRVs.
 *
 * AR331      (_TZE284_noixx2uz): 3 presets – auto / manual / holiday
 * AR331-WZ   (_TZE284_nbv4tdaz): 6 presets – auto / manual / holiday / comfort / eco / off
 *
 * Datapoints (both models – confirmed via log analysis):
 *   DP 2  (enum)   - preset mode
 *   DP 3  (enum)   - running state: 0=idle, 1=heat
 *   DP 4  (uint32) - current heating setpoint (°C × 10)
 *   DP 5  (int16)  - local temperature (°C × 10, signed; two's complement above 32767)
 *   DP 6  (uint32) - battery level (%) — confirmed for AR331; not yet observed for AR331-WZ (likely same)
 *   DP 7  (bool)   - child lock: false=LOCK, true=UNLOCK
 *   DP 28–34 (raw) - schedule Mon–Sun
 *
 * AR331-WZ additional preset values:
 *   comfort (3): setpoint range 18.5–40°C  (firmware-enforced)
 *   eco     (4): setpoint range 5–18°C     (firmware-enforced)
 *   off     (5): all symbols dark on display
 *   NOTE: 'provisional mode' (manual override in auto) also reports DP2=2,
 *         indistinguishable from holiday.
 *
 * Additional DPs observed in logs (AR331-WZ, unconfirmed / best-guess):
 *   DP 103 (uint32) - comfort_temperature: mirrors DP4 whenever setpoint is changed in comfort preset.
 *                     Likely the device's stored comfort target (read/write). Observed range: 10–18°C.
 *   DP 104 (uint32) - eco_temperature: mirrors DP4 whenever setpoint is changed in eco preset.
 *                     Likely the device's stored eco target (read/write). Observed: 22.5°C.
 *   DP 107 (uint32) - holiday_temperature (AR331-WZ only): mirrors DP4 at session start when device was in
 *                     holiday preset, then tracks holiday setpoint adjustments. Observed: 10–10.5°C.
 *                     Not observed for AR331 (_TZE284_noixx2uz).
 *   DP 111 (uint32) - unknown; reported once as 0 at device startup. Possibly an error/status counter.
 *   DP 114 (raw)    - open-window max-duration setting; reported as [200, 0] (uint16 LE = 200 min).
 *                     Pairs with DP 106 (timestamps) and DP 115 (active flag).
 *   DP 115 (bool)   - open-window active flag; false=inactive, true=window open detected.
 *                     Resets to false after every preset change or window-close event.
 *   DP 106 (raw)    - open-window event timestamps; 9-byte payload [0, ts1_LE4, ts2_LE4].
 *                     Bytes 1–4 and 5–8 are Unix timestamps (LE uint32). When both are equal the
 *                     feature is idle/reset. Likely: ts1 = window-open time, ts2 = window-close time.
 *                     Example: [0,229,244,118,103,229,105,137,103] → 2025-01-02T20:19Z / 2025-01-16T20:19Z.
 *
 * Schedule RAW byte format (DP 28–34):
 *   Byte[0]       = day number (1=Mon … 7=Sun)
 *   Byte[1+i*4]   = hour   slot i  (0–23)
 *   Byte[2+i*4]   = minute slot i  (0–59)
 *   Byte[3+i*4]   = temp high byte ─┐ uint16 BE = temp × 10
 *   Byte[4+i*4]   = temp low  byte ─┘
 *   Always 17 bytes fixed (1 + 4 slots × 4 bytes).
 *   Equivalent to tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(dayNum).
 */
const tuya = require("zigbee-herdsman-converters/lib/tuya");
const e = require("zigbee-herdsman-converters/lib/exposes").presets;
const ea = require("zigbee-herdsman-converters/lib/exposes").access;

const scheduleExample = "06:00/16.0 08:00/20.5 17:00/21.0 22:00/16.0";

// Setpoint converter for AR331: firmware enforces holiday preset max 15°C
const setpointConverterAR331 = {
    from: (v) => v / 10,
    to: (v, meta) => {
        const preset = meta && meta.state && meta.state.preset;
        let val = v;
        if (val < 5) val = 5;
        if (val > 40) val = 40;
        if (preset === "holiday" && val > 15) val = 15;
        return Math.round(val * 10);
    },
};

// Setpoint converter for AR331-WZ: additionally enforces comfort (18.5–40°C) and eco (5–18°C) ranges
const setpointConverterAR331WZ = {
    from: (v) => v / 10,
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

// --- AR331 (_TZE284_noixx2uz): 3 presets, no comfort/eco/off ---
const ar331 = {
    fingerprint: [{modelID: "TS0601", manufacturerName: "_TZE284_noixx2uz"}],
    model: "AR331",
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
            .withPreset(["auto", "manual", "holiday"], ea.STATE_SET)
            .withSetpoint("current_heating_setpoint", 5, 40, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withRunningState(["idle", "heat"], ea.STATE)
            .withSystemMode(["heat"], ea.STATE_SET, "Only for Homeassistant"),
        ...tuya.exposes.scheduleAllDays(ea.STATE_SET, scheduleExample),
    ],
    meta: {
        tuyaDatapoints: [
            [2, "preset", tuya.valueConverterBasic.lookup({auto: tuya.enum(0), manual: tuya.enum(1), holiday: tuya.enum(2)})],
            [3, "running_state", tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, "current_heating_setpoint", setpointConverterAR331],
            [5, "local_temperature", {from: (v) => (v > 32767 ? v - 65536 : v) / 10}],
            [6, "battery", tuya.valueConverter.raw],
            [7, "child_lock", tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            [28, "schedule_monday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(1)],
            [29, "schedule_tuesday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(2)],
            [30, "schedule_wednesday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(3)],
            [31, "schedule_thursday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(4)],
            [32, "schedule_friday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(5)],
            [33, "schedule_saturday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(6)],
            [34, "schedule_sunday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(7)],
        ],
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
        // DP 103: stored comfort target — observed mirroring DP4 whenever setpoint adjusted in comfort preset
        e.comfort_temperature().withValueMin(18.5).withValueMax(40).withValueStep(0.5),
        // DP 104: stored eco target — observed mirroring DP4 whenever setpoint adjusted in eco preset
        e.eco_temperature().withValueMin(5).withValueMax(18).withValueStep(0.5),
        // DP 107 tentative: observed mirroring DP4 while holiday preset active → stored holiday target temp
        e.numeric("holiday_temperature", ea.STATE_SET).withUnit("°C").withDescription("Holiday (away) temperature").withValueMin(5).withValueMax(15).withValueStep(0.5),
        ...tuya.exposes.scheduleAllDays(ea.STATE_SET, scheduleExample),
    ],
    meta: {
        tuyaDatapoints: [
            [
                2,
                "preset",
                tuya.valueConverterBasic.lookup({
                    auto: tuya.enum(0),
                    manual: tuya.enum(1),
                    holiday: tuya.enum(2),
                    comfort: tuya.enum(3),
                    eco: tuya.enum(4),
                    off: tuya.enum(5),
                }),
            ],
            [3, "running_state", tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, "current_heating_setpoint", setpointConverterAR331WZ],
            [5, "local_temperature", {from: (v) => (v > 32767 ? v - 65536 : v) / 10}],
            [6, "battery", tuya.valueConverter.raw],
            [7, "child_lock", tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            [103, "comfort_temperature", tuya.valueConverter.divideBy10],
            [104, "eco_temperature", tuya.valueConverter.divideBy10],
            [107, "holiday_temperature", tuya.valueConverter.divideBy10],
            [28, "schedule_monday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(1)],
            [29, "schedule_tuesday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(2)],
            [30, "schedule_wednesday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(3)],
            [31, "schedule_thursday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(4)],
            [32, "schedule_friday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(5)],
            [33, "schedule_saturday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(6)],
            [34, "schedule_sunday", tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(7)],
        ],
    },
};

module.exports = [ar331, ar331wz];
