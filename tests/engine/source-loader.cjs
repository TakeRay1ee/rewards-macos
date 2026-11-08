const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
function loadSource(file, mocks = {}, globals = {}) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const module = { exports: {} }
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText
    vm.runInNewContext(
        compiled,
        {
            module,
            exports: module.exports,
            require(name) {
                if (Object.hasOwn(mocks, name)) return mocks[name]
                if (name.startsWith('node:') || name === 'crypto') return require(name)
                throw new Error(`Unmocked dependency ${name} from ${file}`)
            },
            console,
            process,
            Date,
            Error,
            Promise,
            URL,
            URLSearchParams,
            Uint8Array,
            ArrayBuffer,
            AbortController,
            Buffer,
            setTimeout,
            clearTimeout,
            ...globals
        },
        { filename: file }
    )
    return module.exports
}
module.exports = { loadSource, root }
