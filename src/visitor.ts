import {
    ExportDeclaration,
    factory,
    isExportDeclaration,
    isStringLiteral,
    Program,
    resolveModuleName,
    SourceFile,
    Symbol,
    textChanges
} from 'typescript';
import { cast } from './utils';
import { MixinHost } from './hosts';

export function visit(
    sourceFile: SourceFile,
    program: Program,
    host: MixinHost,
    changeTracker: textChanges.ChangeTracker
) {
    const compilerOptions = program.getCompilerOptions();
    const checker = program.getTypeChecker();
    const declarationExportsMap = new Map<ExportDeclaration, Symbol[]>()

    sourceFile.statements.forEach(stmt => {
        if (isExportDeclaration(stmt)) {
            visitExportDeclaration(stmt);
        }
    });

    for (const [decl, exports] of declarationExportsMap.entries()) {
        const newExportDeclaration = generateExportDeclaration(decl, exports)
        changeTracker.replaceNode(
            sourceFile,
            decl,
            newExportDeclaration
        )
    }
    
    function generateExportDeclaration(exportDeclaration: ExportDeclaration, symbols: Symbol[]) {
        return factory.createExportDeclaration(
            undefined,
            undefined,
            exportDeclaration.isTypeOnly,
            factory.createNamedExports(
                symbols.map(symbol => factory.createExportSpecifier(
                    undefined,
                    symbol.name
                ))
            ),
            exportDeclaration.moduleSpecifier
        )
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
            return
        }

        const sourceFileSymbol = checker.getSymbolAtLocation(targetFile);
        if (!sourceFileSymbol) {
            // ignore if cannot find symbol
            return
        }

        const moduleExports = checker.getExportsOfModule(sourceFileSymbol);
        declarationExportsMap.set(declaration, moduleExports);
    }
}
