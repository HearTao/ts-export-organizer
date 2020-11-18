import {
    ExportDeclaration,
    factory,
    isExportDeclaration,
    isStringLiteral,
    Program,
    resolveModuleName,
    SourceFile,
    Symbol,
    SymbolFlags,
    textChanges
} from 'typescript';
import { cast, partition } from './utils';
import { MixinHost } from './hosts';

enum SymbolKind {
    DefinitelyType = 'DefinitelyType',
    MaybeValue = 'MaybeValue'
}

export function visit(
    sourceFile: SourceFile,
    program: Program,
    host: MixinHost,
    changeTracker: textChanges.ChangeTracker
) {
    const compilerOptions = program.getCompilerOptions();
    const checker = program.getTypeChecker();
    const declarationExportsMap = new Map<ExportDeclaration, Symbol[]>();

    sourceFile.statements.forEach(stmt => {
        if (isExportDeclaration(stmt)) {
            visitExportDeclaration(stmt);
        }
    });

    for (const [decl, exports] of declarationExportsMap.entries()) {
        const newExportDeclarations = generateExportDeclaration(decl, exports);
        changeTracker.replaceNodeWithNodes(
            sourceFile,
            decl,
            newExportDeclarations
        );
    }

    function generateExportDeclaration(
        exportDeclaration: ExportDeclaration,
        symbols: Symbol[]
    ) {
        const { DefinitelyType, MaybeValue } = partition(symbols, symbol => {
            if (
                !(symbol.flags & SymbolFlags.Value) &&
                symbol.flags & SymbolFlags.Type
            ) {
                return SymbolKind.DefinitelyType;
            }
            return SymbolKind.MaybeValue;
        });

        const result: ExportDeclaration[] = [];
        if (MaybeValue?.length) {
            result.push(
                factory.createExportDeclaration(
                    undefined,
                    undefined,
                    false,
                    factory.createNamedExports(
                        MaybeValue.map(symbol =>
                            factory.createExportSpecifier(
                                undefined,
                                symbol.name
                            )
                        )
                    ),
                    exportDeclaration.moduleSpecifier
                )
            );
        }
        if (DefinitelyType?.length) {
            result.push(
                factory.createExportDeclaration(
                    undefined,
                    undefined,
                    true,
                    factory.createNamedExports(
                        DefinitelyType.map(symbol =>
                            factory.createExportSpecifier(
                                undefined,
                                symbol.name
                            )
                        )
                    ),
                    exportDeclaration.moduleSpecifier
                )
            );
        }

        return result;
    }

    function visitExportDeclaration(declaration: ExportDeclaration) {
        if (declaration.exportClause || !declaration.moduleSpecifier) {
            // ignore if export * as ns from 'xx' or grammar error
            return;
        }

        const specifier = cast(declaration.moduleSpecifier, isStringLiteral);
        const result = resolveModuleName(
            specifier.text,
            sourceFile.fileName,
            compilerOptions,
            host
        );
        if (
            !result.resolvedModule ||
            result.resolvedModule.isExternalLibraryImport
        ) {
            // ignore missing modules and external libs
            return;
        }

        const resolvedFileName = result.resolvedModule.resolvedFileName;
        const targetFile = program.getSourceFile(resolvedFileName);
        if (!targetFile) {
            // ignore if cannot find file
            return;
        }

        const sourceFileSymbol = checker.getSymbolAtLocation(targetFile);
        if (!sourceFileSymbol) {
            // ignore if cannot find symbol
            return;
        }

        const moduleExports = checker.getExportsOfModule(sourceFileSymbol);
        declarationExportsMap.set(declaration, moduleExports);
    }
}
