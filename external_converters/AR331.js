/**
 * Zigbee2MQTT external converters for Myuet/Matosio AR331-series TRVs.
 *
 * AR331      (_TZE284_noixx2uz): 3 presets – auto / manual / leave
 * AR331-WZ   (_TZE284_nbv4tdaz): 6 presets – auto / manual / leave / comfort / eco / off
 *
 * Datapoints (both models):
 *   DP 2  (enum)   - preset mode
 *   DP 3  (enum)   - running state: 0=idle, 1=heat
 *   DP 4  (uint32) - current heating setpoint (°C × 10)
 *   DP 5  (int16)  - local temperature (°C × 10, signed; two's complement above 32767)
 *   DP 6  (uint32) - battery level (%)
 *   DP 7  (bool)   - child lock: false=LOCK, true=UNLOCK
 *   DP 28–34 (raw) - schedule Mon–Sun
 *
 * AR331-WZ additional preset values:
 *   comfort (3): setpoint range 18.5–40°C
 *   eco     (4): setpoint range 5–18°C
 *   off     (5): all symbols dark on display
 *   NOTE: 'provisional mode' (manual override in auto) also reports DP2=2,
 *         indistinguishable from leave.
 *
 * Schedule RAW byte format (DP 28–34):
 *   Byte[0]       = day number (1=Mon … 7=Sun)
 *   Byte[1+i*4]   = hour   slot i  (0–23)
 *   Byte[2+i*4]   = minute slot i  (0–59)
 *   Byte[3+i*4]   = temp high byte ─┐ uint16 BE = temp × 10
 *   Byte[4+i*4]   = temp low  byte ─┘
 *   Always 17 bytes fixed (1 + 4 slots × 4 bytes).
 */
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const e = require('zigbee-herdsman-converters/lib/exposes').presets;
const ea = require('zigbee-herdsman-converters/lib/exposes').access;
const exposes = require('zigbee-herdsman-converters/lib/exposes');

