// Calendar dates shared by status, reports and the daily scheduler. Persisted
// timestamps stay UTC instants; the daily boundary is explicit, never process TZ.
export const REWARDS_TIME_ZONE = 'Asia/Shanghai'

function partsAt(value, timeZone) {
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) return null
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date)
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
}

export function calendarDate(value, { timeZone = REWARDS_TIME_ZONE } = {}) {
    if (value == null || value === '') return null
    const parts = partsAt(value, timeZone)
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : null
}

export function shiftCalendarDate(value, offset) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isInteger(offset)) return null
    const date = new Date(`${value}T00:00:00.000Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
    date.setUTCDate(date.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
}

export function dailyScheduledAt(now = new Date(), { hour = 0, minute = 0, timeZone = REWARDS_TIME_ZONE } = {}) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
        throw new RangeError('Daily hour/minute must be integers within 00:00–23:59')
    const day = calendarDate(now, { timeZone })
    if (!day) throw new TypeError('Invalid daily schedule date')
    const [year, month, date] = day.split('-').map(Number)
    const localTarget = Date.UTC(year, month - 1, date, hour, minute)
    let instant = localTarget
    for (let attempt = 0; attempt < 3; attempt++) {
        const parts = partsAt(new Date(instant), timeZone)
        const projected = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second)
        )
        const delta = localTarget - projected
        if (delta === 0) return new Date(instant)
        instant += delta
    }
    throw new RangeError('The requested daily time does not exist in the schedule time zone')
}
