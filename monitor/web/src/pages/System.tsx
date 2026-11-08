import { Card, fmtGb, fmtMb, fmtTime } from '../components'
import type { Snapshot } from '../types'

export function System({ snap, embedded = false }: { snap: Snapshot; embedded?: boolean }) {
    const s = snap.system
    const sched = snap.scheduler

    return (
        <>
            {!embedded ? (
                <div className="page-head">
                    <div>
                        <h2>系统状态</h2>
                        <p>仅用于观察与诊断 · 控制动作与自动恢复均记录执行结果 · 采样时间 {fmtTime(s?.at)}</p>
                    </div>
                </div>
            ) : null}

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
                <Card title="Control API">
                    <dl className="kv">
                        <dt>状态</dt>
                        <dd style={{ color: snap.controlApi.online ? 'var(--ok)' : 'var(--danger)' }}>
                            {snap.controlApi.online ? '在线' : '离线'}
                        </dd>
                        <dt>地址</dt>
                        <dd className="mono">{snap.controlApi.base}</dd>
                        <dt>鉴权</dt>
                        <dd>{snap.controlApi.tokenConfigured ? 'Bearer token 已启用' : '未启用'}</dd>
                        <dt>批次状态</dt>
                        <dd>{snap.run.state}</dd>
                        <dt>归属歧义</dt>
                        <dd>
                            {snap.run.ambiguousAttributions == null
                                ? '—'
                                : snap.run.ambiguousAttributions > 0
                                  ? `${snap.run.ambiguousAttributions} 条（同前缀账号，无法可靠归属）`
                                  : '0 条'}
                        </dd>
                        <dt>进程 PID</dt>
                        <dd className="mono">{snap.run.pid ?? '—'}</dd>
                    </dl>
                </Card>

                <Card title="资源">
                    <dl className="kv">
                        <dt>CPU 负载</dt>
                        <dd>
                            {s ? `${s.cpu.loadAvg.join(' / ')}（${s.cpu.cores} 核）` : '—'}
                            {s?.cpu.usagePercent != null ? ` · 使用率 ${s.cpu.usagePercent}%` : ''}
                        </dd>
                        <dt>可用内存</dt>
                        <dd>
                            {s ? fmtGb(s.memory.availableBytes) : '—'} / {s ? fmtGb(s.memory.totalBytes) : '—'}
                        </dd>
                        <dt>内存口径</dt>
                        <dd className="secondary" style={{ fontSize: 11.5 }}>
                            {s?.memory.formula ?? '—'}（{s?.memory.source ?? '未知来源'}）
                        </dd>
                        <dt>Chromium</dt>
                        <dd>
                            {s
                                ? `${s.processes.browserInstances} 个实例 / ${s.processes.browserProcessCount} 个进程`
                                : '—'}
                            {s ? ` · ${fmtMb((s.processes.browserRssMb ?? 0) * 1048576)}` : ''}
                        </dd>
                        <dt>Node worker</dt>
                        <dd>
                            {s ? `${s.processes.workers.length} 个` : '—'}
                            {s ? ` · ${fmtMb((s.processes.workerRssMb ?? 0) * 1048576)}` : ''}
                        </dd>
                        <dt>系统运行</dt>
                        <dd>{s ? `${Math.floor(s.host.uptimeSec / 3600)} 小时` : '—'}</dd>
                    </dl>
                </Card>

                <Card title="进程明细">
                    {!s || s.processes.workers.length === 0 ? (
                        <div className="muted">当前没有自动化工作进程</div>
                    ) : (
                        <table>
                            <thead>
                                <tr>
                                    <th>PID</th>
                                    <th className="num">RSS</th>
                                    <th className="num">CPU</th>
                                    <th>运行时长</th>
                                </tr>
                            </thead>
                            <tbody>
                                {s.processes.workers.map(w => (
                                    <tr key={w.pid}>
                                        <td className="mono">{w.pid}</td>
                                        <td className="num">{w.rssMb} MB</td>
                                        <td className="num">{w.cpuPercent.toFixed(1)}%</td>
                                        <td className="mono">{w.etime}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Card>

                <Card title="并发计划与资源参考">
                    <dl className="kv">
                        <dt>账号数 N</dt>
                        <dd>{sched.lastRun?.plan?.accounts ?? '—'}</dd>
                        <dt>单账号占用</dt>
                        <dd>{sched.calibration ? `${sched.calibration.footprintMb} MB（实测）` : '尚无实测'}</dd>
                        <dt>可用内存</dt>
                        <dd>{sched.lastRun?.plan ? fmtMb(sched.lastRun.plan.memory.availableMb * 1048576) : '—'}</dd>
                        <dt>预留</dt>
                        <dd>{sched.lastRun?.plan ? fmtMb(sched.lastRun.plan.reserveMb * 1048576) : '—'}</dd>
                        <dt>内存可容纳</dt>
                        <dd>{sched.lastRun?.plan?.byMemory ?? '—'} 个</dd>
                        <dt>本轮 clusters</dt>
                        <dd>
                            <b>{sched.lastRun?.plan?.clusters ?? '—'}</b>
                            {sched.lastRun?.plan
                                ? `（依据 ${sched.lastRun.plan.limitedBy === 'memory' ? '内存估算' : ['forced', 'concurrency'].includes(sched.lastRun.plan.limitedBy) ? '指定并发上限' : '账号数'}）`
                                : ''}
                        </dd>
                    </dl>
                </Card>
            </div>

            <div style={{ marginTop: 14 }}>
                <Card title="最近定时/手动调度记录">
                    {sched.logTail.length === 0 ? (
                        <div className="empty">尚无调度记录</div>
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>时间</th>
                                        <th>触发方式</th>
                                        <th>结果</th>
                                        <th>详情</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...sched.logTail].reverse().map((r, i) => (
                                        <tr key={`${r.at}-${i}`}>
                                            <td className="mono">{fmtTime(r.at)}</td>
                                            <td>{r.reason === 'daily' ? 'launchd 每日' : r.reason}</td>
                                            <td>
                                                {r.result === 'started' || r.result === 'deduplicated' ? (
                                                    <span style={{ color: 'var(--ok)' }}>
                                                        {r.result === 'deduplicated' ? '已去重' : '已启动'}
                                                    </span>
                                                ) : r.result === 'skipped' ? (
                                                    <span style={{ color: 'var(--warn)' }}>跳过</span>
                                                ) : (
                                                    <span style={{ color: 'var(--danger)' }}>失败</span>
                                                )}
                                            </td>
                                            <td className="secondary">
                                                {r.detail ?? (r.plan ? `clusters=${r.plan.clusters}` : '—')}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>
        </>
    )
}
