/**
 * Zigbee2MQTT external converter for the Myuet AR331-WZ Thermostatic Radiator Valve.
 * OEM manufacturer: Shenzhen Myuet Energy Saving Equipment Co., Ltd.
 * Also sold as: Matosio AR331-WZ
 *
 * NOTE: This device is now part of zigbee-herdsman-converters (model AR331-WZ).
 * This external converter overrides it only if a newer library version is needed locally.
 *
 * Datapoints:
 *   DP 2  (enum)   - preset mode: 0=auto (timer), 1=manual, 2=leave
 *   DP 3  (enum)   - running state: 0=idle (no action needed), 1=heat (valve adjusting)
 *   DP 4  (uint32) - current heating setpoint (°C × 10)
 *   DP 5  (int16)  - local temperature (°C × 10, signed; two's complement above 32767)
 *   DP 6  (uint32) - battery level (%)
 *   DP 7  (bool)   - child lock: false=LOCK, true=UNLOCK
 *   DP 28 (raw)    - schedule Monday
 *   DP 29 (raw)    - schedule Tuesday
 *   DP 30 (raw)    - schedule Wednesday
 *   DP 31 (raw)    - schedule Thursday
 *   DP 32 (raw)    - schedule Friday
 *   DP 33 (raw)    - schedule Saturday
 *   DP 34 (raw)    - schedule Sunday
 *
 * Schedule RAW byte format (DP 28–34), identical to Avatto/Moes/Tech Tuya TRVs:
 *   Byte[0]         = day number (1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun)
 *   Byte[1+i*4]     = hour   for slot i  (0–23, raw)
 *   Byte[1+i*4+1]   = minute for slot i  (0–59, raw)
 *   Byte[1+i*4+2]   = temperature high byte  ─┐ uint16 big-endian = temp × 10
 *   Byte[1+i*4+3]   = temperature low  byte  ─┘  e.g. 21.0°C → 210 → [0x00, 0xD2]
 *
 *   Payload is always fixed at 17 bytes (1 day byte + 4 slots × 4 bytes).
 *   Unused slots are zero-filled.
 *
 * Schedule string format used in Z2M (4 slots per day, separated by spaces):
 *   "HH:MM/T.T HH:MM/T.T HH:MM/T.T HH:MM/T.T"  (temperature in 0.1°C steps)
 *   Example: "06:00/16.0 08:00/20.5 17:00/21.0 22:00/16.0"
 */
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const e = require('zigbee-herdsman-converters/lib/exposes').presets;
const ea = require('zigbee-herdsman-converters/lib/exposes').access;
const exposes = require('zigbee-herdsman-converters/lib/exposes');

/**
 * Schedule converter factory – aligned with trv603ScheduleConverter in tuya.ts.
 * Always reads/writes exactly 4 slots (17-byte fixed payload).
 * dayNum: 1=Monday … 7=Sunday
 */
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

const definition = {
    fingerprint: [
        { modelID: 'TS0601', manufacturerName: '_TZE284_noixx2uz' },
        { modelID: 'TS0601', manufacturerName: '_TZE284_nbv4tdaz' },
    ],
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
            .withSystemMode(['heat'], ea.STATE)
            .withRunningState(['idle', 'heat'], ea.STATE),
        exposes.presets.text('schedule_monday',    ea.STATE_SET).withDescription(`Monday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_tuesday',   ea.STATE_SET).withDescription(`Tuesday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_wednesday', ea.STATE_SET).withDescription(`Wednesday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_thursday',  ea.STATE_SET).withDescription(`Thursday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_friday',    ea.STATE_SET).withDescription(`Friday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_saturday',  ea.STATE_SET).withDescription(`Saturday schedule. ${scheduleDescription}`),
        exposes.presets.text('schedule_sunday',    ea.STATE_SET).withDescription(`Sunday schedule. ${scheduleDescription}`),
    ],
    meta: {
        tuyaDatapoints: [
            [2, 'preset',                   tuya.valueConverterBasic.lookup({auto: tuya.enum(0), manual: tuya.enum(1), leave: tuya.enum(2), comfort: tuya.enum(3), eco: tuya.enum(4), off: tuya.enum(5)})],
            // NOTE: 'provisional mode' (manual setpoint override in auto) also reports DP2=2, indistinguishable from leave
            [3, 'running_state',            tuya.valueConverterBasic.lookup({idle: tuya.enum(0), heat: tuya.enum(1)})],
            [4, 'current_heating_setpoint', {
                from: (v) => v / 10,
                to: (v, meta) => {
                    const preset = meta && meta.state && meta.state.preset;
                    let val = v;
                    if (val < 5)    val = 5;
                    if (val > 40)   val = 40;
                    if (preset === 'leave'   && val > 15)   val = 15;
                    if (preset === 'eco'     && val > 18)   val = 18;
                    if (preset === 'comfort' && val < 18.5) val = 18.5;
                    return Math.round(val * 10);
                },
            }],
            [5, 'local_temperature',        {
                from: (v) => (v > 32767 ? v - 65536 : v) / 10,
            }],
            [6, 'battery',                  tuya.valueConverter.raw],
            [7, 'child_lock',               tuya.valueConverterBasic.lookup({LOCK: false, UNLOCK: true})],
            [28, 'schedule_monday',    makeScheduleConverter(1)],
            [29, 'schedule_tuesday',   makeScheduleConverter(2)],
            [30, 'schedule_wednesday', makeScheduleConverter(3)],
            [31, 'schedule_thursday',  makeScheduleConverter(4)],
            [32, 'schedule_friday',    makeScheduleConverter(5)],
            [33, 'schedule_saturday',  makeScheduleConverter(6)],
            [34, 'schedule_sunday',    makeScheduleConverter(7)],
        ],
    },
};

module.exports = definition;
