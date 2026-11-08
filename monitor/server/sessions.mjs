// 复用引擎 Control API 的会话摘要与配置路径解析，不在监控中另猜数据库位置。
import { controlApi } from './controlClient.mjs'

export async function readSessionState(control = controlApi) {
    try {
        const payload = await control.sessions()
        if (!payload.databaseExists)
            return { available: false, reason: '实际配置的会话库尚不存在', rows: [], source: 'control-api:/sessions' }
        const byEmail = new Map()
        for (const session of payload.sessions ?? []) {
            const entry = byEmail.get(session.email) ?? { email: session.email, platforms: {} }
            entry.platforms[session.platform] = {
                bytes: null,
                updatedAt: session.updatedAt ?? null,
                hasStorageState: session.hasStorageState === true,
                hasFingerprint: session.hasFingerprint === true,
                cookieCount: session.cookieCount ?? null
            }
            byEmail.set(session.email, entry)
        }
        return { available: true, reason: null, rows: [...byEmail.values()], source: 'control-api:/sessions' }
    } catch (error) {
        return { available: false, reason: error?.message ?? String(error), rows: [], source: 'control-api:/sessions' }
    }
}
