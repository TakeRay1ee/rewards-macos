import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

import { parseLogLine, createRunState, applyLogToRunState, summarizeRunState, severityRank } from './logParser.js'
import { RunIdentityStore, processIdentity, identityStatus } from './runIdentity.js'

const IS_WIN = process.platform === 'win32'

const BLOCKED_ENV = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'ELECTRON_RUN_AS_NODE'
])
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENV_KEYS = new Set(['__PROTO__', 'PROTOTYPE', 'CONSTRUCTOR'])

export class ProcessManager extends EventEmitter {
    constructor({
        command,
        args = [],
        cwd,
        stopTimeoutMs = 15000,
        logBufferSize = 2000,
        historySize = 20,
        name = 'microsoft-rewards-script',
        version = '0.0.0',
        stateFile = null
    }) {
        super()
        this.setMaxListeners(0)

        this.command = command
        this.defaultArgs = args
        this.cwd = cwd
        this.stopTimeoutMs = stopTimeoutMs
        this.logBufferSize = logBufferSize
        this.historySize = historySize
        this.name = name
        this.version = version

        this.state = 'idle' // idle | starting | running | stopping
        this.child = null
        this.pid = null
        this.startedAt = null
        this.lastExit = null
        this.currentArgs = args

        this.runState = createRunState()
        this.logBuffer = []
        this.logSeq = 0
        this.history = []

        this._stdoutBuf = ''
        this._stderrBuf = ''
        this._killTimer = null
        this._finalized = false
        this.runId = null
        this.requestId = null
        this.selectedAccounts = null
        this.lastRun = null
        this._processIdentity = null
        this._ownerIdentity = null
        this._recovered = false
        this._recoveryTimer = null
        this._recoveryStopSignal = null
        this.appliedLogId = 0
        // Only the actual API opts into persistence. Importing or constructing a
        // standalone manager never creates runtime files by default.
        this.runtime = stateFile ? new RunIdentityStore(stateFile, { logBufferSize, historySize }) : null
        if (this.runtime) {
            this.history = this.runtime.history()
            this.lastRun = this.history[0] ?? null
            if (this.lastRun) {
                this.runId = this.lastRun.runId
                this.selectedAccounts = this.lastRun.selectedAccounts ?? null
                this.startedAt = this.lastRun.startedAt
                this.lastExit = this.lastRun.exit
                this.runState = this.lastRun.runState ?? this.runState
            }
            this.logsFromDisk()
            this._recoverActive()
        }
    }

    logsFromDisk() {
        this.logBuffer = this.runtime.logs()
        this.logSeq = this.logBuffer.at(-1)?.id ?? 0
    }

    _snapshot() {
        return {
            runId: this.runId,
            requestId: this.requestId,
            startedAt: this.startedAt,
            selectedAccounts: this.selectedAccounts,
            pid: this.pid,
            processIdentity: this._processIdentity,
            ownerIdentity: this._ownerIdentity,
            state: this.state,
            runState: this.runState,
            appliedLogId: this.appliedLogId,
            summary: summarizeRunState(this.runState)
        }
    }

    _saveActive() {
        if (this.runtime && this.runId && this.state !== 'idle') this.runtime.save(this._snapshot())
    }

    _recoverActive() {
        if (!this.runtime || this.child || (this.state !== 'idle' && !this._recovered)) return
        const active = this.runtime.readActive()
        if (!active) return
        if (this._recovered && active.runId === this.runId) return
        if (this._recoveryTimer) clearInterval(this._recoveryTimer)
        this._recoveryTimer = null
        this.runId = active.runId
        this.requestId = active.requestId ?? null
        this.selectedAccounts = active.selectedAccounts ?? null
        this.startedAt = active.startedAt
        this.pid = active.pid ?? null
        this._processIdentity = active.processIdentity ?? null
        this._ownerIdentity = active.ownerIdentity ?? null
        this.runState =
            active.runState ?? createRunState({ accountEmails: this.selectedAccounts?.map(a => a.email) ?? [] })
        this.appliedLogId = active.appliedLogId ?? 0
        for (const entry of this.runtime.logs()) {
            if (entry.runId === this.runId && entry.id > this.appliedLogId) {
                applyLogToRunState(this.runState, entry)
                this.appliedLogId = entry.id
            }
        }
        this.state = active.state === 'stopping' ? 'stopping' : active.pid ? 'running' : 'starting'
        this._recovered = true
        this._finalized = false
        this._pollRecovered()
        if (this.state !== 'idle') {
            this._recoveryTimer = setInterval(() => this._pollRecovered(), 200)
            this._recoveryTimer.unref()
        }
    }

