import {
    ExportDeclaration,
    factory,
    FindAllReferences,
    getUniqueName,
    Identifier,
    ImportDeclaration,
    ImportSpecifier,
    isExportDeclaration,
    isImportDeclaration,
    isNamespaceImport,
    isPropertyAccessExpression,
    isStringLiteral,
    Program,
    PropertyAccessExpression,
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
    const nodesToReplace: PropertyAccessExpression[] = [];
    const conflictingNames = new Map<string, true>();

    sourceFile.statements.forEach(stmt => {
        if (isExportDeclaration(stmt)) {
            visitExportDeclaration(stmt);
        } else if (isImportDeclaration(stmt)) {
            visitImportDeclaration(stmt);
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

    function visitImportDeclaration(declaration: ImportDeclaration) {
        if (
            !declaration.importClause ||
            !declaration.importClause.namedBindings ||
            !isNamespaceImport(declaration.importClause.namedBindings)
        ) {
            // ignore if import is not import * as ns from 'xx'
            return;
        }

        const toConvert = declaration.importClause.namedBindings;
        let usedAsNamespaceOrDefault = false;

        FindAllReferences.Core.eachSymbolReferenceInFile(
            toConvert.name,
            checker,
            sourceFile,
            id => {
                if (!isPropertyAccessExpression(id.parent)) {
                    usedAsNamespaceOrDefault = true;
                } else {
                    const exportName = id.parent.name.text;
                    if (
                        checker.resolveName(
                            exportName,
                            id,
                            SymbolFlags.All,
                            /*excludeGlobals*/ true
                        )
                    ) {
                        conflictingNames.set(exportName, true);
                    }
                    nodesToReplace.push(id.parent);
                }
            }
        );

        const exportNameToImportName = new Map<string, string>();
        for (const propertyAccess of nodesToReplace) {
            const exportName = propertyAccess.name.text;
            let importName = exportNameToImportName.get(exportName);
            if (importName === undefined) {
                exportNameToImportName.set(
                    exportName,
                    (importName = conflictingNames.has(exportName)
                        ? getUniqueName(exportName, sourceFile)
                        : exportName)
                );
            }
            changeTracker.replaceNode(
                sourceFile,
                propertyAccess,
                factory.createIdentifier(importName)
            );
        }

        const importSpecifiers: ImportSpecifier[] = [];
        exportNameToImportName.forEach((name, propertyName) => {
            importSpecifiers.push(
                factory.createImportSpecifier(
                    name === propertyName
                        ? undefined
                        : factory.createIdentifier(propertyName),
                    factory.createIdentifier(name)
                )
            );
        });

        const importDecl = toConvert.parent.parent;
        if (usedAsNamespaceOrDefault) {
            // Need to leave the namespace import alone
            changeTracker.insertNodeAfter(
                sourceFile,
                importDecl,
                updateImport(
                    importDecl,
                    /*defaultImportName*/ undefined,
                    importSpecifiers
                )
            );
        } else {
            changeTracker.replaceNode(
                sourceFile,
                importDecl,
                updateImport(
                    importDecl,
                    usedAsNamespaceOrDefault
                        ? factory.createIdentifier(toConvert.name.text)
                        : undefined,
                    importSpecifiers
                )
            );
        }
    }

    function updateImport(
        old: ImportDeclaration,
        defaultImportName: Identifier | undefined,
        elements: readonly ImportSpecifier[] | undefined
    ): ImportDeclaration {
        return factory.createImportDeclaration(
            /*decorators*/ undefined,
            /*modifiers*/ undefined,
            factory.createImportClause(
                /*isTypeOnly*/ false,
                defaultImportName,
                elements && elements.length
                    ? factory.createNamedImports(elements)
                    : undefined
            ),
            old.moduleSpecifier
        );
    }
}