/** Schedule converter – shared by both models, aligned with ar331ScheduleConverter in tuya.ts. */
function makeScheduleConverter(dayNum) {
    return {
        from: (v) => {
            if (!v || v.length < 17) return;
            const slots = [];
            for (let i = 1; i <= 13; i += 4) {
                const hh   = v[i];
                const mm   = v[i + 1];
                const temp = ((v[i + 2] << 8) | v[i + 3]) / 10;
                if (hh > 23 || mm > 59) return;
                slots.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}/${temp.toFixed(1)}`);
            }
            return slots.join(' ');
        },
        to: (v) => {
            const parts = v.trim().split(/\s+/).filter(Boolean);
            const payload = new Array(17).fill(0);
            payload[0] = dayNum;
            parts.forEach((part, idx) => {
                if (idx < 4) {
                    const [time, temp] = part.split('/');
                    const [hh, mm] = time.split(':');
                    const t = Math.round(parseFloat(temp) * 10);
                    payload[1 + idx * 4]     = parseInt(hh, 10);
                    payload[1 + idx * 4 + 1] = parseInt(mm, 10);
                    payload[1 + idx * 4 + 2] = (t >> 8) & 0xFF;
                    payload[1 + idx * 4 + 3] = t & 0xFF;
                }
            });
            return payload;
        },
    };
}

const scheduleDescription =
    'Format: "HH:MM/T.T HH:MM/T.T HH:MM/T.T HH:MM/T.T" (4 slots, temperature in 0.1\u00b0C steps). ' +
    'Example: "06:00/16.0 08:00/20.5 17:00/21.0 22:00/16.0"';

const scheduleExposes = [
    exposes.presets.text('schedule_monday',    ea.STATE_SET).withDescription(`Monday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_tuesday',   ea.STATE_SET).withDescription(`Tuesday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_wednesday', ea.STATE_SET).withDescription(`Wednesday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_thursday',  ea.STATE_SET).withDescription(`Thursday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_friday',    ea.STATE_SET).withDescription(`Friday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_saturday',  ea.STATE_SET).withDescription(`Saturday schedule. ${scheduleDescription}`),
    exposes.presets.text('schedule_sunday',    ea.STATE_SET).withDescription(`Sunday schedule. ${scheduleDescription}`),
];

const scheduleDatapoints = [
    [28, 'schedule_monday',    makeScheduleConverter(1)],
    [29, 'schedule_tuesday',   makeScheduleConverter(2)],
    [30, 'schedule_wednesday', makeScheduleConverter(3)],
    [31, 'schedule_thursday',  makeScheduleConverter(4)],
    [32, 'schedule_friday',    makeScheduleConverter(5)],
    [33, 'schedule_saturday',  makeScheduleConverter(6)],
    [34, 'schedule_sunday',    makeScheduleConverter(7)],
];

// --- AR331 (_TZE284_noixx2uz): 3 presets, no comfort/eco/off ---
const ar331 = {
    fingerprint: [{ modelID: 'TS0601', manufacturerName: '_TZE284_noixx2uz' }],
    model: 'AR331',
    vendor: 'Tuya',
    description: 'Thermostatic Radiator Valve',
    fromZigbee: [tuya.fz.datapoints],
    toZigbee: [tuya.tz.datapoints],
    onEvent: tuya.onEventSetTime,
    exposes: [
        e.battery().withUnit('%'),
        e.child_lock(),
        e.climate()
            .withPreset(['auto', 'manual', 'leave'], ea.STATE_SET)
            .withSetpoint('current_heating_setpoint', 5, 40, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withRunningState(['idle', 'heat'], ea.STATE),
        ...scheduleExposes,
    ],
    meta: {
        tuyaDatapoints: [
            [2, 'preset',                   tuya.valueConverterBasic.lookup({auto: tuya.enum(0), manual: tuya.enum(1), leave: tuya.enum(2)})],
            [3, 'running_state',            tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, 'current_heating_setpoint', {
                from: (v) => v / 10,
                to: (v, meta) => {
                    const preset = meta && meta.state && meta.state.preset;
                    let val = v;
                    if (val < 5)  val = 5;
                    if (val > 40) val = 40;
                    if (preset === 'leave' && val > 15) val = 15;
                    return Math.round(val * 10);
                },
            }],
            [5, 'local_temperature', { from: (v) => (v > 32767 ? v - 65536 : v) / 10 }],
            [6, 'battery',           tuya.valueConverter.raw],
            [7, 'child_lock',        tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            ...scheduleDatapoints,
        ],
    },
};

// --- AR331-WZ (_TZE284_nbv4tdaz): 6 presets, comfort/eco/off ---
const ar331wz = {
    fingerprint: [{ modelID: 'TS0601', manufacturerName: '_TZE284_nbv4tdaz' }],
    model: 'AR331-WZ',
    vendor: 'Tuya',
    description: 'Thermostatic Radiator Valve',
    fromZigbee: [tuya.fz.datapoints],
    toZigbee: [tuya.tz.datapoints],
    onEvent: tuya.onEventSetTime,
    exposes: [
        e.battery().withUnit('%'),
        e.child_lock(),
        e.climate()
            .withPreset(['auto', 'manual', 'leave', 'comfort', 'eco', 'off'], ea.STATE_SET)
            .withSetpoint('current_heating_setpoint', 5, 40, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withRunningState(['idle', 'heat'], ea.STATE),
        ...scheduleExposes,
    ],
    meta: {
        tuyaDatapoints: [
            // NOTE: 'provisional mode' (manual override in auto) also reports DP2=2, indistinguishable from leave
            [2, 'preset',                   tuya.valueConverterBasic.lookup({auto: tuya.enum(0), manual: tuya.enum(1), leave: tuya.enum(2), comfort: tuya.enum(3), eco: tuya.enum(4), off: tuya.enum(5)})],
            [3, 'running_state',            tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, 'current_heating_setpoint', {
                from: (v) => v / 10,
                to: (v, meta) => {
                    const preset = meta && meta.state && meta.state.preset;
                    let val = v;
                    if (val < 5)  val = 5;
                    if (val > 40) val = 40;
                    if (preset === 'leave'   && val > 15)   val = 15;
                    if (preset === 'eco'     && val > 18)   val = 18;
                    if (preset === 'comfort' && val < 18.5) val = 18.5;
                    return Math.round(val * 10);
                },
            }],
            [5, 'local_temperature', { from: (v) => (v > 32767 ? v - 65536 : v) / 10 }],
            [6, 'battery',           tuya.valueConverter.raw],
            [7, 'child_lock',        tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            ...scheduleDatapoints,
        ],
    },
};

module.exports = [ar331, ar331wz];