    _pollRecovered() {
        if (!this._recovered || !this.pid) return
        const active = this.runtime.readActive()
        if (!active || active.runId !== this.runId) {
            const history = this.runtime.history()
            const finished = history.find(run => run.runId === this.runId)
            if (finished) {
                if (this._recoveryTimer) clearInterval(this._recoveryTimer)
                this._recoveryTimer = null
                this.history = history
                this.lastRun = finished
                this.lastExit = finished.exit
                this.runState = finished.runState ?? this.runState
                this.pid = null
                this.state = 'idle'
                this._finalized = true
                this._emitStatus('exit')
                this.emit('exit', { ...this.lastExit })
                return
            }
        } else if (active.appliedLogId >= this.appliedLogId && active.runState) {
            // Another API may still own the pipes. Observe its latest checkpoint
            // instead of replacing a completed run with this observer's old state.
            this.runState = active.runState
            this.appliedLogId = active.appliedLogId
        }
        this.logsFromDisk()
        const status = identityStatus(this._processIdentity)
        if (status === 'gone' || status === 'reused') {
            if (this._ownerIdentity && !['gone', 'reused'].includes(identityStatus(this._ownerIdentity))) return
            this._finalize(
                null,
                this._recoveryStopSignal,
                this._recoveryStopSignal ? null : 'Recovered process exited; original exit status is unavailable.'
            )
        }
    }

    start(overrides = {}) {
        const requestId = overrides.requestId ?? null
        if (requestId != null && (typeof requestId !== 'string' || !/^[\x21-\x7E]{1,200}$/.test(requestId))) {
            throw Object.assign(new Error('`requestId` must be 1–200 printable ASCII characters without spaces.'), {
                code: 'BAD_REQUEST'
            })
        }
        if (requestId && this.runtime) {
            const duplicate = this.runtime.request(requestId)
            if (duplicate) return { ...duplicate, duplicate: true, started: false }
        }
        this._recoverActive()
        if (this.state !== 'idle') {
            const err = new Error(`Cannot start: a run is already ${this.state}.`)
            err.code = 'ALREADY_RUNNING'
            throw err
        }

        const args = this._resolveArgs(overrides.args)
        const env = this._resolveEnv(overrides.env)

        const runId = randomUUID()
        const startedAt = new Date().toISOString()
        const selectedAccounts = overrides.selection?.selectedAccounts ?? null
        const runState = createRunState({ accountEmails: selectedAccounts?.map(a => a.email) ?? [] })
        const ownerIdentity = this.runtime ? processIdentity(process.pid) : null
        const duplicate = this.runtime?.reserve({
            runId,
            requestId,
            startedAt,
            selectedAccounts,
            state: 'starting',
            pid: null,
            processIdentity: null,
            ownerIdentity,
            runState,
            summary: summarizeRunState(runState)
        })
        if (duplicate) return { ...duplicate, duplicate: true, started: false }

        this.state = 'starting'
        this.runId = runId
        this.requestId = requestId
        this.selectedAccounts = selectedAccounts
        this.runState = runState
        this.appliedLogId = 0
        this.startedAt = startedAt
        this._ownerIdentity = ownerIdentity
        this._processIdentity = null
        this._recovered = false
        this._recoveryStopSignal = null
        this.lastExit = null
        this.currentArgs = args
        this._stdoutBuf = ''
        this._stderrBuf = ''
        this._finalized = false

        this._controllerLog('info', `Starting run: ${this.command} ${args.join(' ')}`.trim())

        let child
        try {
            child = spawn(this.command, args, {
                cwd: this.cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: !IS_WIN, // own process group on POSIX so we can signal the whole tree
                windowsHide: true
            })
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            this._controllerLog('error', `Failed to spawn: ${msg}`)
            this._finalize(null, null, msg)
            throw error
        }

        this.child = child
        this.pid = child.pid ?? null
        this._processIdentity = this.runtime && this.pid ? processIdentity(this.pid) : null
        this._saveActive()

        child.stdout?.on('data', d => this._ingest('stdout', d))
        child.stderr?.on('data', d => this._ingest('stderr', d))

        child.once('spawn', () => {
            if (this.state === 'starting') this.state = 'running'
            this._controllerLog('info', `Run started (pid ${this.pid}).`)
            this._saveActive()
            this._emitStatus('running')
        })

        child.once('error', error => {
            const msg = error instanceof Error ? error.message : String(error)
            this._controllerLog('error', `Process error: ${msg}`)
            this._finalize(null, null, msg)
        })

        // close waits for stdout/stderr to drain; exit can precede the last data event.
        child.once('close', (code, signal) => this._finalize(code, signal))

        return {
            pid: this.pid,
            runId: this.runId,
            selectedAccounts: this.selectedAccounts,
            startedAt: this.startedAt,
            command: this.command,
            args
        }
    }

