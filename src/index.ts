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
    SourceFile,
    textChanges
} from 'typescript';
import { MixinHost, mixinHost, ParseConfigHostImpl } from './hosts';
import { assertDef, returnTrue } from './utils';
import { visit } from './visitor';

function fixWorker(
    host: MixinHost,
    createProgramCallback: (oldProgram?: Program) => Program,
    formatCodeSettings: FormatCodeSettings,
    sourceFileFilter: (sourceFile: SourceFile) => void = returnTrue
) {
    const formatContext = formatting.getFormatContext(formatCodeSettings);

    const program = createProgramCallback();
    program
        .getSourceFiles()
        .filter(sourceFileFilter)
        .forEach(sourceFile => {
            let text = sourceFile.getFullText();
            const changes = textChanges.ChangeTracker.with(
                {
                    formatContext,
                    host,
                    preferences: {}
                },
                changeTracker => {
                    visit(sourceFile, program, host, changeTracker);
                }
            );

            changes.forEach(change => {
                text = textChanges.applyChanges(text, change.textChanges);
            });

            host.writeFile(sourceFile.path, text);
        });
}

export function fixFromProject(
    projectPath: string,
    createHighLevelUpgradeHost?: (options: CompilerOptions) => CompilerHost,
    formatCodeSettings = getDefaultFormatCodeSettings(),
    sourceFileFilter?: (sourceFile: SourceFile) => void
) {
    const defaultCompilerOptions = getDefaultCompilerOptions();
    const createCompilerHostImpl =
        createHighLevelUpgradeHost ??
        /* istanbul ignore next */ createCompilerHost;
    const upgradeHost = createCompilerHostImpl(defaultCompilerOptions);

    const filename = assertDef(
        findConfigFile(projectPath, file => upgradeHost.fileExists(file))
    );
    const config = readJsonConfigFile(filename, file =>
        upgradeHost.readFile(file)
    );

    const configParseHost = new ParseConfigHostImpl(
        upgradeHost ||
            /* istanbul ignore next */ createCompilerHost(
                defaultCompilerOptions
            )
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
    fixWorker(lsHost, onCreateProgram, formatCodeSettings, sourceFileFilter);
}
