import {
    CompilerHost,
    CompilerOptions,
    createCompilerHost,
    createProgram,
    findConfigFile,
    FormatCodeSettings,
    formatDiagnosticsWithColorAndContext,
    formatting,
    getDefaultCompilerOptions,
    getDefaultFormatCodeSettings,
    parseJsonSourceFileConfigFileContent,
    Program,
    readJsonConfigFile,
    textChanges
} from 'typescript';
import { ProxyChangesTracker } from './changes';
import { MixinHost, mixinHost, ParseConfigHostImpl } from './hosts';
import { assertDef } from './utils';
import { visit } from './visitor';

function fixWorker(
    host: MixinHost,
    createProgramCallback: (oldProgram?: Program) => Program,
    formatCodeSettings: FormatCodeSettings
) {
    const formatContext = formatting.getFormatContext(formatCodeSettings);

    let lastProgram: Program | undefined = undefined;
    let needAnotherPass = true;
    while (needAnotherPass) {
        needAnotherPass = false;
        const program = (lastProgram = createProgramCallback(lastProgram));

        program.getSourceFiles().forEach(sourceFile => {
            let text = sourceFile.getFullText();
            const changes = textChanges.ChangeTracker.with(
                {
                    formatContext,
                    host,
                    preferences: {}
                },
                changeTracker => {
                    const proxyChangeTracker = new ProxyChangesTracker(
                        changeTracker
                    );
                    visit(sourceFile, program, host, proxyChangeTracker);
                    needAnotherPass =
                        needAnotherPass || proxyChangeTracker.needAnotherPass();
                }
            );

            changes.forEach(change => {
                text = textChanges.applyChanges(text, change.textChanges);
            });

            host.writeFile(sourceFile.path, text);
        });
    }
}

export function fixFromProject(
    projectPath: string,
    createHighLevelUpgradeHost?: (options: CompilerOptions) => CompilerHost,
    compilerOptions = getDefaultCompilerOptions(),
    formatCodeSettings = getDefaultFormatCodeSettings()
) {
    const createCompilerHostImpl =
        createHighLevelUpgradeHost ??
        /* istanbul ignore next */ createCompilerHost;
    const upgradeHost = createCompilerHostImpl(compilerOptions);

    const filename = assertDef(
        findConfigFile(projectPath, file => upgradeHost.fileExists(file))
    );
    const config = readJsonConfigFile(filename, file =>
        upgradeHost.readFile(file)
    );

    const configParseHost = new ParseConfigHostImpl(
        upgradeHost ||
            /* istanbul ignore next */ createCompilerHost(compilerOptions)
    );
    const configParsedResult = parseJsonSourceFileConfigFileContent(
        config,
        configParseHost,
        projectPath
    );
    /* istanbul ignore if */
    if (configParsedResult.errors.length > 0) {
        throw new Error(
            formatDiagnosticsWithColorAndContext(configParsedResult.errors, {
                getCurrentDirectory: upgradeHost.getCurrentDirectory,
                getNewLine: upgradeHost.getNewLine,
                getCanonicalFileName: name => name
            })
        );
    }
    const host = createCompilerHostImpl(configParsedResult.options);
    const lsHost = mixinHost(host);

    const onCreateProgram = (oldProgram?: Program) => {
        return createProgram(
            configParsedResult.fileNames,
            configParsedResult.options,
            host,
            oldProgram
        );
    };
    fixWorker(lsHost, onCreateProgram, formatCodeSettings);
}