    stop({ force = false, expectedRunId = null } = {}) {
        this._recoverActive()
        if (expectedRunId != null && expectedRunId !== this.runId) {
            throw Object.assign(new Error('Cannot stop: the requested run is no longer current.'), {
                code: 'STALE_RUN'
            })
        }
        if (this.state === 'idle') {
            const err = new Error('Cannot stop: no run is in progress.')
            err.code = 'NOT_RUNNING'
            throw err
        }

        const wasStopping = this.state === 'stopping'
        if (this._recovered && (!this.pid || identityStatus(this._processIdentity) !== 'same')) {
            throw Object.assign(
                new Error('Cannot signal a recovered process whose identity is unavailable or changed.'),
                { code: 'RECOVERY_REQUIRED' }
            )
        }
        this.state = 'stopping'
        this._saveActive()
        if (!wasStopping) {
            this._controllerLog('warn', force ? 'Force-stopping run (SIGKILL)…' : 'Stopping run (SIGTERM)…')
            this._emitStatus('stopping')
            this._killTree(force ? 'SIGKILL' : 'SIGTERM')

            this._killTimer = setTimeout(() => {
                if (this.state !== 'idle') {
                    this._controllerLog('warn', `Did not exit within ${this.stopTimeoutMs}ms - sending SIGKILL.`)
                    this._killTree('SIGKILL')
                }
            }, this.stopTimeoutMs)
            if (typeof this._killTimer.unref === 'function') this._killTimer.unref()
        } else if (force) {
            this._controllerLog('warn', 'Upgrading pending stop to SIGKILL…')
            this._killTree('SIGKILL')
        }

        return new Promise(resolve => {
            let settled = false
            const done = () => {
                if (settled) return
                settled = true
                resolve(this.lastExit)
            }
            this.once('exit', done)
            const safety = setTimeout(done, this.stopTimeoutMs + 5000)
            if (typeof safety.unref === 'function') safety.unref()
        })
    }

    async restart(overrides = {}) {
        // Replayed commands must be recognized before any stop side effect,
        // even when a different, newer run is now active.
        const requestId = overrides.requestId ?? null
        if (requestId != null && (typeof requestId !== 'string' || !/^[\x21-\x7E]{1,200}$/.test(requestId))) {
            throw Object.assign(new Error('`requestId` must be 1–200 printable ASCII characters without spaces.'), {
                code: 'BAD_REQUEST'
            })
        }
        if (requestId && this.runtime) {
            const duplicate = this.runtime.request(requestId)
            if (duplicate) return { ...duplicate, duplicate: true, started: false }
        }
        this._resolveArgs(overrides.args)
        this._resolveEnv(overrides.env)
        this._recoverActive()
        if (this.state !== 'idle') {
            await this.stop({ force: Boolean(overrides.force), expectedRunId: overrides.expectedRunId ?? null })
        }
        await new Promise(r => setTimeout(r, 300))
        return this.start(overrides)
    }

