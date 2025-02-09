import glob from 'fast-glob'
import { getContainingFile } from '@vuedx/vue-virtual-textdocument'
import ts from 'typescript/lib/tsserverlibrary' // TODO: Load from current directory.
import { TypeScriptServerHost } from './TypeScriptServerHost'

export type Diagnostics = Array<{
  fileName: string
  diagnostics: ts.server.protocol.Diagnostic[]
}>

class AbortSignal {
  private _aborted = false
  private _onabort?: () => void | Promise<void>

  public get aborted(): boolean {
    return this._aborted
  }

  // eslint-disable-next-line accessor-pairs
  public set onabort(fn: () => void | Promise<void>) {
    this._onabort = fn
  }

  private async dispatchEvent(event: 'aborted'): Promise<void> {
    this._aborted = true
    return await this._onabort?.()
  }
}
export class AbortController {
  public readonly signal = new AbortSignal()

  public async abort(): Promise<void> {
    // @ts-expect-error
    return await this.signal.dispatchEvent('aborted')
  }
}

export async function* getDiagnostics(
  directory: string,
  cancellationToken: AbortSignal,
  logging: boolean = false,
): AsyncGenerator<Diagnostics, Diagnostics> {
  const host = new TypeScriptServerHost()
  cancellationToken.onabort = async () => {
    await host.close()
  }

  const diagnosticsPerFile = new Map<
    string,
    {
      semantic?: ts.server.protocol.Diagnostic[]
      syntax?: ts.server.protocol.Diagnostic[]
      suggestion?: ts.server.protocol.Diagnostic[]
    }
  >()

  function setDiagnostics(
    file: string,
    kind: 'semantic' | 'syntax' | 'suggestion',
    diagnostics: ts.server.protocol.Diagnostic[],
  ): void {
    if (file.includes('/node_modules/')) return
    if (diagnostics.length > 0) {
      const fileName = getContainingFile(file)
      const current = diagnosticsPerFile.get(fileName) ?? {}
      diagnosticsPerFile.set(fileName, {
        ...current,
        [kind]: diagnostics,
      })
    }
  }
  const pack = (): Diagnostics =>
    Array.from(diagnosticsPerFile.entries())
      .map(([fileName, diagnostics]) => ({
        fileName,
        diagnostics: merge(
          diagnostics.semantic,
          diagnostics.suggestion,
          diagnostics.syntax,
        ),
      }))
      .filter((item) => item.diagnostics.length > 0)

  const refresh = async (files: string[]): Promise<Diagnostics> => {
    diagnosticsPerFile.clear()
    const start = Date.now()
    if (logging) console.log(`Checking...`)
    const id = await host.sendCommand('geterrForProject', {
      file: files[0],
      delay: 0,
    })

    return await new Promise((resolve) => {
      const off = host.on('requestCompleted', async (event) => {
        if (event.request_seq === id) {
          if (logging) {
            console.log(
              `Completed in ${((Date.now() - start) / 1000).toFixed(2)}s`,
            )
          }
          resolve(pack())
          off()
        }
      })
    })
  }

  const files = await glob(
    ['**/*.vue', '**/*.ts', '**/*.js', '**/*.jsx', '**/*.tsx'],
    {
      cwd: directory,
      absolute: true,
      ignore: ['node_modules', 'node_modules/**/*', '**/node_modules'],
    },
  )
  await host.sendCommand('configure', {
    hostInfo: '@vuedx/typecheck',
    preferences: { disableSuggestions: false },
  })
  await host.sendCommand('compilerOptionsForInferredProjects', {
    options: {
      allowJs: true,
      checkJs: true,
      strict: true,
      alwaysStrict: true,
      allowNonTsExtensions: true,
      jsx: 'preserve' as any,
    },
  })
  if (files.length === 0) {
    throw new Error('No ts/js/vue files found in current directory.')
  }

  const checkFile = files.find((file) => /\.(ts|js)x?/.test(file)) ?? files[0]
  await host.sendCommand('updateOpen', {
    openFiles: [{ file: checkFile, projectRootPath: directory }],
  })

  const { body: project } = await host.sendCommand('projectInfo', {
    file: checkFile,
    needFileNameList: false,
  })

  if (project?.configFileName?.endsWith('inferredProject1*') === true) {
    // Inferred project open all files.
    await host.sendCommand('updateOpen', {
      openFiles: files.map((file) => ({ file, projectRootPath: directory })),
    })
  }

  let done: (result: Diagnostics) => void
  let promise = new Promise<Diagnostics>((resolve) => {
    done = resolve
    void refresh(files).then(done)
  })

  const next = (): void => {
    promise = new Promise((resolve) => {
      done = resolve
    })
  }

  host.on('projectsUpdatedInBackground', async (event) => {
    done(await refresh(files))
  })

  host.on('semanticDiag', (event) => {
    setDiagnostics(event.file, 'semantic', event.diagnostics)
  })

  host.on('syntaxDiag', (event) => {
    setDiagnostics(event.file, 'syntax', event.diagnostics)
  })

  host.on('suggestionDiag', (event) => {
    setDiagnostics(event.file, 'suggestion', event.diagnostics)
  })

  while (!cancellationToken.aborted) {
    yield await promise
    next()
  }

  return pack()
}

export async function getDiagnostics2(directory: string): Promise<Diagnostics> {
  const controller = new AbortController()
  const stream = getDiagnostics(directory, controller.signal)
  const result = await stream.next()
  await controller.abort()

  return result.value
}

function merge<T>(...items: Array<T[] | undefined>): T[] {
  return items.flatMap((item) => item ?? [])
}