    getStatus() {
        this._recoverActive()
        return {
            name: this.name,
            version: this.version,
            state: this.state,
            runId: this.runId,
            requestId: this.requestId,
            selectedAccounts: this.selectedAccounts,
            lastRun: this.lastRun,
            recovered: this._recovered,
            recoveryRequired: this._recovered && (!this.pid || !this._processIdentity),
            logStreamAvailable: !this._recovered,
            pid: this.pid,
            startedAt: this.state === 'idle' ? null : this.startedAt,
            command: `${this.command} ${this.currentArgs.join(' ')}`.trim(),
            lastExit: this.lastExit,
            logCount: this.logBuffer.length,
            logBufferSize: this.logBufferSize,
            latestLogId: this.logSeq,
            run: summarizeRunState(this.runState)
        }
    }

    getPoints() {
        this._recoverActive()
        const run = summarizeRunState(this.runState)
        const accounts = run.accounts.map(a => ({
            email: a.email,
            collected: a.collectedPoints ?? (a.live.earningsObserved ? a.live.gained : null),
            balance: a.live.balance ?? a.finalPoints ?? null,
            initialPoints: a.initialPoints,
            bySource: a.live.bySource,
            earnable: a.earnable,
            streakProtection: a.streakProtection,
            edgeBrowsing: a.edgeBrowsing,
            done: a.success != null,
            success: a.success,
            error: a.error
        }))

        return {
            runId: this.runId,
            selectedAccounts: this.selectedAccounts,
            state: this.state,
            running: this.state !== 'idle',
            live: !this._recovered && (this.state === 'running' || this.state === 'starting'),
            stale: this._recovered,
            startedAt: this.state === 'idle' ? null : this.startedAt,
            currentAccount: run.live.currentAccount,
            balance: run.live.currentBalance,
            collected: run.collected,
            updatedAt: run.live.updatedAt,
            finished: run.finished,
            totals: run.totals,
            accountsTotal: run.accountsTotal,
            accountsSeen: run.accountsSeen,
            accounts,
            lastExit: this.lastExit
        }
    }

    getLogs({ limit = 200, afterId = null, minLevel = null } = {}) {
        if (this.runtime && this._recovered) this.logsFromDisk()
        let logs = this.logBuffer
        if (afterId != null) logs = logs.filter(e => e.id > afterId)
        if (minLevel) {
            const floor = severityRank(minLevel)
            logs = logs.filter(e => severityRank(e.level) >= floor)
        }
        if (afterId == null && limit != null && logs.length > limit) {
            logs = logs.slice(logs.length - limit)
        }
        return { logs, latestLogId: this.logSeq, count: logs.length }
    }

    getErrors({ limit = 100, includeWarnings = true } = {}) {
        if (this.runtime && this._recovered) this.logsFromDisk()
        const floor = severityRank(includeWarnings ? 'warn' : 'error')
        let errors = this.logBuffer.filter(e => severityRank(e.level) >= floor)
        if (limit != null && errors.length > limit) errors = errors.slice(errors.length - limit)
        const accountErrors = this.runState.order
            .map(email => this.runState.accounts[email])
            .filter(a => a.error)
            .map(a => ({ email: a.email, error: a.error }))
        return { errors, accountErrors, count: errors.length }
    }

    getHistory() {
        if (this.runtime) this.history = this.runtime.history()
        return this.history
    }

    note(level, message) {
        this._controllerLog(level, message)
    }

    _resolveArgs(argsOverride) {
        if (argsOverride == null) return this.defaultArgs
        if (!Array.isArray(argsOverride) || !argsOverride.every(a => typeof a === 'string')) {
            const err = new Error('`args` must be an array of strings.')
            err.code = 'BAD_REQUEST'
            throw err
        }
        return argsOverride
    }

    _resolveEnv(envOverride) {
        const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
        if (envOverride != null) {
            if (typeof envOverride !== 'object' || Array.isArray(envOverride)) {
                const err = new Error('`env` must be a JSON object.')
                err.code = 'BAD_REQUEST'
                throw err
            }

            for (const [key, value] of Object.entries(envOverride)) {
                if (!ENV_KEY_RE.test(key) || RESERVED_ENV_KEYS.has(key.toUpperCase())) {
                    const err = new Error(`Invalid environment variable name: ${JSON.stringify(key)}.`)
                    err.code = 'BAD_REQUEST'
                    throw err
                }
                if (BLOCKED_ENV.has(key.toUpperCase())) continue
                if (value == null) continue
                if (!['string', 'number', 'boolean'].includes(typeof value)) {
                    const err = new Error(`Environment override ${key} must be a string, number, boolean, or null.`)
                    err.code = 'BAD_REQUEST'
                    throw err
                }
                env[key] = String(value)
            }
        }
        return env
    }

    _ingest(source, chunk) {
        const bufKey = source === 'stderr' ? '_stderrBuf' : '_stdoutBuf'
        this[bufKey] += chunk.toString('utf8')

        let idx
        while ((idx = this[bufKey].indexOf('\n')) !== -1) {
            const line = this[bufKey].slice(0, idx).replace(/\r$/, '')
            this[bufKey] = this[bufKey].slice(idx + 1)
            this._handleLine(source, line)
        }
    }

    _flushPartial() {
        for (const key of ['_stdoutBuf', '_stderrBuf']) {
            const rest = this[key]
            if (rest && rest.trim()) {
                const source = key === '_stderrBuf' ? 'stderr' : 'stdout'
                this._handleLine(source, rest.replace(/\r$/, ''))
            }
            this[key] = ''
        }
    }

    _handleLine(source, rawLine) {
        if (rawLine === '') return
        const entry = parseLogLine(rawLine, source)
        this._appendLog(entry)
        const milestone = applyLogToRunState(this.runState, entry)
        this.appliedLogId = entry.id
        this._saveActive()
        if (milestone) this._emitStatus(milestone)
    }

    _appendLog(entry) {
        entry.runId = this.runId
        entry.receivedAt = new Date().toISOString()
        entry.id = this.runtime ? this.runtime.append(entry) : this.logSeq + 1
        this.logSeq = entry.id
        this.logBuffer.push(entry)
        if (this.logBuffer.length > this.logBufferSize) this.logBuffer.shift()
        this.emit('log', entry)
    }

    _controllerLog(level, message) {
        this._appendLog({
            ts: null,
            level,
            user: 'API',
            platform: null,
            title: 'CONTROLLER',
            message,
            source: 'controller',
            parsed: false,
            raw: message
        })
    }

    _emitStatus(reason) {
        this.emit('status', { reason, ...this.getStatus() })
    }

    _killTree(signal) {
        if (this.pid == null) return
        if (this._recovered && identityStatus(this._processIdentity) !== 'same') return
        this._recoveryStopSignal = signal
        try {
            if (IS_WIN) {
                spawn('taskkill', ['/pid', String(this.pid), '/T', '/F'], { windowsHide: true })
            } else {
                try {
                    process.kill(-this.pid, signal)
                } catch {
                    this.child?.kill(signal)
                }
            }
        } catch {}
    }

    _finalize(code, signal, errorMessage = null) {
        if (this._finalized) return
        this._finalized = true
        if (this._recoveryTimer) {
            clearInterval(this._recoveryTimer)
            this._recoveryTimer = null
        }

        if (this._killTimer) {
            clearTimeout(this._killTimer)
            this._killTimer = null
        }

        this._flushPartial()

        const endedAt = new Date().toISOString()
        this.lastExit = { code: code ?? null, signal: signal ?? null, at: endedAt }
        if (errorMessage) this.lastExit.error = errorMessage

        const label =
            errorMessage != null
                ? `error: ${errorMessage}`
                : `code ${code ?? 'n/a'}${signal ? ` / signal ${signal}` : ''}`
        this._controllerLog(code === 0 && errorMessage == null ? 'info' : 'error', `Run finished (${label}).`)

        const history = {
            runId: this.runId,
            requestId: this.requestId,
            selectedAccounts: this.selectedAccounts,
            startedAt: this.startedAt,
            endedAt,
            exit: this.lastExit,
            run: summarizeRunState(this.runState),
            runState: this.runState
        }
        this.history.unshift(history)
        this.lastRun = history
        if (this.runtime && this.runId) this.runtime.finish(history)
        if (this.history.length > this.historySize) this.history.pop()

        this.child = null
        this.pid = null
        this.state = 'idle'

        this._emitStatus('exit')
        this.emit('exit', { ...this.lastExit })
    }
}

export default ProcessManager
